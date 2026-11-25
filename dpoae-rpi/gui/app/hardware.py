"""Hardware detection, non-sudo ALSA mixer locking, and TOML config inspection."""

from __future__ import annotations

import re
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:
    import tomllib  # Python 3.11+
except ImportError:
    tomllib = None  # type: ignore[assignment]

try:
    import toml as toml_pkg
except ImportError:
    toml_pkg = None  # type: ignore[assignment]


USB_AUDIO_PATTERN = re.compile(r"USB Audio|USB PnP|UGREEN|C-Media", re.IGNORECASE)
CARD_LINE_PATTERN = re.compile(r"^\s*(\d+)\s+\[([^\]]+)\]\s*:\s*(.+)$")


@dataclass
class AudioDeviceStatus:
    connected: bool
    card_index: int | None = None
    name: str | None = None
    raw_cards: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "connected": self.connected,
            "card_index": self.card_index,
            "name": self.name,
            "raw_cards": self.raw_cards,
        }


def detect_audio_device(cards_path: Path = Path("/proc/asound/cards")) -> AudioDeviceStatus:
    """Detect the UGREEN 80864 / USB audio adapter from /proc/asound/cards."""
    if not cards_path.exists():
        return AudioDeviceStatus(connected=False)

    try:
        content = cards_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return AudioDeviceStatus(connected=False)

    raw_cards: list[str] = []
    for line in content.splitlines():
        match = CARD_LINE_PATTERN.match(line)
        if not match:
            continue
        card_idx = int(match.group(1))
        card_short = match.group(2).strip()
        card_desc = match.group(3).strip()
        summary = f"card {card_idx} [{card_short}]: {card_desc}"
        raw_cards.append(summary)

        if USB_AUDIO_PATTERN.search(line):
            return AudioDeviceStatus(
                connected=True,
                card_index=card_idx,
                name=card_desc or card_short,
                raw_cards=raw_cards,
            )

    return AudioDeviceStatus(connected=False, raw_cards=raw_cards)


