#!/bin/sh
# Makes the files for Flathub's repository (flathub/org.caprichosos.chismoso):
# the manifest pointed at a release tag on GitHub, and that tag's crate list.
#   sh flatpak/make-flathub.sh v0.7.1      -> flatpak/flathub/
# The tag must already be pushed, and must contain this flatpak/ folder (the
# desktop file, metainfo and icon are installed from the release itself).
set -eu
TAG=${1:?usage: make-flathub.sh vX.Y.Z}
cd "$(dirname "$0")"
COMMIT=$(git ls-remote https://github.com/DanielGarc/chismoso.git "refs/tags/$TAG^{}" | cut -f1)
[ -n "$COMMIT" ] || COMMIT=$(git ls-remote https://github.com/DanielGarc/chismoso.git "refs/tags/$TAG" | cut -f1)
[ -n "$COMMIT" ] || { echo "tag $TAG isn't on GitHub" >&2; exit 1; }
mkdir -p flathub .cache
git -C .. show "$TAG:src-tauri/Cargo.lock" > .cache/Cargo.lock
GEN=.cache/flatpak-cargo-generator.py
[ -f "$GEN" ] || curl -sSfL -o "$GEN" https://raw.githubusercontent.com/flatpak/flatpak-builder-tools/master/cargo/flatpak-cargo-generator.py
python3 "$GEN" .cache/Cargo.lock -o flathub/cargo-sources.json
python3 - "$TAG" "$COMMIT" <<'PY'
import re, sys
tag, commit = sys.argv[1], sys.argv[2]
m = open("org.caprichosos.chismoso.yml").read()
m = re.sub(r"^#.*\n", "", m, flags=re.M)  # the comments are about the local build
src = re.search(r"      - type: dir\n(?:        .*\n)+", m).group(0)
m = m.replace(src, f"""      - type: git
        url: https://github.com/DanielGarc/chismoso.git
        tag: {tag}
        commit: {commit}
        x-checker-data:
          type: git
          tag-pattern: ^v([\\d.]+)$
""")
open("flathub/org.caprichosos.chismoso.yml", "w").write(m)
PY
cat > flathub/flathub.json <<'J'
{
  "only-arches": ["x86_64", "aarch64"]
}
J
echo "flatpak/flathub/: org.caprichosos.chismoso.yml, cargo-sources.json, flathub.json for $TAG ($COMMIT)"
