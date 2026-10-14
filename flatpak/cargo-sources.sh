#!/bin/sh
# Lists every crate in Cargo.lock as a Flatpak source (cargo-sources.json), so
# the build can run offline. Uses flatpak-cargo-generator from flatpak-builder-tools.
set -eu
cd "$(dirname "$0")"
GEN=.cache/flatpak-cargo-generator.py
mkdir -p .cache
[ -f "$GEN" ] || curl -sSfL -o "$GEN" \
  https://raw.githubusercontent.com/flatpak/flatpak-builder-tools/master/cargo/flatpak-cargo-generator.py
python3 -c "import aiohttp, tomlkit" 2>/dev/null || pip install --user --quiet aiohttp tomlkit || pip install --quiet --break-system-packages aiohttp tomlkit
python3 "$GEN" ../src-tauri/Cargo.lock -o cargo-sources.json