def _run_amixer(args: list[str]) -> tuple[int, str, str]:
    """Run amixer without sudo (requires user membership in 'audio' group)."""
    amixer_bin = shutil.which("amixer")
    if not amixer_bin:
        return 127, "", "amixer binary not found in PATH"

    proc = subprocess.run(
        [amixer_bin, *args],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    return proc.returncode, proc.stdout, proc.stderr


def lock_alsa_mixer(card_index: int) -> dict[str, Any]:
    """Apply deterministic ALSA mixer lock without sudo.

    Aligns with scripts/lock_ugreen_80864.sh:
      - Disable Auto Gain Control (AGC)
      - Lock Mic / Capture to 100%
      - Lock Speaker / PCM playback to 100%
      - Mute Mic Playback sidetone
    Does not call `sudo alsactl store` so it works cleanly from non-root services.
    """
    actions: list[str] = []
    warnings: list[str] = []

    rc, scontrols_out, scontrols_err = _run_amixer(["-c", str(card_index), "scontrols"])
    if rc != 0:
        return {
            "ok": False,
            "card_index": card_index,
            "actions": actions,
            "warnings": warnings,
            "error": scontrols_err.strip() or f"amixer failed with code {rc}",
        }

    # 1. Disable AGC
    if "Auto Gain Control" in scontrols_out:
        rc_agc, _, err_agc = _run_amixer(["-c", str(card_index), "set", "Auto Gain Control,0", "off"])
        if rc_agc == 0:
            actions.append("Auto Gain Control disabled")
        else:
            warnings.append(f"Failed to disable AGC: {err_agc.strip()}")
    else:
        rc_cnt, cnt_out, _ = _run_amixer(["-c", str(card_index), "contents"])
        numid_match = None
        if rc_cnt == 0:
            lines = cnt_out.splitlines()
            for idx, line in enumerate(lines):
                if "Auto Gain Control" in line:
                    m = re.search(r"numid=(\d+)", line)
                    if not m and idx > 0:
                        m = re.search(r"numid=(\d+)", lines[idx - 1])
                    if m:
                        numid_match = m.group(1)
                        break
        if numid_match:
            rc_num, _, err_num = _run_amixer(["-c", str(card_index), "cset", f"numid={numid_match}", "off"])
            if rc_num == 0:
                actions.append(f"Auto Gain Control (numid={numid_match}) disabled")
            else:
                warnings.append(f"Failed to disable AGC numid={numid_match}: {err_num.strip()}")
        else:
            actions.append("No AGC mixer control exposed by card")

    # 2. Capture & Mic -> 100%
    if "'Mic'" in scontrols_out:
        rc_m, _, _ = _run_amixer(["-c", str(card_index), "set", "Mic,0", "100%", "unmute"])
        if rc_m == 0:
            actions.append("Mic volume locked to 100% (unmuted)")
        else:
            warnings.append("Failed to set Mic volume to 100%")

    if "'Capture'" in scontrols_out:
        rc_c, _, _ = _run_amixer(["-c", str(card_index), "set", "Capture,0", "100%", "cap"])
        if rc_c == 0:
            actions.append("Capture volume locked to 100%")
        else:
            warnings.append("Failed to set Capture volume to 100%")

    # 3. Playback -> 100%
    playback_set = False
    if "'Speaker'" in scontrols_out:
        rc_s, _, _ = _run_amixer(["-c", str(card_index), "set", "Speaker,0", "100%", "unmute"])
        if rc_s == 0:
            playback_set = True
    if "'PCM'" in scontrols_out:
        rc_p, _, _ = _run_amixer(["-c", str(card_index), "set", "PCM,0", "100%", "unmute"])
        if rc_p == 0:
            playback_set = True
    if playback_set:
        actions.append("Playback volume locked to 100% (unmuted)")

    # 4. Mute Mic Sidetone
    if "'Mic Playback'" in scontrols_out:
        rc_mp, _, _ = _run_amixer(["-c", str(card_index), "set", "Mic Playback,0", "mute"])
        if rc_mp == 0:
            actions.append("Mic sidetone playback muted")

    return {
        "ok": True,
        "card_index": card_index,
        "actions": actions,
        "warnings": warnings,
        "error": None,
    }


_CONFIG_METADATA_CACHE: dict[Path, tuple[int, dict[str, Any]]] = {}


def _load_toml(config_path: Path) -> dict[str, Any]:
    if not config_path.exists():
        return {}
    if tomllib is not None:
        with config_path.open("rb") as f:
            return tomllib.load(f)
    if toml_pkg is not None:
        return toml_pkg.loads(config_path.read_text(encoding="utf-8"))
    return {}


def get_config_metadata(config_path: Path) -> dict[str, Any]:
    """Read available hardware profiles and clinical test thresholds from oae_config.toml.

    Caches parsed metadata keyed by resolved path and mtime_ns so frequent status polls
    do not repeatedly re-parse TOML from disk.
    """
    resolved = config_path.resolve()
    try:
        mtime_ns = resolved.stat().st_mtime_ns
    except OSError:
        _CONFIG_METADATA_CACHE.pop(resolved, None)
        mtime_ns = -1

    if mtime_ns >= 0:
        cached = _CONFIG_METADATA_CACHE.get(resolved)
        if cached is not None and cached[0] == mtime_ns:
            return cached[1]

    data = _load_toml(config_path)
    profiles_raw = data.get("profiles", {})
    profiles: list[dict[str, str]] = []
    for name, cfg in profiles_raw.items():
        if isinstance(cfg, dict):
            profiles.append({
                "name": str(name),
                "description": str(cfg.get("description", name)),
            })

    test_cfg = data.get("test", {})
    fit_cfg = data.get("fit_check", {})
    vol_cfg = data.get("volume_calibration", {})
    art_cfg = data.get("artifact_rejection", {})

    meta = {
        "profiles": profiles,
        "default_profile": "ugreen_80864_rpi5",
        "snr_threshold_db": float(test_cfg.get("snr_threshold_db", 7.0)),
        "constant_tone_seconds": int(test_cfg.get("constant_tone_seconds", 5)),
        "pass_rule_min_frequencies": int(test_cfg.get("pass_rule_min_frequencies", 3)),
        "amp_threshold": int(art_cfg.get("amp_threshold", 500)),
        "art_threshold_db": float(art_cfg.get("art_threshold_db", 4.0)),
        "fit_check_default": bool(fit_cfg.get("enabled", False)),
        "vol_calib_default": bool(vol_cfg.get("enabled", True)),
    }
    if mtime_ns >= 0:
        _CONFIG_METADATA_CACHE[resolved] = (mtime_ns, meta)
    return meta
