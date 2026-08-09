# alfrd.net — Desktop Client Handoff (for Mobile / iOS)

This repo hosts the **desktop client**: a local HTTP process that registers with
`api.alfrd.net`, advertises LAN/WAN/relay candidates, and maintains an outbound
WebSocket relay tunnel.

The **mobile client** (iOS) is built separately. Use this document plus the
alfred-home iOS spec as the implementation guide:

- `/Users/devon/Documents/development/alfred-home/docs/toBuild/ios-alfrd-net-connectivity.md`
- `/Users/devon/Documents/development/alfred-home/docs/alfrd-net-canonical-reference.md`

## Product naming

| Product term | Meaning |
|--------------|---------|
| Desktop client | This Mac-hosted process (`pnpm desktop`) |
| Mobile client | iOS app (separate agent / repo work) |

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
[CloudConnect] Registered with control plane
[CloudConnect] Relay tunnel established (desktopClientId: …)
```

Identity persists at `data/desktop-client/identity.json` (gitignored).

### Local endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/connect/health` | none | Discovery probe (LAN/WAN/relay) |
| `GET` | `/connect/info` | none | Desktop Client ID + claim secret + relay status |

Example:

```bash
curl -s http://127.0.0.1:3000/connect/health | jq .
curl -s http://127.0.0.1:3000/connect/info | jq .
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
  "serverName": "Alfred"
}
```

Claim UIs that still say “Server ID” can use `serverId`.

## Claim + discovery flow (mobile)

1. User creates/logs into an alfrd.net account (`/auth/register`, `/auth/login`).
2. User claims this desktop client: `POST /servers/claim` with `{ serverId, claimSecret }` (JWT).
3. Mobile loads candidates: `GET /servers` or `GET /servers/:id/candidates`.
4. Mobile tries candidates by priority: LAN (10) → WAN (20) → relay (100) via `GET {url}/connect/health`.
5. Store the winning URL (SecureStore `alfred_server_url`) for subsequent API calls.
6. For relay URLs (`…/proxy/{id}/…`), send `X-Cloud-Token: Bearer <cloudJwt>` so `Authorization` can carry future device tokens.

### Suggested SecureStore keys (from alfred-home iOS spec)

| Key | Content |
|-----|---------|
| `alfred_cloud_token` | JWT from `api.alfrd.net` |
| `alfred_cloud_server_id` | Claimed desktop client UUID (`serverId`) |
| `alfred_server_url` | Discovered best base URL |
| `alfred_device_token` | Local device bearer (after PIN pairing — not in this desktop pass) |
| `alfred_device_id` | Device id (after PIN pairing — not in this desktop pass) |

## Relay verification

With a cloud user JWT and claimed desktop client id:

```bash
curl -s -H "X-Cloud-Token: Bearer $CLOUD_JWT" \
  "https://api.alfrd.net/proxy/$DESKTOP_CLIENT_ID/connect/health"
```

Expect `{ "status": "ok", "service": "alfred-desktop-client", … }`.

## Explicit follow-ons (not in desktop connectivity pass)

- Device PIN pairing / local auth on the desktop client
- Memory HTTP APIs (`POST /api/memory`, etc.) — once added, they ride the same relay
- Electron (or other) Mac shell around this Node host
- iOS Expo implementation (separate coding agent)

## Conflict note vs alfred-home

Multiple desktop registrations can coexist on `api.alfrd.net` under one account.
Shutting down alfred-home avoids confusion when claiming; it is not a protocol conflict.
