# alfrd.net — Desktop Client Handoff (for Mobile / iOS)

This repo hosts the **desktop client**: a local HTTP process that registers with
`api.alfrd.net`, advertises LAN/WAN/relay candidates, and maintains an outbound
WebSocket relay tunnel.

The **mobile client** lives in this repo at `apps/iOS-client`. Pairing and Talk
protocols:

- [ios-desktop-pairing.md](./ios-desktop-pairing.md)
- [ios-livekit-voice.md](./ios-livekit-voice.md)
- [accountless-alfrd-net.md](./accountless-alfrd-net.md)

alfred-home docs remain historical reference for the control plane field names,
not the product client.

## Product naming

| Product term | Meaning |
|--------------|---------|
| Desktop client | This Mac-hosted process (`pnpm desktop`) |
| Mobile client | `apps/iOS-client` (Expo Dev Client) |

The control plane API still uses `serverId` / `/servers/*` / `/proxy/:serverId`.
Do **not** rename those remote fields — only local logs/UI use “desktop client”.

## Control plane (already deployed)

```text
ALFRD_CLOUD_URL=https://api.alfrd.net
ALFRD_RELAY_URL=wss://api.alfrd.net
```

Reuse this deployment. Do not stand up a second cloud for Alfred Conversation Core
unless you intentionally want an isolated registry.

## Desktop client runbook

```bash
# from alfred repo root
pnpm desktop
```

After ~3s, logs print:

```text
[CloudConnect] Desktop Client ID: <uuid>
[CloudConnect] Claim secret: <8-char>
[CloudConnect] Claim QR page: http://127.0.0.1:3000/connect/claim
[CloudConnect] Registered with control plane
[CloudConnect] Relay tunnel established (desktopClientId: …)
```

Identity persists at `data/desktop-client/identity.json` (gitignored).

### Local endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/connect/health` | none | Discovery probe (LAN/WAN/relay) |
| `GET` | `/connect/info` | none | Desktop Client ID + claim secret + relay status + claim URI |
| `GET` | `/connect/claim` | none | Local claim UI (QR + manual secret + pending PIN) |
| `GET` | `/connect/claim.png` | none | QR PNG (`alfred://claim?…`) |
| `GET` | `/connect/claim.svg` | none | QR SVG |
| `GET` | `/connect/claim.json` | none | Structured claim payload |
| `POST` | `/pair/request` | none | Start device PIN pairing |
| `POST` | `/pair/confirm` | none | Confirm PIN → device bearer |
| `GET` | `/pair/devices` | none | List devices (PIN for pending only) |
| `DELETE` | `/pair/:device_id` | none | Unpair / revoke |
| `GET`/`POST` | `/api/session/token` | device bearer | LiveKit join token (iOS Talk) |
| `GET` | `/api/session/status` | device bearer | Session / LiveKit status |
| `POST` | `/api/session/end` | device bearer | End session ack |
| `POST` | `/api/conversation/turn` | device bearer | Text conversation turn |
| `GET` | `/api/conversation/events` | device bearer | Poll text-session events |
| `POST` | `/api/memory` | device bearer | Add memory / artifact |
| `POST` | `/api/memory/search` | device bearer | Hybrid search |
| `POST` | `/api/memory/ask` | device bearer | Ask memory |
| `POST` | `/api/memory/correct` | device bearer | Correct memory |
| `DELETE` | `/api/memory/:id` | device bearer | Forget |
| `GET` | `/api/memory/due` | device bearer | Due reminders |
| `GET` | `/api/token` | none | Legacy local `/voice/` token |

Example:

```bash
curl -s http://127.0.0.1:3000/connect/health | jq .
curl -s http://127.0.0.1:3000/connect/info | jq .
open http://127.0.0.1:3000/connect/claim
```

`/connect/info` returns both product fields and control-plane aliases:

```json
{
  "desktopClientId": "…",
  "claimSecret": "…",
  "desktopClientName": "Alfred",
  "relayConnected": true,
  "cloudUrl": "https://api.alfrd.net",
  "serverId": "…",
  "serverName": "Alfred",
  "claimUri": "alfred://claim?v=1&serverId=…&claimSecret=…&cloudUrl=…&name=…",
  "claimQrPath": "/connect/claim.png",
  "claimPagePath": "/connect/claim"
}
```

Claim UIs that still say “Server ID” can use `serverId`.

QR claim encodes the same `serverId` + `claimSecret` as a deep link:

```text
alfred://claim?v=1&serverId=<uuid>&claimSecret=<8CHAR>&cloudUrl=https%3A%2F%2Fapi.alfrd.net&name=Alfred
```

Manual 8-character entry remains supported. Full iOS parse/claim steps: [ios-desktop-pairing.md](./ios-desktop-pairing.md).

## Claim + discovery flow (mobile)

1. User scans QR or enters Desktop Client ID + claim secret (no alfrd.net account).
2. Phone calls `POST /servers/link` → scoped **link JWT** + candidates.
3. Discovery tries LAN → WAN → relay via `GET {url}/connect/health`.
4. Store winning URL + link JWT (`alfred_cloud_token` — not a user session).
5. For relay URLs, send `X-Cloud-Token: Bearer <linkJwt>`.
6. Complete PIN pairing, then use device bearer for Alfred APIs.

See [accountless-alfrd-net.md](./accountless-alfrd-net.md).

### Suggested SecureStore keys (from alfred-home iOS spec)

| Key | Content |
|-----|---------|
| `alfred_cloud_token` | JWT from `api.alfrd.net` |
| `alfred_cloud_server_id` | Claimed desktop client UUID (`serverId`) |
| `alfred_server_url` | Discovered best base URL |
| `alfred_device_token` | Local device bearer (after PIN pairing) |
| `alfred_device_id` | Device id (after PIN pairing) |

After discovery, complete PIN pairing (`/pair/request` → enter PIN from Mac claim page / logs → `/pair/confirm`), then call authenticated APIs with `Authorization: Bearer <deviceToken>`.

For Talk audio, also run `pnpm voice` on the Mac (separate process from `pnpm desktop`).

## Relay verification

With a cloud user JWT and claimed desktop client id:

```bash
curl -s -H "X-Cloud-Token: Bearer $CLOUD_JWT" \
  "https://api.alfrd.net/proxy/$DESKTOP_CLIENT_ID/connect/health"
```

Expect `{ "status": "ok", "service": "alfred-desktop-client", … }` from `GET /status` (the site root `/` is the HTML UI hub).

## Explicit follow-ons

- Electron (or other) Mac shell around this Node host
- Embed voice-agent in desktop process (today: run `pnpm voice` separately)
- Switch voice default memory provider to `memory.oip-local`
- Full Alfred web SPA in this repo (today `app.alfrd.net` is still built from `alfred-home/web`; it now PIN-pairs to this desktop instead of Home username/password)
- iOS Expo implementation (separate coding agent)

### Redeploying app.alfrd.net (PIN pairing fix)

From `alfred-home/web` after the AuthContext / PairingScreen changes:

```bash
npm run build
wrangler pages deploy dist --project-name <your-pages-project> --commit-dirty=true
```

Then hard-refresh `https://app.alfrd.net` (clear site localStorage if the old password screen is cached). Flow: cloud claim → **Request pairing** → enter PIN from `http://127.0.0.1:3000/connect/claim`.

## Conflict note vs alfred-home

Multiple desktop registrations can coexist on `api.alfrd.net` under one account.
Shutting down alfred-home avoids confusion when claiming; it is not a protocol conflict.
