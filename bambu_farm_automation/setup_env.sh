#!/bin/bash

# setup_env.sh
# Run this on your Raspberry Pi 5 to set up the environment.

set -e  # Exit on error

echo "Updating system..."
sudo apt update && sudo apt upgrade -y

echo "Installing System Dependencies..."
sudo apt install -y python3-pip python3-venv openscad git wget libfuse2

echo "Setting up Python Virtual Environment..."
if [ ! -d "venv" ]; then
    python3 -m venv venv
fi
source venv/bin/activate

echo "Installing Python Libraries..."
pip install -r requirements.txt

echo "Downloading OrcaSlicer (ARM64)..."
# Note: This link might change. Check https://github.com/SoftFever/OrcaSlicer/releases/latest for the latest "Linux_arm64.AppImage"
ORCA_URL="https://github.com/SoftFever/OrcaSlicer/releases/download/v2.2.0/OrcaSlicer_Linux_V2.2.0_arm64.AppImage"
ORCA_FILE="OrcaSlicer.AppImage"

if [ ! -f "$ORCA_FILE" ]; then
    wget -O "$ORCA_FILE" "$ORCA_URL"
    chmod +x "$ORCA_FILE"
    echo "OrcaSlicer downloaded."
else
    echo "OrcaSlicer already exists."
fi

echo "Creating directories..."
mkdir -p generated_stls
mkdir -p sliced_gcode
mkdir -p profiles

echo "Setup Complete! Activate venv with 'source venv/bin/activate'"
