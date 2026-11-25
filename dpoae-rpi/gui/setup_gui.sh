#!/bin/bash
# ==============================================================================
# gui/setup_gui.sh
# One-command setup for the OAE Buds Wireless Web GUI on Raspberry Pi 5 / Linux:
#   1. Installs Python/ALSA/build system dependencies (unless --skip-apt)
#   2. Builds native C++ binary (build/dpoae-rpi) if not already built
#   3. Creates gui/.venv and installs gui/requirements.txt
#   4. Verifies offline Chart.js vendor bundle & results/ directory
#   5. Configures Linux 'audio' group permissions for non-sudo amixer locking
#   6. Optionally installs and enables an oae-gui systemd service (--with-systemd)
# ==============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
TARGET_USER="${SUDO_USER:-$USER}"

SKIP_APT=false
WITH_SYSTEMD=false
REBUILD=false

for arg in "$@"; do
    case "$arg" in
        --skip-apt)
            SKIP_APT=true
            ;;
        --with-systemd)
            WITH_SYSTEMD=true
            ;;
        --rebuild)
            REBUILD=true
            ;;
        --help|-h)
            echo "Usage: bash gui/setup_gui.sh [options]"
            echo ""
            echo "Options:"
            echo "  --skip-apt       Skip apt system package installation"
            echo "  --rebuild        Force clean CMake build of build/dpoae-rpi"
            echo "  --with-systemd   Install and enable oae-gui.service for auto-start on boot"
            echo "  --help, -h       Show this help message"
            exit 0
            ;;
        *)
            echo "[ERROR] Unknown option: $arg"
            exit 1
            ;;
    esac
done

echo "=== OAE Buds Web GUI Setup (Repo: $REPO_DIR) ==="

# 1. System packages
if [ "$SKIP_APT" = false ] && command -v apt-get >/dev/null 2>&1; then
    echo "[1/6] Installing system dependencies..."
    if [ -f "$REPO_DIR/scripts/setup_rpi.sh" ]; then
        bash "$REPO_DIR/scripts/setup_rpi.sh"
    fi
    sudo apt-get install -y python3-venv python3-pip alsa-utils curl
else
    echo "[1/6] Skipping apt package installation."
fi

# 2. Native C++ engine build
if [ "$REBUILD" = true ] || [ ! -x "$REPO_DIR/build/dpoae-rpi" ]; then
    echo "[2/6] Building native C++ engine (build/dpoae-rpi)..."
    cmake -B "$REPO_DIR/build" -S "$REPO_DIR"
    cmake --build "$REPO_DIR/build" -j"$(nproc)"
else
    echo "[2/6] Native binary build/dpoae-rpi already exists (use --rebuild to force)."
fi

# 3. Python virtualenv & dependencies
echo "[3/6] Setting up Python virtual environment (gui/.venv)..."
if [ ! -x "$SCRIPT_DIR/.venv/bin/python" ]; then
    python3 -m venv "$SCRIPT_DIR/.venv"
fi
if "$SCRIPT_DIR/.venv/bin/python" -c "import fastapi, uvicorn, pydantic, toml, httpx, pytest" 2>/dev/null; then
    echo "[OK] Python GUI dependencies already installed in gui/.venv."
else
    "$SCRIPT_DIR/.venv/bin/pip" install -r "$SCRIPT_DIR/requirements.txt"
fi

# 4. Offline Chart.js bundle & runtime directories
echo "[4/6] Verifying offline frontend assets & directories..."
mkdir -p "$SCRIPT_DIR/static/vendor" "$REPO_DIR/results"
chmod +x "$SCRIPT_DIR/run_gui.sh"

CHART_JS="$SCRIPT_DIR/static/vendor/chart.umd.min.js"
if [ ! -s "$CHART_JS" ]; then
    echo "Downloading Chart.js v4.4.7 for 100% offline hotspot operation..."
    curl -fsSL "https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js" -o "$CHART_JS"
fi

# 5. Audio group & ALSA permissions
echo "[5/6] Checking Linux 'audio' group permissions for $TARGET_USER..."
RELOGIN_NEEDED=false
if id -nG "$TARGET_USER" 2>/dev/null | grep -qw "audio"; then
    echo "[OK] User '$TARGET_USER' is already in the 'audio' group."
else
    if command -v usermod >/dev/null 2>&1; then
        echo "Adding '$TARGET_USER' to 'audio' group (needed for non-sudo amixer lock)..."
        sudo usermod -aG audio "$TARGET_USER"
        RELOGIN_NEEDED=true
    else
        echo "[WARN] Could not add '$TARGET_USER' to 'audio' group automatically."
    fi
fi

if [ -r /proc/asound/cards ] && grep -qiE "USB Audio|USB PnP|UGREEN|C-Media" /proc/asound/cards; then
    echo "UGREEN/USB audio adapter detected; applying initial mixer lock..."
    bash "$REPO_DIR/scripts/lock_ugreen_80864.sh" || true
fi

# 6. Optional systemd service
if [ "$WITH_SYSTEMD" = true ]; then
    echo "[6/6] Installing systemd service (oae-gui.service)..."
    SERVICE_FILE="/etc/systemd/system/oae-gui.service"
    sudo tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=OAE Buds Wireless DPOAE Screening Web GUI
After=network.target sound.target

[Service]
Type=simple
User=$TARGET_USER
SupplementaryGroups=audio
WorkingDirectory=$REPO_DIR
Environment=OAE_GUI_HOST=0.0.0.0
Environment=OAE_GUI_PORT=8000
ExecStart=$SCRIPT_DIR/run_gui.sh
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    sudo systemctl enable --now oae-gui.service
    echo "[OK] oae-gui.service installed and started."
else
    echo "[6/6] Skipping systemd installation (pass --with-systemd to enable auto-start on boot)."
fi

# Sanity verification
"$SCRIPT_DIR/.venv/bin/python" -c "import fastapi, uvicorn, pydantic; print('[OK] Python GUI packages ready.')"
"$REPO_DIR/build/dpoae-rpi" --help >/dev/null && echo "[OK] Native dpoae-rpi CLI ready."

echo ""
echo "=== Setup Complete ==="
if [ "$RELOGIN_NEEDED" = true ]; then
    echo "[IMPORTANT] Log out and back in (or reboot) so 'audio' group permissions take effect."
fi
echo "Start the GUI manually with:"
echo "  ./gui/run_gui.sh"
echo "Then open http://$(hostname).local:8000 (or http://<pi-ip>:8000) in your browser."
