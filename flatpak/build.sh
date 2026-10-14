#!/bin/sh
# Builds the Flatpak from this working tree and installs it for the current
# user. Needs flatpak and flatpak-builder; downloads the GNOME runtime and the
# Rust extension from Flathub the first time.
#   sh flatpak/build.sh            build + install
#   sh flatpak/build.sh bundle     also write chismoso.flatpak (a single-file installer)
set -eu
cd "$(dirname "$0")"
flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
sh ./cargo-sources.sh
flatpak-builder --user --install --install-deps-from=flathub --force-clean \
  --repo=repo build-dir org.caprichosos.chismoso.yml
if [ "${1:-}" = bundle ]; then
  flatpak build-bundle repo chismoso.flatpak org.caprichosos.chismoso
  echo "wrote flatpak/chismoso.flatpak"
fi
