# alfrd.net Connectivity Stack

**Audience:** Coding agents (and humans) porting this pattern into another app.  
**Status:** Live for Alfred — control plane at `https://api.alfrd.net`, desktop host in this repo, optional web UI at `https://app.alfrd.net`.  
**Related:** [accountless-alfrd-net.md](./accountless-alfrd-net.md), [alfrd-net-desktop-handoff.md](./alfrd-net-desktop-handoff.md), [ios-desktop-pairing.md](./ios-desktop-pairing.md)

This document describes **how remote clients reach a private home machine** without Tailscale/VPN, which services are involved, and the contracts you must implement to clone the pattern.

---

## 1. Design goals

1. **Local-first data.** Canonical state (memory, prefs, device tokens) lives on the user’s home machine. The cloud does **not** store app data.
2. **No inbound ports.** The home machine opens an **outbound** WebSocket to the relay. Home NATs / CGNAT / hotel Wi‑Fi still work.
3. **Accountless linking.** Clients prove an 8-character claim secret (plus Desktop Client ID / `serverId`). There is no email/password product flow.
4. **LAN-first, relay last.** Same client code path works at home (direct LAN) and at the office (HTTPS proxy through the tunnel).
5. **Two credential layers.** Cloud/link JWT unlocks the tunnel; a separate device bearer unlocks app APIs after a PIN pair on the home machine.

---

## 2. Services involved

| Service | Where it lives | Runtime | Public URL | Role |
|---------|----------------|---------|------------|------|
| **alfrd-cloud** (control plane + relay hub) | Sibling repo `alfred-home/services/alfrd-cloud` | Bun + Hono on **Fly.io** (`alfrd-cloud` app) | `https://api.alfrd.net` / `wss://api.alfrd.net` | Registry, link JWTs, candidate list, HTTP proxy over WS tunnel, optional speech WS mux |
| **Desktop host** | This repo `apps/desktop-client` | Node/TypeScript (Hono HTTP on `:3000`) | LAN/`127.0.0.1` only; registered to cloud | Identity, register, outbound relay tunnel, `/connect/*`, `/pair/*`, app APIs |
| **Mobile client** | This repo `apps/iOS-client` | Expo / React Native | — | Link → discover → PIN pair → call desktop APIs |
| **Web client** | Sibling `alfred-home/web` | Static SPA on **Cloudflare Pages** | `https://app.alfrd.net` | Same link/discover/PIN flow in a browser |
| **DNS** | Cloudflare zone for `alfrd.net` | — | — | `api` → Fly; `app` → Pages |
| **WAN IP helper** | `https://api.ipify.org` | External | — | Desktop best-effort WAN candidate (not auth-critical) |
| **LiveKit Cloud** (voice only) | Third-party | — | LiveKit project URLs | WebRTC media; **not** part of the HTTP connectivity tunnel |
| **Speech Engine path** (optional) | Same Fly service + desktop | — | `wss://api.alfrd.net/speech/{serverId}/ws` | Multiplexed over the desktop’s existing tunnel for ElevenLabs-style streams |

### What is deliberately *not* required

- Tailscale / WireGuard / port forwarding
- User accounts on the control plane (legacy `/auth/*` may still exist; product clients must not use them)
- Storing memory or device secrets in Fly SQLite beyond registry/link sessions

---

## 3. Architecture

