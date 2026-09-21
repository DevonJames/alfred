#!/usr/bin/env bash
# Compile the macOS Apple Speech STT helper into bin/alfred-apple-stt
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/alfred-apple-stt.swift"
OUT_DIR="$ROOT/bin"
OUT="$OUT_DIR/alfred-apple-stt"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[apple-stt] skip native build (not macOS)"
  exit 0
fi

mkdir -p "$OUT_DIR"
echo "[apple-stt] compiling $SRC → $OUT"
swiftc -O -o "$OUT" "$SRC" -framework Speech -framework AVFoundation
chmod +x "$OUT"
echo "[apple-stt] built $(ls -lh "$OUT" | awk '{print $5}') → $OUT"
