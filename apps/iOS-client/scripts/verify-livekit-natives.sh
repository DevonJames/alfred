#!/usr/bin/env bash
# Verify LiveKit / WebRTC natives are present after prebuild + build.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCK="$ROOT/ios/Podfile.lock"

echo "== Podfile.lock =="
for pod in livekit-react-native livekit-react-native-webrtc LiveKitExpoPlugin WebRTC-SDK; do
  if rg -q "^  - ${pod} " "$LOCK" 2>/dev/null || rg -q "^  - \"?${pod}" "$LOCK"; then
    echo "  ok  $pod"
  else
    echo "  MISSING  $pod" >&2
    exit 1
  fi
done

APP="${ALFRED_APP_PATH:-}"
if [[ -z "$APP" ]]; then
  APP="$(find "$HOME/Library/Developer/Xcode/DerivedData" -name 'Alfred.app' -path '*iphonesimulator*' 2>/dev/null | head -1 || true)"
fi

echo "== App bundle =="
if [[ -n "$APP" && -d "$APP" ]]; then
  echo "  path  $APP"
  if [[ -d "$APP/Frameworks/WebRTC.framework" ]]; then
    echo "  ok  WebRTC.framework"
  else
    echo "  MISSING  WebRTC.framework (build Simulator Debug first)" >&2
    exit 1
  fi
  plutil -extract CFBundleIdentifier raw "$APP/Info.plist" 2>/dev/null | grep -q 'net.alfrd.alfred' \
    && echo "  ok  bundle id net.alfrd.alfred" \
    || echo "  warn  unexpected bundle id"
else
  echo "  skip  no Alfred.app in DerivedData (run Xcode Simulator build)"
fi

echo "LiveKit native checks passed."
echo "E2E Speak still needs a physical device + pnpm desktop + pnpm voice."