```text
┌──────────────────────┐         link JWT + discovery          ┌─────────────────────┐
│  Phone / laptop      │ ───────────────────────────────────► │  api.alfrd.net       │
│  (iOS / web)         │ ◄── candidates: LAN / WAN / relay ── │  (Fly: alfrd-cloud)  │
└──────────┬───────────┘                                       │  registry + relay    │
           │                                                   └──────────┬──────────┘
           │  Prefer LAN/WAN direct                                        │
           │  Else HTTPS /proxy/{serverId}/*                               │ outbound WSS
           │  + X-Cloud-Token: Bearer <link JWT>                           │ /relay/server/{id}?token=
           ▼                                                               ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│  Home Mac — desktop client (pnpm desktop)                                         │
│  • identity.json (serverId + claimSecret)                                         │
│  • HTTP :3000 — /connect/health, /pair/*, /api/*                                  │
│  • Relay handler: WS request → fetch 127.0.0.1:3000 → WS response                 │
│  • Device store (PIN pair → long-lived device bearer)                             │
│  • App data (memory, etc.) stays on disk here                                     │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**Invariant:** Cloud is registry + dumb tunnel. If Fly is down, LAN still works between phone and Mac on the same network. If the Mac is asleep/off, relay is offline and remote access fails until the desktop reconnects.

---

## 4. Naming aliases (do not rename remote fields)

Control-plane JSON still uses alfred-home field names. Map only in UI/logs.

| Product term | API / persistence field |
|--------------|-------------------------|
| Desktop Client ID | `serverId` (UUID) |
| Desktop name | `name` / `serverName` |
| Claim secret | `claimSecret` (8 chars) |
| Link JWT | `token` from `POST /servers/link`; clients often store as `alfred_cloud_token` |
| Desktop→cloud tunnel token | opaque `serverTokens.token` from `POST /servers/register` |
| Device bearer | `token` from `POST /pair/confirm` |

Desktop `GET /connect/info` returns both `desktopClientId` and `serverId` (same UUID).

---

## 5. End-to-end flows

### 5.1 Desktop boot (home machine)

1. Load or create `data/desktop-client/identity.json`:
   - `desktopClientId` = UUID v4
   - `claimSecret` = 8 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no `I/O/0/1`)
   - `cloudDesktopToken` = last register token (optional cache)
   - `displayName` = env or `"Alfred"`
2. Detect LAN IPv4 (Node `os.networkInterfaces`) and WAN via `api.ipify.org`.
3. `POST https://api.alfrd.net/servers/register` with body:
   ```json
   {
     "serverId": "<uuid>",
     "claimSecret": "<8CHAR>",
     "name": "Alfred",
     "connectionCandidates": [
       { "type": "lan", "url": "http://{lanIp}:{port}", "priority": 10 },
       { "type": "wan", "url": "http://{wanIp}:{port}", "priority": 20 },
       { "type": "relay", "url": "https://api.alfrd.net/proxy/{serverId}", "priority": 100 }
     ]
   }
   ```
4. Receive `{ serverId, token }` — persist `token` as the desktop’s server token.
5. Open outbound WebSocket:
   ```text
   wss://api.alfrd.net/relay/server/{serverId}?token={serverToken}
   ```
6. Keepalive: app-level `{ type: "ping" }` every ~25s; reconnect with backoff; re-register on reconnect (fresh LAN/WAN + token).
7. Re-register on an interval (~15 min) so candidates stay current after network changes.

Implementation reference: `apps/desktop-client/src/lib/cloud-connect.ts`.

Env:

```text
ALFRD_CLOUD_URL=https://api.alfrd.net
ALFRD_RELAY_URL=wss://api.alfrd.net
ALFRD_CLOUD_DISABLED=true          # opt-out (sidecar / local-only)
DESKTOP_CLIENT_NAME=Alfred
ALFRED_DESKTOP_IDENTITY_PATH=…     # optional override for identity.json
```

### 5.2 Client link (phone / browser) — accountless

1. User scans QR or enters Desktop Client ID + claim secret.
2. QR / deep link shape:
   ```text
   alfred://claim?v=1&serverId=<uuid>&claimSecret=<8CHAR>&cloudUrl=https%3A%2F%2Fapi.alfrd.net&name=Alfred
   ```
3. `POST /servers/link` (no Authorization):
   ```json
   { "serverId": "<uuid>", "claimSecret": "<8CHAR>" }
   ```
   Normalize secret: `.trim().toUpperCase()`, length ≥ 8.
4. Response includes:
   - `token` — **link JWT** (`typ: "link"`, `sub`/`serverId` scoped, ~30 days, `jti` stored in `link_sessions`)
   - `connectionCandidates`
   - server metadata
5. Persist link JWT + `serverId`. Do **not** treat this as a user account session.

`POST /servers/claim` is an alias of `/link` for older clients.

### 5.3 Discovery ladder

Clients probe candidates sorted by `priority` (lower first). Default priorities: LAN `10`, WAN `20`, relay `100`.

For each candidate, `GET {url}/connect/health` with timeout ~5s:

- Relay probes **must** send `X-Cloud-Token: Bearer <linkJwt>`.
- First OK response wins; store base URL (no trailing slash) and connection mode (`lan` | `wan` | `relay`).
- Always keep a synthetic relay fallback `https://api.alfrd.net/proxy/{serverId}` even if the registry omitted it.

