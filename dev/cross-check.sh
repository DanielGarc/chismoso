#!/usr/bin/env sh
# Lint the app for every platform reachable from Linux, without their SDKs,
# with the same settings CI uses (clippy, warnings are errors):
#   sh dev/cross-check.sh            # linux + windows + android
#   sh dev/cross-check.sh android
#
# Checking doesn't link, so the only native code that must compile is
# ring's small C part; clang plus the stub headers in dev/cross-check/include
# is enough for that. macOS and iOS need Apple's SDK (Objective-C), so those
# are checked in CI on a Mac runner (.github/workflows/check.yml).
#
# Needs: clang, llvm-ar (apt install clang llvm), and the Rust targets:
#   rustup target add x86_64-pc-windows-msvc aarch64-linux-android
set -e
here=$(cd "$(dirname "$0")" && pwd)
inc="$here/cross-check/include"
cd "$here/../src-tauri"
targets=${*:-"linux windows android"}

for t in $targets; do
  case $t in
    linux)
      echo "== Linux (native) =="
      cargo clippy --all-targets -- -D warnings
      ;;
    windows)
      echo "== Windows (x86_64-pc-windows-msvc) =="
      CC_x86_64_pc_windows_msvc=clang AR_x86_64_pc_windows_msvc=llvm-ar \
      CFLAGS_x86_64_pc_windows_msvc="--target=x86_64-pc-windows-msvc -isystem $inc" \
        cargo clippy --all-targets --target x86_64-pc-windows-msvc -- -D warnings
      ;;
    android)
      echo "== Android (aarch64-linux-android) =="
      kt=$(mktemp -d)
      CC_aarch64_linux_android=clang AR_aarch64_linux_android=llvm-ar \
      CFLAGS_aarch64_linux_android="--target=aarch64-linux-android24 -ffreestanding -isystem $inc" \
      WRY_ANDROID_PACKAGE=org.caprichosos.chismoso WRY_ANDROID_LIBRARY=chismoso_lib \
      WRY_ANDROID_KOTLIN_FILES_OUT_DIR="$kt" \
        cargo clippy --lib --target aarch64-linux-android -- -D warnings
      rm -rf "$kt"
      ;;
    *) echo "unknown target '$t' (linux, windows, android)"; exit 2 ;;
  esac
done
