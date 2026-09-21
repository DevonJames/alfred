#!/usr/bin/env bash
# Run ON the Pi (or via ssh). Idempotent. Does not pair.
# Adds AlfredBot next to the existing Electron app and switches boot to the new
# kiosk. Does not uninstall, overwrite, or delete the old robot-client.
set -euo pipefail

REMOTE_DIR="${ALFREDBOT_REMOTE_DIR:-/home/alfred/alfredbot}"
USER_NAME="${ALFREDBOT_USER:-alfred}"
SUDO=${SUDO:-sudo}
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=keep-old-app.sh
. "${HERE}/keep-old-app.sh"

echo "=== inventory ==="
hostname
uname -a
echo "user=$(whoami) home=$HOME"
command -v node && node -v || echo "node: missing"
command -v npm && npm -v || true
command -v pnpm && pnpm -v || true
command -v chromium || command -v chromium-browser || echo "chromium: missing"
command -v nmcli || echo "nmcli: missing"
command -v rpicam-hello || true
echo "--- systemd units matching alfred/robot ---"
systemctl list-unit-files --type=service --no-pager | grep -Ei 'alfred|robot|kiosk|electron' || true
echo "--- running ---"
systemctl list-units --type=service --state=running --no-pager | grep -Ei 'alfred|robot|kiosk|electron' || true
echo "--- autostart ---"
ls -la /home/${USER_NAME}/.config/autostart 2>/dev/null || true
ls -la /etc/xdg/autostart 2>/dev/null | grep -Ei 'alfred|robot|kiosk' || true

disable_old_kiosk_only
disable_old_autostart_desktops

echo "=== packages ==="
if ! command -v node >/dev/null; then
  echo "Node is required. Install Node 22 then re-run." >&2
  exit 1
fi
$SUDO apt-get update
$SUDO apt-get install -y chromium-browser network-manager rpicam-apps \
  || $SUDO apt-get install -y chromium network-manager || true

echo "=== dirs ==="
$SUDO mkdir -p /var/lib/alfredbot "$REMOTE_DIR"
$SUDO chown -R "${USER_NAME}:${USER_NAME}" /var/lib/alfredbot "$REMOTE_DIR"
if [ ! -f /etc/alfredbot.env ]; then
  $SUDO tee /etc/alfredbot.env >/dev/null <<'ENV'
ALFREDBOT_PORT=3200
ALFREDBOT_CLOUD_URL=https://api.alfrd.net
ALFREDBOT_DEVICE_NAME=AlfredBot
ALFREDBOT_STORE_PATH=/var/lib/alfredbot/identity.json
ALFREDBOT_CAMERA_FRAME_SINK=/tmp/alfred-camera-latest.jpg
ENV
fi

NODE_BIN="$(command -v node)"
$SUDO tee /etc/systemd/system/alfredbot.service >/dev/null <<UNIT
[Unit]
Description=AlfredBot host (pairing + kiosk API)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${USER_NAME}
WorkingDirectory=${REMOTE_DIR}
EnvironmentFile=-/etc/alfredbot.env
ExecStart=${NODE_BIN} ${REMOTE_DIR}/host.mjs
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

KIOSK="${REMOTE_DIR}/start-kiosk.sh"
if [ ! -x "$KIOSK" ] && [ -x "${REMOTE_DIR}/deploy/start-kiosk.sh" ]; then
  KIOSK="${REMOTE_DIR}/deploy/start-kiosk.sh"
fi
$SUDO tee /etc/systemd/system/alfredbot-kiosk.service >/dev/null <<UNIT
[Unit]
Description=AlfredBot Chromium kiosk
After=alfredbot.service graphical.target
Wants=alfredbot.service

[Service]
Type=simple
User=${USER_NAME}
Environment=XDG_RUNTIME_DIR=/run/user/$(id -u ${USER_NAME})
Environment=DISPLAY=:0
ExecStart=${KIOSK}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=graphical.target
UNIT

$SUDO systemctl daemon-reload
$SUDO systemctl enable alfredbot.service alfredbot-kiosk.service
if [ -f "${REMOTE_DIR}/host.mjs" ]; then
  $SUDO systemctl restart alfredbot.service
  $SUDO systemctl restart alfredbot-kiosk.service || $SUDO systemctl start alfredbot-kiosk.service || true
  sleep 1
  curl -sS --max-time 3 http://127.0.0.1:3200/api/status || echo "host not answering yet"
else
  echo "host.mjs not on disk yet — push the bundle, then: sudo systemctl restart alfredbot alfredbot-kiosk"
fi

echo "=== bootstrap done ==="