Reference: `apps/iOS-client/src/lib/discovery.ts`.

### 5.4 Device PIN pair (app auth)

After a reachable base URL exists:

1. `POST {base}/pair/request`  
   Body: `{ "device": { "name": "Devon’s iPhone", "device_type": "ios", "app_version": "…" } }`  
   → `{ device_id, pin, expires_in_seconds }` (PIN also logged / shown on Mac claim UI).
2. User enters the 6-digit PIN shown on the Mac (`/connect/claim` or desktop logs).
3. `POST {base}/pair/confirm`  
   Body: `{ "device_id", "pin" }`  
   → `{ device_id, token, server_name, server_id }` — **device bearer**.
4. All app APIs use:
   ```http
   Authorization: Bearer <deviceToken>
   X-Cloud-Token: Bearer <linkJwt>   # only when base URL contains /proxy/
   ```

`Authorization` is reserved for the device bearer on relay paths. The hub strips/consumes `X-Cloud-Token` and forwards `Authorization` to the desktop unchanged.

Reference: `apps/desktop-client/src/routes/pair.ts`, `apps/iOS-client/src/lib/desktop-api.ts`.

### 5.5 Ongoing API calls

| Path type | Headers |
|-----------|---------|
| Direct LAN/WAN | `Authorization: Bearer <deviceToken>` |
| Relay `…/proxy/{serverId}/…` | device bearer **plus** `X-Cloud-Token: Bearer <linkJwt>` |

Unauthenticated desktop probes (intentional):

- `GET /connect/health`
- `GET /connect/info`
- Claim QR/JSON pages under `/connect/claim*`

---

## 6. Control plane API contract (`api.alfrd.net`)

Base: Bun/Hono service. Health: `GET /health` → `{ status: "ok", service: "alfrd-cloud", … }`.

### Desktop-facing

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/servers/register` | none | Upsert server + candidates; returns opaque **server token** |
| `PUT` | `/servers/:serverId/candidates` | `Authorization: Bearer <serverToken>` | Push candidate updates |
| `WS` | `/relay/server/:serverId?token=<serverToken>` | query token | Outbound tunnel |

### Client-facing (accountless)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/servers/link` | none | `{ serverId, claimSecret }` → link JWT + candidates |
| `POST` | `/servers/claim` | none | Alias of `/link` |
| `GET` | `/servers/:serverId/candidates` | link JWT | Refresh candidates |
| `DELETE` | `/servers/:serverId` | link JWT | Revoke link sessions / unlink |
| `GET` | `/relay/status/:serverId` | link JWT | `{ online: boolean }` |
| `ALL` | `/proxy/:serverId/*` | see below | HTTP proxy through tunnel |
| `POST` | `/servers/browser-session` | link JWT | Sets HttpOnly `alfrd_link` cookie for iframe/nav from `app.alfrd.net` |

### Proxy auth (order)

1. `X-Cloud-Token: Bearer <linkJwt>` (preferred for API clients)
2. `?alfrd_token=` (stripped before forward; browser one-shots)
3. Cookie `alfrd_link` (browser session)
4. `Authorization: Bearer <linkJwt>` only when not using the dual-header device pattern

CORS allows headers: `Content-Type`, `Authorization`, `X-Cloud-Token`. Origins include `https://app.alfrd.net` and local Vite ports.

### Link JWT shape (`jose` HS256)

```text
typ: "link"
sub: <serverId>
serverId: <serverId>
jti: <uuid>          # row in link_sessions
exp: ~30 days
```

Signed with Fly secret `JWT_SECRET`. Access checks verify signature **and** live `link_sessions` row matching `jti` + `serverId`.

### Persistence (SQLite / LibSQL via Drizzle)

Tables that matter for connectivity:

- `servers` — id, claim_secret, connection_candidates JSON, last_seen, name
- `server_tokens` — desktop tunnel/register tokens
- `link_sessions` — accountless client JWTs by `jti`
- `users` / `user_sessions` — **legacy**; do not use in new clients

Deploy DB: Fly volume mounted at `/app/data` (`DATABASE_URL=file:./data/cloud.db`) or Turso LibSQL.

