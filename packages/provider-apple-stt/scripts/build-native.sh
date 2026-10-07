#!/usr/bin/env bash
# Compile the macOS Apple Speech STT helper into bin/alfred-apple-stt
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/alfred-apple-stt.swift"
PLIST="$ROOT/native/Info.plist"
OUT_DIR="$ROOT/bin"
OUT="$OUT_DIR/alfred-apple-stt"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[apple-stt] skip native build (not macOS)"
  exit 0
fi

APP="$OUT_DIR/AlfredAppleSTT.app"
MACOS="$APP/Contents/MacOS"
rm -rf "$APP"
mkdir -p "$MACOS"
cp "$PLIST" "$APP/Contents/Info.plist"
echo "[apple-stt] compiling $SRC → $MACOS/alfred-apple-stt"
swiftc -O -o "$MACOS/alfred-apple-stt" "$SRC" -framework Speech -framework AVFoundation \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$PLIST"
codesign --force --sign - "$APP"
cat > "$OUT" <<'EOF'
#!/bin/bash
exec "$(cd "$(dirname "$0")" && pwd)/AlfredAppleSTT.app/Contents/MacOS/alfred-apple-stt" "$@"
EOF
chmod +x "$OUT" "$MACOS/alfred-apple-stt"
echo "[apple-stt] built $(ls -lh "$MACOS/alfred-apple-stt" | awk '{print $5}') → $MACOS/alfred-apple-stt"
