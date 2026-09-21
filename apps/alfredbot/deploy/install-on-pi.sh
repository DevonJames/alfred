#!/usr/bin/env bash
# Prefer building on the Mac and using ./deploy/push.sh + bootstrap-on-pi.sh.
# If this script runs on a tree already on the Pi, it still must not remove
# /opt/alfred-home or ~/robot-client — only switch kiosk autostart.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
USER_NAME="${ALFREDBOT_USER:-alfred}"
SUDO=${SUDO:-sudo}
# shellcheck source=keep-old-app.sh
. "${ROOT}/deploy/keep-old-app.sh"

echo "Installing AlfredBot from ${ROOT} (old Electron app stays on disk)"

if ! command -v node >/dev/null; then
  echo "Node 22+ is required on this Pi." >&2
  exit 1
fi

if ! command -v pnpm >/dev/null; then
  corepack enable
  corepack prepare pnpm@9.15.0 --activate
fi

sudo apt-get update
sudo apt-get install -y chromium-browser network-manager rpicam-apps || sudo apt-get install -y chromium network-manager

cd "${ROOT}/../.."
pnpm install
pnpm --filter @alfred/alfredbot build

sudo mkdir -p /var/lib/alfredbot
sudo chown "${USER_NAME}:${USER_NAME}" /var/lib/alfredbot
if [ ! -f /etc/alfredbot.env ]; then
  sudo cp "${ROOT}/deploy/alfredbot.env.example" /etc/alfredbot.env
  echo "ALFREDBOT_STORE_PATH=/var/lib/alfredbot/identity.json" | sudo tee -a /etc/alfredbot.env >/dev/null
fi

PNPM_BIN="$(command -v pnpm)"
sed \
  -e "s#WorkingDirectory=.*#WorkingDirectory=${ROOT}#" \
  -e "s#ExecStart=.*#ExecStart=${PNPM_BIN} start#" \
  "${ROOT}/deploy/alfredbot.service" | sudo tee /etc/systemd/system/alfredbot.service >/dev/null
chmod +x "${ROOT}/deploy/start-kiosk.sh"
sed \
  -e "s#ExecStart=.*#ExecStart=${ROOT}/deploy/start-kiosk.sh#" \
  "${ROOT}/deploy/alfredbot-kiosk.service" | sudo tee /etc/systemd/system/alfredbot-kiosk.service >/dev/null
sudo systemctl daemon-reload
disable_old_kiosk_only
disable_old_autostart_desktops
sudo systemctl enable --now alfredbot.service
sudo systemctl enable alfredbot-kiosk.service

echo "AlfredBot host is on http://127.0.0.1:3200"
echo "Start the kiosk with: sudo systemctl start alfredbot-kiosk.service"
echo "Old robot-client files and sensor units were left in place."