---

## 7. Relay WebSocket protocol

Desktop connects; clients never open this socket.

### Hub → desktop

```json
{ "type": "request", "requestId": "<uuid>", "method": "GET", "path": "/connect/health", "headers": {}, "body": null }
```

Optional speech mux (same tunnel):

```json
{ "type": "ws-open", "streamId": "…", "path": "/ws", "headers": {} }
{ "type": "ws-frame", "streamId": "…", "binary": true, "data": "<base64>" }
{ "type": "ws-close", "streamId": "…", "code": 1000, "reason": "closed" }
```

### Desktop → hub

```json
{ "type": "response", "requestId": "<uuid>", "status": 200, "headers": { "content-type": "application/json" }, "body": "{…}" }
{ "type": "ping", "atMs": 123 }
```

Hub replies to ping with `pong`. Pending HTTP requests time out ~30s on the hub; desktop local fetch timeout ~25s.

Desktop handler must:

1. Strip accidental `/proxy/{serverId}` prefix from `path`.
2. `fetch("http://127.0.0.1:{port}" + path)` with forwarded headers (rewrite `Host`).
3. Return status/headers/body as JSON text over the WS (not raw HTTP framing).

Reference: `alfred-home/services/alfrd-cloud/src/relay/hub.ts`, desktop `handleRelayRequest` in `cloud-connect.ts`.

---

## 8. Desktop host surface (minimum to clone)

A second app’s “home node” needs at least:

| Surface | Why |
|---------|-----|
| Persistent identity (UUID + claim secret) | Registration + linking |
| `POST /servers/register` + outbound relay WS | Reachability off-LAN |
| `GET /connect/health` | Discovery probe |
| `GET /connect/info` (+ optional claim QR/JSON) | Human/agent claim UX |
| `POST /pair/request`, `/pair/confirm`, device store | App-level auth after link |
| Authenticated app routes behind device bearer | Real product APIs |
| Relay-safe responses | JSON/text bodies that survive WS string transport; avoid relying on hop-by-hop headers |

Alfred also serves memory/conversation/LiveKit token routes; those are product-specific and can be swapped for your app’s APIs as long as header rules above hold.

Disable cloud when running as a local sidecar:

```text
ALFRD_CLOUD_DISABLED=true
```

---

## 9. Client storage keys (suggested)

| Key | Content |
|-----|---------|
| `alfred_cloud_token` | Link JWT from `/servers/link` |
| `alfred_cloud_server_id` | Desktop `serverId` |
| `alfred_server_url` | Winning base URL (LAN/WAN/relay) |
| `alfred_connection_type` | `lan` \| `wan` \| `relay` |
| `alfred_device_token` | After PIN confirm |
| `alfred_device_id` | Paired device id |

Clear link + device credentials on unlink/sign-out. Never put them in plaintext web `localStorage` if you can use SecureStore / HttpOnly cookie (`alfrd_link` for browser iframe proxy).

---

## 10. DNS, TLS, and deployment

### Fly (`alfrd-cloud`)

- App name: `alfrd-cloud`, region e.g. `lax`
- `fly.toml`: internal port `4000`, `force_https`, `auto_stop_machines = false`, volume `alfrd_cloud_data` → `/app/data`
- Secrets: `JWT_SECRET`, `RELAY_SECRET`, `DATABASE_URL`, optional `DATABASE_AUTH_TOKEN`, `CORS_ORIGINS`
- Deploy + migrate:
  ```bash
  cd alfred-home/services/alfrd-cloud
  fly deploy
  fly ssh console --command "sh -c 'cd /app && bun run db:migrate'"
  ```

### Cloudflare DNS

- `api.alfrd.net` → Fly app hostname
- **Proxy status: DNS only (grey cloud)** for `api` so Cloudflare does not terminate/break long-lived WebSockets in front of Fly. TLS is served by Fly (`force_https`).
- `app.alfrd.net` → Cloudflare Pages project (e.g. `alfred-home`)

### Web deploy

```bash
cd alfred-home/web
npm run build
wrangler pages deploy dist --project-name alfred-home --commit-dirty=true
```

### Reusing vs forking the cloud

Alfred Conversation Core **reuses** the live `api.alfrd.net` deployment. For another product you can:

