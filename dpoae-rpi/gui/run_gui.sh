#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

cd "$REPO_DIR"

if [ ! -f "$REPO_DIR/build/dpoae-rpi" ]; then
    echo "[ERROR] Native binary build/dpoae-rpi not found. Build first with:"
    echo "        cmake -B build -S . && cmake --build build -j\$(nproc)"
    exit 1
fi

PYTHON_BIN="python3"
if [ -x "$SCRIPT_DIR/.venv/bin/python" ]; then
    PYTHON_BIN="$SCRIPT_DIR/.venv/bin/python"
fi

HOST="${OAE_GUI_HOST:-0.0.0.0}"
PORT="${OAE_GUI_PORT:-8000}"

echo "=== Starting OAE Buds Wireless Web GUI on http://${HOST}:${PORT} ==="
exec "$PYTHON_BIN" -m uvicorn gui.app.main:app --host "$HOST" --port "$PORT"
