#!/bin/bash
# ==============================================================================
# scripts/setup_rpi.sh
# One-command environment setup for Raspberry Pi OS Trixie Lite
# Installs compiler, CMake, ALSA headers, FFTW3, and Python utilities
# ==============================================================================

set -e

echo "=== Setting up OAE Buds C++ Environment on Raspberry Pi OS ==="

sudo apt update
sudo apt install -y \
    build-essential \
    g++ \
    cmake \
    git \
    libasound2-dev \
    libfftw3-dev \
    alsa-utils \
    python3 \
    python3-numpy \
    python3-scipy

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

if [ ! -f "$REPO_DIR/third_party/miniaudio.h" ]; then
    echo "Downloading single-header miniaudio.h into third_party/..."
    curl -sSL https://raw.githubusercontent.com/mackron/miniaudio/master/miniaudio.h -o "$REPO_DIR/third_party/miniaudio.h" || \
    wget -qO "$REPO_DIR/third_party/miniaudio.h" https://raw.githubusercontent.com/mackron/miniaudio/master/miniaudio.h || true
fi

echo -e "\n=== Verifying Toolchain Versions ==="
g++ --version | head -1
cmake --version | head -1
pkg-config --modversion fftw3 || true

echo -e "\n[SUCCESS] Raspberry Pi dependencies installed successfully."
echo "You can now run: cmake -B build && cmake --build build"
