#!/usr/bin/env bash
# Build on this Mac, rsync a tiny payload to ~/alfredbot, restart the host.
# Never writes to /opt/alfred-home or ~/robot-client.
# Usage: ./deploy/push.sh alfred@100.115.52.14
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-alfred@100.115.52.14}"
REMOTE_DIR="${ALFREDBOT_REMOTE_DIR:-/home/alfred/alfredbot}"

cd "$ROOT"
pnpm run build

ssh "$TARGET" "mkdir -p $REMOTE_DIR/dist-ui $REMOTE_DIR/deploy"

rsync -az dist/host.mjs "$TARGET:$REMOTE_DIR/host.mjs"
rsync -az dist-ui/ "$TARGET:$REMOTE_DIR/dist-ui/"
rsync -az deploy/start-kiosk.sh "$TARGET:$REMOTE_DIR/start-kiosk.sh"
rsync -az deploy/ "$TARGET:$REMOTE_DIR/deploy/"

ssh "$TARGET" "chmod +x $REMOTE_DIR/start-kiosk.sh $REMOTE_DIR/deploy/start-kiosk.sh $REMOTE_DIR/deploy/bootstrap-on-pi.sh $REMOTE_DIR/deploy/head-stick.py $REMOTE_DIR/deploy/wheels-stick.py $REMOTE_DIR/deploy/arm-wave.py 2>/dev/null || true; if command -v systemctl >/dev/null; then sudo -n systemctl restart alfredbot.service || systemctl --user restart alfredbot.service || true; fi; curl -sS --max-time 3 http://127.0.0.1:3200/api/status || true"

echo "Pushed to $TARGET:$REMOTE_DIR (old robot-client was not touched)"
