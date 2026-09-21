#!/usr/bin/env bash
# Chromium kiosk supervisor. Never exec a one-shot Chrome — a grey GLES
# frame stays running and systemd will not restart it.
set -u

export DISPLAY="${DISPLAY:-:0}"
export XAUTHORITY="${XAUTHORITY:-${HOME:-/home/alfred}/.Xauthority}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export LIBGL_ALWAYS_SOFTWARE="${LIBGL_ALWAYS_SOFTWARE:-1}"

HOST="http://127.0.0.1:3200"
PROFILE="${HOME:-/home/alfred}/.config/chromium-kiosk"
REAL_BIN="/usr/lib/chromium/chromium"
WRAP_BIN="$(command -v chromium-browser || command -v chromium || true)"
CHROME="$REAL_BIN"
if [ ! -x "$CHROME" ]; then
  CHROME="$WRAP_BIN"
fi
if [ -z "${CHROME}" ]; then
  echo "Chromium is not installed" >&2
  exit 1
fi

wait_x() {
  for auth in "$XAUTHORITY" /home/alfred/.Xauthority /var/run/lightdm/root/:0; do
    if [ -r "$auth" ]; then
      export XAUTHORITY="$auth"
      break
    fi
  done
  for _ in $(seq 1 80); do
    if [ -S /tmp/.X11-unix/X0 ] || [ -S /tmp/.X11-unix/X1 ]; then
      return 0
    fi
    if command -v xdpyinfo >/dev/null && xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  echo "X11 display $DISPLAY is not ready; trying Chrome anyway" >&2
  return 0
}

wait_host() {
  for _ in $(seq 1 80); do
    if curl -sf --max-time 1 "$HOST/" >/dev/null; then
      return 0
    fi
    sleep 0.25
  done
  echo "AlfredBot host is not reachable on :3200" >&2
  return 1
}

stop_chrome() {
  pkill -f /usr/lib/chromium/chromium >/dev/null 2>&1 || true
  pkill -x chromium >/dev/null 2>&1 || true
  pkill -x chromium-browser >/dev/null 2>&1 || true
  sleep 0.4
}

clear_locks() {
  mkdir -p "$PROFILE"
  rm -f "$PROFILE/SingletonLock" "$PROFILE/SingletonSocket" "$PROFILE/SingletonCookie"
  if [ -f "$PROFILE/Default/Preferences" ]; then
    sed -i \
      -e 's/"exited_cleanly":false/"exited_cleanly":true/' \
      -e 's/"exit_type":"Crashed"/"exit_type":"Normal"/' \
      "$PROFILE/Default/Preferences" 2>/dev/null || true
  fi
}

heartbeat_ok() {
  curl -sf --max-time 1 "$HOST/api/kiosk/heartbeat" >/dev/null
}

command -v xsetroot >/dev/null && xsetroot -solid "#000000" || true

while true; do
  if ! wait_x; then
    sleep 2
    continue
  fi
  if ! wait_host; then
    sleep 2
    continue
  fi

  stop_chrome
  clear_locks

  "$CHROME" \
    --user-data-dir="$PROFILE" \
    --kiosk \
    --ozone-platform=x11 \
    --disable-gpu \
    --disable-gpu-compositing \
    --disable-gpu-rasterization \
    --in-process-gpu \
    --no-sandbox \
    --disable-dev-shm-usage \
    --disable-extensions \
    --disable-background-networking \
    --disable-sync \
    --disable-translate \
    --disable-component-update \
    --disable-default-apps \
    --disable-client-side-phishing-detection \
    --disable-features=TranslateUI,MediaRouter \
    --default-background-color=FF000000 \
    --noerrdialogs \
    --disable-session-crashed-bubble \
    --hide-crash-restore-bubble \
    --check-for-update-interval=31536000 \
    --autoplay-policy=no-user-gesture-required \
    --use-fake-ui-for-media-stream \
    --unsafely-treat-insecure-origin-as-secure=http://127.0.0.1:3200 \
    --disable-http-cache \
    --password-store=basic \
    --no-first-run \
    --app="$HOST/" \
    >/tmp/alfredbot-kiosk.log 2>&1 &
  pid=$!

  alive=0
  for _ in $(seq 1 20); do
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    if heartbeat_ok; then
      alive=1
      break
    fi
    sleep 1
  done

  if [ "$alive" != 1 ]; then
    echo "kiosk did not heartbeat; restarting chrome" >&2
    kill "$pid" 2>/dev/null || true
    stop_chrome
    sleep 2
    continue
  fi

  misses=0
  while kill -0 "$pid" 2>/dev/null; do
    if heartbeat_ok; then
      misses=0
    else
      misses=$((misses + 1))
      if [ "$misses" -ge 3 ]; then
        echo "kiosk heartbeat lost; restarting chrome" >&2
        break
      fi
    fi
    sleep 4
  done

  kill "$pid" 2>/dev/null || true
  stop_chrome
  sleep 1
done
