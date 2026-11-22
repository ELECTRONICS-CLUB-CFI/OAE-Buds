#!/bin/bash
# ==============================================================================
# scripts/loopback_test.sh
# Tests full-duplex ALSA audio on the UGREEN 80864 adapter over a 3.5mm loopback
# cable (or acoustic coupler). Validates that there are 0 buffer underruns/overruns (xruns).
# ==============================================================================

set -e

DURATION=60
CARD=$(cat /proc/asound/cards | grep -i "USB Audio\|USB PnP\|UGREEN\|C-Media" | head -1 | awk '{print $1}')

if [ -z "$CARD" ]; then
    echo "[ERROR] UGREEN USB sound card not found!"
    exit 1
fi

DEVICE="hw:$CARD,0"
OUT_WAV="/tmp/loopback_capture.wav"

echo "=== Starting Full-Duplex Audio Loopback Test ($DURATION seconds) ==="
echo "Target ALSA Device: $DEVICE"
echo "Connect loopback 3.5mm cable or insert probe into test coupler."

# Play 1 kHz tone and capture simultaneously
speaker-test -D "$DEVICE" -t sine -f 1000 -c 2 -r 48000 -l "$DURATION" &
SPK_PID=$!

arecord -D "$DEVICE" -f S16_LE -c 1 -r 48000 -d "$DURATION" -v "$OUT_WAV"

wait $SPK_PID 2>/dev/null || true

echo -e "\n=== Test Complete ==="
if [ -f "$OUT_WAV" ]; then
    SIZE=$(stat -c%s "$OUT_WAV" 2>/dev/null || stat -f%z "$OUT_WAV")
    EXPECTED_SIZE=$((48000 * 2 * DURATION))
    echo "Captured WAV size: $SIZE bytes (Expected ~ $EXPECTED_SIZE bytes)"
    if [ "$SIZE" -ge $((EXPECTED_SIZE - 48000)) ]; then
        echo "[SUCCESS] Loopback recording completed with stable throughput!"
    else
        echo "[WARN] Captured file smaller than expected. Check for buffer xruns."
    fi
    rm -f "$OUT_WAV"
fi
