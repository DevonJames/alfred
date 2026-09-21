# Sourced by bootstrap-on-pi.sh and install-on-pi.sh.
# Never deletes the old Electron robot client. Only stops that kiosk from
# autostarting so AlfredBot can take the display.
#
# Leave on disk and leave running:
#   /opt/alfred-home  /home/alfred/robot-client  /etc/alfred-robot-client.env
#   alfred-face-tracker, alfred-audio-direction, alfred-tof, alfred-ros,
#   alfred-face-identity, alfred-balancer, alfred-leds, alfred-librespot

OLD_KIOSK_UNITS=(
  alfred-robot-client.service
  robot-client.service
  alfred-electron.service
)

SENSOR_UNITS=(
  alfred-face-tracker.service
  alfred-audio-direction.service
  alfred-tof.service
  alfred-ros.service
  alfred-face-identity.service
  alfred-balancer.service
  alfred-leds.service
  alfred-librespot.service
)

unit_known() {
  systemctl cat "$1" >/dev/null 2>&1
}

disable_old_kiosk_only() {
  echo "=== leave old app on disk; stop only the Electron kiosk autostart ==="
  local unit
  for unit in "${OLD_KIOSK_UNITS[@]}"; do
    if unit_known "$unit"; then
      ${SUDO:-sudo} systemctl disable --now "$unit" || true
      echo "disabled autostart for $unit (unit file and app files left in place)"
    fi
  done

  echo "--- sensor units (untouched) ---"
  for unit in "${SENSOR_UNITS[@]}"; do
    if unit_known "$unit"; then
      systemctl is-enabled "$unit" 2>/dev/null || true
      systemctl is-active "$unit" 2>/dev/null || true
    fi
  done
}

# Hide matching .desktop launchers without deleting them.
_disable_desktop_file() {
  local file="$1"
  if [ ! -f "$file" ] || [[ "$file" == *.disabled ]]; then
    return 0
  fi
  if grep -Ei 'robot-client|alfred-robot-client|electron.*kiosk' "$file" >/dev/null 2>&1; then
    ${SUDO:-sudo} mv "$file" "${file}.disabled"
    echo "disabled autostart file ${file} (renamed to .disabled)"
  fi
}

disable_old_autostart_desktops() {
  local dir file
  for dir in "/home/${USER_NAME:-alfred}/.config/autostart" /etc/xdg/autostart; do
    [ -d "$dir" ] || continue
    for file in "$dir"/*.desktop; do
      [ -f "$file" ] || continue
      _disable_desktop_file "$file"
    done
  done
}
