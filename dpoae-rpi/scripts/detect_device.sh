#!/bin/bash
# ==============================================================================
# scripts/detect_device.sh
# Detects connected USB audio adapters and prints ALSA playback/capture details
# ==============================================================================

echo "=== Detected Sound Cards (/proc/asound/cards) ==="
cat /proc/asound/cards

echo -e "\n=== ALSA Playback Devices (aplay -l) ==="
aplay -l 2>/dev/null || echo "aplay not installed or no devices found"

echo -e "\n=== ALSA Capture Devices (arecord -l) ==="
arecord -l 2>/dev/null || echo "arecord not installed or no devices found"

UGREEN_CARD=$(cat /proc/asound/cards 2>/dev/null | grep -i "USB Audio\|USB PnP\|UGREEN\|C-Media" | head -1 | awk '{print $1}')
if [ -n "$UGREEN_CARD" ]; then
    echo -e "\n[INFO] Recommended ALSA device string for UGREEN: hw:$UGREEN_CARD,0"
else
    echo -e "\n[WARN] UGREEN adapter not found in sound card list."
fi