1. **Reuse the same Fly app** (shared registry; different `name` / claim secrets per installation), or  
2. **Fork alfrd-cloud** to a new Fly app + DNS (`api.yourproduct.com`) if you need isolation.

Do not stand up a second cloud accidentally while still pointing clients at `api.alfrd.net` — registrations will diverge.

---

## 11. Checklist: stand this up in another application

Use this as an implementation order for an agent.

### A. Control plane (if not reusing `api.alfrd.net`)

- [ ] Copy/adapt `alfred-home/services/alfrd-cloud` (Hono + Drizzle + relay hub).
- [ ] Provision Fly app, volume, secrets (`JWT_SECRET`, `DATABASE_URL`, CORS).
- [ ] Point `api.<your-domain>` at Fly with Cloudflare **DNS-only**.
- [ ] Confirm `GET /health`, WebSocket upgrade on `/relay/server/:id`, and `/proxy/:id/*`.

### B. Home host

- [ ] Persist `serverId` + `claimSecret` on disk.
- [ ] Implement register + candidate advertisement (LAN/WAN/relay priorities).
- [ ] Maintain outbound relay WS with ping, backoff, re-register on wake/network change.
- [ ] Expose unauthenticated `/connect/health` (+ claim info UX).
- [ ] Implement `/pair/*` device PIN flow and gate product APIs on device bearer.
- [ ] Ensure relayed requests hit `127.0.0.1` (not a LAN bind that loops).

### C. Remote clients

- [ ] `POST /servers/link` with claim secret → store link JWT.
- [ ] Discovery: sort candidates, probe `/connect/health`, relay header rules.
- [ ] PIN pair against discovered base URL.
- [ ] Dual headers on relay: `X-Cloud-Token` + `Authorization`.
- [ ] Rediscovery/backoff when probes fail after network changes.

### D. Verification

```bash
# Desktop running locally
curl -s http://127.0.0.1:3000/connect/health

# After link JWT issued
curl -s -H "X-Cloud-Token: Bearer $LINK_JWT" \
  "https://api.alfrd.net/proxy/$SERVER_ID/connect/health"

curl -s -H "Authorization: Bearer $LINK_JWT" \
  "https://api.alfrd.net/relay/status/$SERVER_ID"
```

Expect health JSON from the desktop through the tunnel when the Mac’s relay log shows “Relay tunnel established”.

---

## 12. Code map (Alfred)

| Concern | Path |
|---------|------|
| Desktop cloud connect + relay client | `apps/desktop-client/src/lib/cloud-connect.ts` |
| Identity persistence | `apps/desktop-client/src/lib/identity-store.ts` |
| Connect / claim HTTP | `apps/desktop-client/src/routes/` (`connect`, claim UI) |
| Device PIN pair | `apps/desktop-client/src/routes/pair.ts`, `lib/device-store.ts` |
| iOS link API | `apps/iOS-client/src/lib/cloud-api.ts` |
| iOS discovery | `apps/iOS-client/src/lib/discovery.ts` |
| iOS desktop calls + headers | `apps/iOS-client/src/lib/desktop-api.ts` |
| Control plane + proxy | `alfred-home/services/alfrd-cloud/src/index.ts` |
| Server/link routes | `alfred-home/services/alfrd-cloud/src/routes/servers.ts` |
| Relay hub | `alfred-home/services/alfrd-cloud/src/relay/hub.ts` |
| Link JWT | `alfred-home/services/alfrd-cloud/src/lib/jwt.ts` |
| Access checks | `alfred-home/services/alfrd-cloud/src/lib/server-access.ts` |
| Fly config | `alfred-home/services/alfrd-cloud/fly.toml` |

---

## 13. What to tell another agent in one paragraph

Build a home Node/TypeScript host that registers a stable UUID + claim secret with a Bun/Hono control plane on Fly (`api…`), advertises LAN/WAN/relay candidates, and keeps an outbound WebSocket tunnel. Remote clients prove the claim secret via `POST /servers/link`, receive a scoped link JWT, discover the best base URL (LAN → WAN → `/proxy/{id}`), PIN-pair for a device bearer, and call home APIs with `Authorization` for the device and `X-Cloud-Token` only on relay URLs. Put DNS for the API on Cloudflare in DNS-only mode; keep all canonical data on the home machine—the cloud is registry and dumb tunnel only.
