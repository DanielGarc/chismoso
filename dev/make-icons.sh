#!/bin/sh
# Regenerates every app and website icon from design/icon.svg.
# Needs: python3 + playwright (Chromium), and the Tauri CLI (`tauri icon`).
set -e
cd "$(dirname "$0")/.."
python3 - <<'PY'
from playwright.sync_api import sync_playwright
svg = open("design/icon.svg").read().replace("<svg ", '<svg width="1024" height="1024" ', 1)
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1024, "height": 1024})
    pg.set_content(f'<body style="margin:0">{svg}</body>')
    pg.screenshot(path="design/icon-1024.png", omit_background=True)
    b.close()
PY
(cd src-tauri && tauri icon ../design/icon-1024.png)
# in-app logo and website
cp design/icon.svg ui/logo.svg
cp design/icon.svg site/img/logo.svg
cp design/icon.svg site/img/favicon.svg
python3 - <<'PY'
from PIL import Image
im = Image.open("design/icon-1024.png")
im.resize((32, 32), Image.LANCZOS).save("site/img/favicon-32.png")
bg = Image.new("RGBA", im.size, (11, 15, 22, 255)); bg.alpha_composite(im)   # iOS wants it opaque
bg.convert("RGB").resize((180, 180), Image.LANCZOS).save("site/img/apple-touch-icon.png")
PY
# Android adaptive icon: the launcher draws its own shape, so the foreground is
# just the window art inside the safe zone (middle 66%) on the app's dark
# background colour.
res=src-tauri/gen/android/app/src/main/res
if [ -d "$res" ]; then
python3 - "$res" <<'PY'
import sys, re
from playwright.sync_api import sync_playwright
res = sys.argv[1]
svg = open("design/icon.svg").read()
svg = re.sub(r'<rect width="1024" height="1024"[^>]*/>', "", svg, count=1)       # drop the tile
svg = svg.replace("<svg ", '<svg width="100%" height="100%" ', 1)
sizes = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}
with sync_playwright() as p:
    b = p.chromium.launch()
    for d, px in sizes.items():
        pg = b.new_page(viewport={"width": px, "height": px})
        inner = round(px * 0.70)
        pad = (px - inner) // 2
        pg.set_content(f'<body style="margin:0"><div style="position:absolute;left:{pad}px;top:{pad}px;width:{inner}px;height:{inner}px">{svg}</div></body>')
        pg.screenshot(path=f"{res}/mipmap-{d}/ic_launcher_foreground.png", omit_background=True)
        pg.close()
    b.close()
PY
cat > "$res/values/ic_launcher_background.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<resources>
  <color name="ic_launcher_background">#0E1424</color>
</resources>
XML
fi
echo "Icons regenerated."
