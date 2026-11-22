#!/bin/bash
# ==============================================================================
# scripts/lock_ugreen_80864.sh
# Configures ALSA mixer settings for the UGREEN 80864 USB sound card:
# 1. Disables hardware Automatic Gain Control (AGC)
# 2. Sets Mic/Capture gain to fixed 100% (unattenuated)
# 3. Sets Playback/Speaker volume to fixed 100%
# 4. Disables sidetone/mic playback monitoring (to prevent feedback)
# 5. Stores settings with alsactl so they survive reboot
# ==============================================================================

set -e

# Detect UGREEN sound card number
CARD=$(cat /proc/asound/cards | grep -i "USB Audio\|USB PnP\|UGREEN\|C-Media" | head -1 | awk '{print $1}')

if [ -z "$CARD" ]; then
    echo "[ERROR] UGREEN 80864 USB Audio Adapter not detected in /proc/asound/cards!"
    echo "Available audio cards:"
    cat /proc/asound/cards
    exit 1
fi

echo "[INFO] Found UGREEN sound card at ALSA index: card $CARD"

# 1. Disable Auto Gain Control (AGC) if exposed
if amixer -c "$CARD" scontrols | grep -q "Auto Gain Control"; then
    amixer -c "$CARD" set 'Auto Gain Control',0 off
    echo "[OK] Hardware Auto Gain Control (AGC) disabled."
else
    # Try cset by name or numid
    echo "[WARN] 'Auto Gain Control' simple control not listed. Checking control contents..."
    NUMID=$(amixer -c "$CARD" contents | grep -B 1 "Auto Gain Control" | grep "numid=" | cut -d'=' -f2 | cut -d',' -f1 || true)
    if [ -n "$NUMID" ]; then
        amixer -c "$CARD" cset numid="$NUMID" off
        echo "[OK] Auto Gain Control (numid=$NUMID) disabled."
    else
        echo "[INFO] No AGC mixer control found on this card firmware."
    fi
fi

# 2. Set Capture volume to fixed 100%
if amixer -c "$CARD" scontrols | grep -q "'Mic'"; then
    amixer -c "$CARD" set 'Mic',0 100% unmute 2>/dev/null || true
    echo "[OK] Mic volume set to 100% (unmuted)."
fi

if amixer -c "$CARD" scontrols | grep -q "'Capture'"; then
    amixer -c "$CARD" set 'Capture',0 100% cap 2>/dev/null || true
    echo "[OK] Capture volume set to 100%."
fi

# 3. Set Playback volume to fixed 100%
if amixer -c "$CARD" scontrols | grep -q "'Speaker'"; then
    amixer -c "$CARD" set 'Speaker',0 100% unmute 2>/dev/null || true
fi

if amixer -c "$CARD" scontrols | grep -q "'PCM'"; then
    amixer -c "$CARD" set 'PCM',0 100% unmute 2>/dev/null || true
fi
echo "[OK] Playback volume set to 100% (unmuted)."

# 4. Disable Mic Sidetone (Mic Playback to Speaker to prevent loopback screech)
if amixer -c "$CARD" scontrols | grep -q "'Mic Playback'"; then
    amixer -c "$CARD" set 'Mic Playback',0 mute 2>/dev/null || true
    echo "[OK] Mic sidetone playback muted."
fi

# 5. Persist state
sudo alsactl store "$CARD" 2>/dev/null || true
echo "[SUCCESS] UGREEN 80864 card $CARD mixer settings locked and stored."
