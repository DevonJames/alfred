# Accountless alfrd.net linking

**Status:** Implemented in code (deploy cloud + web to take effect)  
**Related:** [alfrd-net-desktop-handoff.md](./alfrd-net-desktop-handoff.md), [ios-desktop-pairing.md](./ios-desktop-pairing.md)

## Product rule

Alfred is a **single-user, self-hosted** system. There is **no alfrd.net email/password account** in the product flow.

Remote access (iPhone at the office → Mac Mini at home, laptop browser) still uses the Fly/Cloudflare relay at `api.alfrd.net`. That service is a **dumb tunnel + registry**, not a multi-tenant account product.

## Flow

```text
Mac: pnpm desktop → registers serverId + claimSecret, opens outbound WSS tunnel
Phone / browser: enter ID + secret (or scan QR)
  → POST /servers/link  (no Authorization)
  → scoped link JWT (30 days)
  → discover LAN → WAN → relay (/proxy/:id with X-Cloud-Token: link JWT)
  → device PIN pair (/pair/*)
  → device bearer for Alfred APIs
```

## Control plane API

| Endpoint | Auth | Notes |
|----------|------|-------|
| `POST /servers/register` | none (desktop) | Unchanged |
| `POST /servers/link` | none | **New** — `{ serverId, claimSecret }` → `{ token, connectionCandidates, … }` |
| `POST /servers/claim` | none | Alias of `/link` (compat) |
| `GET /servers/:id/candidates` | link JWT (or legacy user JWT) | Dual-auth one release |
| `ALL /proxy/:id/*` | `X-Cloud-Token: Bearer <link JWT>` | Dual-auth one release |
| `DELETE /servers/:id` | link JWT | Revokes link sessions |
| `/auth/*` | legacy | Still deployed; product clients must not call it |

## Client storage

| Key | Meaning |
|-----|---------|
| `alfred_cloud_token` | **Link JWT** (not a user session) |
| `alfred_cloud_server_id` | Desktop Client ID |
| `alfred_server_url` | Discovered base URL |
| `alfred_device_token` | After PIN pair |
| `alfred_cloud_email` / `password` | Deprecated — cleared on sign-out |

## Deploy checklist

1. **alfrd-cloud** (Fly):
   ```bash
   cd alfred-home/services/alfrd-cloud
   fly deploy
   fly ssh console --command "sh -c 'cd /app && bun run db:migrate'"
   ```
2. **app.alfrd.net** (Cloudflare Pages) from `alfred-home/web`:
   ```bash
   npm run build
   wrangler pages deploy dist --project-name <name> --commit-dirty=true
   ```
3. Rebuild / reopen **iOS** client (this repo `apps/iOS-client`).
4. Keep Mac `pnpm desktop` running; re-link phone/browser with claim secret from `/connect/claim`.

## Why this still enables office → home

The Mac maintains an **outbound** WebSocket to `api.alfrd.net`. Clients off-LAN hit `/proxy/{desktopClientId}/…` with the link JWT; the hub forwards through the tunnel to `127.0.0.1` on the Mini. Multiple devices (phone + laptop) each get their own link JWT + device PIN pair against the same desktop.
