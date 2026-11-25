"""Tests for hardware detection, non-sudo ALSA mixer locking, and TOML config metadata."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from gui.app.hardware import detect_audio_device, get_config_metadata, lock_alsa_mixer


REPO_ROOT = Path(__file__).resolve().parents[2]


def test_detect_audio_device_connected(tmp_path: Path) -> None:
    cards = tmp_path / "cards"
    cards.write_text(
        " 0 [vc4hdmi0       ]: vc4-hdmi - vc4-hdmi-0\n"
        "                      vc4-hdmi-0\n"
        " 2 [Device         ]: USB-Audio - UGREEN USB Audio Device\n"
        "                      UGREEN USB Audio Device at usb-0000:01:00.0-1, full speed\n",
        encoding="utf-8",
    )

    status = detect_audio_device(cards)
    assert status.connected is True
    assert status.card_index == 2
    assert "UGREEN" in (status.name or "")
    assert len(status.raw_cards) == 2


def test_detect_audio_device_disconnected(tmp_path: Path) -> None:
    cards = tmp_path / "cards"
    cards.write_text(
        " 0 [vc4hdmi0       ]: vc4-hdmi - vc4-hdmi-0\n"
        " 1 [vc4hdmi1       ]: vc4-hdmi - vc4-hdmi-1\n",
        encoding="utf-8",
    )

    status = detect_audio_device(cards)
    assert status.connected is False
    assert status.card_index is None
    assert status.name is None
    assert len(status.raw_cards) == 2


def test_detect_audio_device_missing_file(tmp_path: Path) -> None:
    status = detect_audio_device(tmp_path / "nonexistent_cards")
    assert status.connected is False
    assert status.card_index is None


def test_lock_alsa_mixer_runs_amixer_without_sudo() -> None:
    calls: list[list[str]] = []

    def fake_run_amixer(args: list[str]) -> tuple[int, str, str]:
        calls.append(args)
        if args[-1] == "scontrols":
            return (
                0,
                "Simple mixer control 'Speaker',0\n"
                "Simple mixer control 'PCM',0\n"
                "Simple mixer control 'Mic',0\n"
                "Simple mixer control 'Capture',0\n"
                "Simple mixer control 'Mic Playback',0\n"
                "Simple mixer control 'Auto Gain Control',0\n",
                "",
            )
        return 0, "", ""

    with patch("gui.app.hardware._run_amixer", side_effect=fake_run_amixer):
        res = lock_alsa_mixer(2)

    assert res["ok"] is True
    assert res["card_index"] == 2
    assert res["warnings"] == []
    assert ["-c", "2", "set", "Auto Gain Control,0", "off"] in calls
    assert ["-c", "2", "set", "Mic,0", "100%", "unmute"] in calls
    assert ["-c", "2", "set", "Capture,0", "100%", "cap"] in calls
    assert ["-c", "2", "set", "Speaker,0", "100%", "unmute"] in calls
    assert ["-c", "2", "set", "Mic Playback,0", "mute"] in calls
    assert any("100%" in a for a in res["actions"])


def test_get_config_metadata_loads_profiles_and_thresholds() -> None:
    meta = get_config_metadata(REPO_ROOT / "config" / "oae_config.toml")
    profile_names = [p["name"] for p in meta["profiles"]]
    assert "ugreen_80864_rpi5" in profile_names
    assert meta["default_profile"] == "ugreen_80864_rpi5"
    assert meta["snr_threshold_db"] == 7.0
    assert meta["pass_rule_min_frequencies"] == 3
