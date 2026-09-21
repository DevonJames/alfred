# AlfredBot

Raspberry Pi kiosk client: Chromium + a local Node host. Conversation Core, memory, and GPT-Live stay on the Mac (`pnpm desktop` + `make alfred VOICE=live`). This app is a pairing + LiveKit participant, same shape as iOS.

Phase 1 (this tree): Wi-Fi join, QR + PIN pairing, dark amber face, Talk waveform/transcript, robot mic/speaker/camera in the LiveKit room, `show_expression` face events. Servos, ROS, wheels, and face-tracking are next.

## Local Mac check

```bash
# terminal 1 — desktop + GPT-Live
make alfred VOICE=live

# terminal 2 — robot UI (http://127.0.0.1:3200)
pnpm alfredbot
# or: ALFREDBOT_FORCE_WIFI_UI=1 pnpm alfredbot
```

On macOS the Wi-Fi screen is skipped unless `ALFREDBOT_FORCE_WIFI_UI=1`. The robot shows its own claim QR. On the already-linked iPhone: **Settings → Claim AlfredBot**, scan that code, then type the Mac PIN on the phone. The robot camera stays off.

## Updates from this Mac (preferred)

Build here, rsync a tiny payload (`host.mjs` + `dist-ui`) into `~/alfredbot`. The Pi only needs Node and Chromium — not the monorepo or pnpm. This never writes to `/opt/alfred-home` or `~/robot-client`.

```bash
cd apps/alfredbot
./deploy/push.sh alfred@100.115.52.14
```

First time on the Pi, after the push:

```bash
ssh alfred@100.115.52.14 '~/alfredbot/deploy/bootstrap-on-pi.sh'
```

That adds the new host + Chromium kiosk and **switches boot** so they start instead of the old Electron kiosk. The old app stays on disk. Face tracker, mic-array, TOF, ROS, and the other sensor units keep running.

## Pi install

`install-on-pi.sh` is only for a tree already on the Pi. Prefer `push.sh` + `bootstrap-on-pi.sh`. Neither path uninstalls the old Electron app; they only `systemctl disable --now alfred-robot-client` and hide matching autostart `.desktop` files (renamed `.disabled`).

The bootstrap writes:

- `/etc/alfredbot.env`
- `alfredbot.service` (Node host on `0.0.0.0:3200` so the phone can provision it)
- `alfredbot-kiosk.service` (Chromium kiosk)

Open `http://127.0.0.1:3200` on the 7" panel. If no network is up, the first screen is Wi-Fi (NetworkManager / `nmcli`).

## Env

| Variable | Meaning |
| --- | --- |
| `ALFREDBOT_PORT` | Host port (default `3200`) |
| `ALFREDBOT_CLOUD_URL` | Control plane (default `https://api.alfrd.net`) |
| `ALFREDBOT_STORE_PATH` | Identity file (default `data/alfredbot/identity.json`) |
| `ALFREDBOT_SKIP_WIFI` | Skip the Wi-Fi screen |
| `ALFREDBOT_FORCE_WIFI_UI` | Always show the Wi-Fi screen (mock join on non-Linux) |
| `ALFREDBOT_DEVICE_NAME` | Pairing display name |
| `ALFREDBOT_BIND` | Listen address (default `0.0.0.0`) |
| `ALFREDBOT_ENABLE_RPI_CAMERA` | Set `1` only when we deliberately turn the CSI camera on |
| `ALFREDBOT_CAMERA_FRAME_SINK` | JPEG path for the existing face tracker (default `/tmp/alfred-camera-latest.jpg`) |

Claim uses the iPhone camera, not the robot CSI. Host `rpicam-vid` stays off unless `ALFREDBOT_ENABLE_RPI_CAMERA=1`. Talk still uses Chromium `getUserMedia` later. Audio uses the browser capture/playback path so it matches desktop/iOS.
