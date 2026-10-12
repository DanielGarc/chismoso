#!/usr/bin/env python3
"""Re-apply our changes to the Android project Tauri generates.

`cargo tauri android init` writes src-tauri/gen/android from Tauri's template.
After regenerating it (new Tauri version, identifier change), run:

    python3 dev/android-customize.py

It is idempotent. What it changes, and why:
- MainActivity.kt: edge-to-edge with the page kept clear of system bars,
  notch and keyboard; light bar icons (dark app).
- network_security_config.xml: the web view may load plain HTTP only from
  127.0.0.1 (the app's own media server).
- themes.xml: dark window background (no white flash).
- app/build.gradle.kts: versionName/versionCode read from Cargo.toml.
- buildSrc BuildTask.kt: Gradle runs `cargo tauri` (the Rust CLI).
"""
import glob, os, re, shutil, sys

root = os.path.dirname(os.path.abspath(__file__))
android = os.path.join(root, "..", "src-tauri", "gen", "android")
overlay = os.path.join(root, "android-overlay")
if not os.path.isdir(android):
    sys.exit("No Android project yet: run `cargo tauri android init` first.")

def edit(path, fn):
    with open(path) as f: old = f.read()
    new = fn(old)
    if new != old:
        with open(path, "w") as f: f.write(new)
        print("updated", os.path.relpath(path, android))

app = os.path.join(android, "app")
main = os.path.join(app, "src", "main")

# MainActivity: our version, in whatever package the project uses
act = glob.glob(os.path.join(main, "java", "**", "MainActivity.kt"), recursive=True)[0]
pkg = re.search(r"^package (\S+)", open(act).read(), re.M).group(1)
ours = re.sub(r"^package \S+", f"package {pkg}", open(os.path.join(overlay, "MainActivity.kt")).read(), flags=re.M)
edit(act, lambda s: ours)

os.makedirs(os.path.join(main, "res", "xml"), exist_ok=True)
shutil.copy(os.path.join(overlay, "network_security_config.xml"), os.path.join(main, "res", "xml", "network_security_config.xml"))
edit(os.path.join(main, "AndroidManifest.xml"), lambda s: s if "networkSecurityConfig" in s else s.replace(
    'android:usesCleartextTraffic="${usesCleartextTraffic}">',
    'android:usesCleartextTraffic="${usesCleartextTraffic}"\n        android:networkSecurityConfig="@xml/network_security_config">', 1))

for t in glob.glob(os.path.join(main, "res", "values*", "themes.xml")):
    edit(t, lambda s: s if "windowBackground" in s else re.sub(
        r'(<style name="Theme\.[^"]+"[^>]*>)',
        r'\1\n        <!-- The app is dark; no white flash at start or behind the system bars. -->\n        <item name="android:windowBackground">#0B0F16</item>', s, count=1))

VERSION = '''// Version: Cargo.toml is the only place it's written. Tauri writes
// tauri.properties only when tauri.conf.json has a version, so fall back to
// reading Cargo.toml. versionCode = major*10000 + minor*100 + patch.
val cargoVersion: String = Regex("""(?m)^version\\s*=\\s*"([^"]+)"""")
    .find(rootProject.file("../../Cargo.toml").readText())?.groupValues?.get(1) ?: "0.0.0"
val cargoVersionCode: Int = cargoVersion.split("-")[0].split(".").map { it.toIntOrNull() ?: 0 }
    .let { (it.getOrElse(0) { 0 } * 10000) + (it.getOrElse(1) { 0 } * 100) + it.getOrElse(2) { 0 } }
    .coerceAtLeast(1)

'''
def version(s):
    if "cargoVersion" in s: return s
    s = s.replace("val tauriProperties", VERSION + "val tauriProperties", 1)
    s = s.replace('getProperty("tauri.android.versionCode", "1")', 'getProperty("tauri.android.versionCode", cargoVersionCode.toString())')
    return s.replace('getProperty("tauri.android.versionName", "1.0")', 'getProperty("tauri.android.versionName", cargoVersion)')
edit(os.path.join(app, "build.gradle.kts"), version)

for bt in glob.glob(os.path.join(android, "buildSrc", "**", "BuildTask.kt"), recursive=True):
    edit(bt, lambda s: s.replace('val executable = """node""";', 'val executable = """cargo""";'))
print("done")
