# iOS ↔ Desktop Client Pairing

## Implementation Guide for the Mobile Client

**Status:** Ready for iOS implementation  
**Audience:** Coding agent building the Alfred iOS client  
**Source of truth for desktop behavior:** this repo’s `apps/desktop-client` + [alfrd-net-desktop-handoff.md](./alfrd-net-desktop-handoff.md)  
**Control plane:** already deployed at `https://api.alfrd.net`

This document is intentionally concrete: endpoints, payloads, SecureStore keys, header rules, state machine, and file-level module suggestions. Implement exactly this protocol unless the desktop handoff is updated.

---

# 0. What “pairing” means (two steps)

There are **two separate links**. Do not collapse them into one screen without preserving both credential stores.

| Step | Name | Who talks to whom | Status in this repo |
|------|------|-------------------|---------------------|
| **A** | **Cloud claim** | iOS ↔ `api.alfrd.net` (links alfrd.net account → Desktop Client ID) | **Implemented** on desktop + control plane |
| **B** | **Device PIN pair** | iOS ↔ discovered desktop base URL `/pair/*` (issues long-lived device bearer) | **Implemented** on Alfred desktop |

After both succeed, every call to the desktop looks like:

```http
POST {alfred_server_url}/api/session/token
Authorization: Bearer <alfred_device_token>
X-Cloud-Token: Bearer <alfred_cloud_token>   # REQUIRED only when alfred_server_url is a relay URL
```

`GET /api/token` remains unauthenticated for the local Mac `/voice/` UI. **iOS must use `/api/session/token`** (device bearer required). Memory and conversation APIs also require the device bearer.

**Talk audio:** after minting a LiveKit token, the phone joins the room. The Mac must also run `pnpm voice` so `alfred-agent` is in the room (desktop alone does not run STT→LLM→TTS).

---

# 1. Actors and URLs

| Actor | URL / process | Role |
|-------|---------------|------|
| Desktop client | `pnpm desktop` → `http://127.0.0.1:$PORT` (default `3000`) | Registers with cloud, opens outbound relay WS, serves `/connect/*` and APIs |
| Control plane | `https://api.alfrd.net` | Auth, claim, candidate list, HTTP relay proxy |
| Relay WS (desktop only) | `wss://api.alfrd.net/relay/server/{serverId}?token=…` | Outbound tunnel; iOS never opens this |
| iOS app | Expo / RN | Cloud login, claim, discovery, (device pair), then API + LiveKit |

### Env for iOS

```text
EXPO_PUBLIC_CLOUD_URL=https://api.alfrd.net
```

Do **not** hardcode a Tailscale or LAN URL as the permanent backend. Discovery writes the live base URL into SecureStore.

### Naming aliases (critical)

Control-plane JSON still uses alfred-home field names. Map them in UI copy only:

| Product term (UI / logs) | API field |
|--------------------------|-----------|
| Desktop Client ID | `serverId` |
| Desktop name | `serverName` / `name` |
| Claim secret | `claimSecret` |

Desktop `GET /connect/info` returns **both** `desktopClientId` and `serverId` (same UUID). Prefer reading either; when calling cloud APIs always send `serverId`.

---

# 2. Credentials to persist (SecureStore / Keychain)

| Key | Type | Set when | Cleared when |
|-----|------|----------|--------------|
| `alfred_cloud_token` | JWT string | `/auth/login` or `/auth/register` | logout |
| `alfred_cloud_server_id` | UUID | successful claim or server select | unlink / logout |
| `alfred_server_url` | base URL, no trailing slash | successful discovery | rediscovery failure clear optional; unlink |
| `alfred_connection_type` | `"lan" \| "wan" \| "relay"` | discovery | rediscovery |
| `alfred_device_token` | opaque bearer | `/pair/confirm` success | unpair / logout |
| `alfred_device_id` | UUID | `/pair/confirm` success | unpair / logout |

Suggested helpers:

```ts
// keys.ts
export const STORE = {
  cloudToken: 'alfred_cloud_token',
  cloudServerId: 'alfred_cloud_server_id',
  serverUrl: 'alfred_server_url',
  connectionType: 'alfred_connection_type',
  deviceToken: 'alfred_device_token',
  deviceId: 'alfred_device_id',
} as const;
```

Never log these values. Never put them in AsyncStorage/plaintext.

---

# 3. End-to-end state machine

Implement this as an explicit connection state (context provider). Suggested states:

```text
boot
  → loading_stored_session
  → needs_cloud_auth          // no/invalid cloud JWT
  → needs_desktop_claim       // JWT ok, no cloudServerId (or user wants to claim another)
  → discovering               // have serverId + JWT, probing candidates
  → needs_device_pair         // discovered URL, no device token  (skip UI until desktop ships /pair)
  → ready                     // have URL (+ device token when required)
  → offline                   // discovery failed / relay down
```

### Boot algorithm

```text
1. Read SecureStore keys.
2. If cloudToken:
     GET https://api.alfrd.net/auth/me  Authorization: Bearer <token>
     on 401 → clear cloud credentials → needs_cloud_auth
3. If cloudServerId:
     GET /servers/:id/candidates (refresh)
     run discoverServer(candidates, cloudToken)
     on success → store URL
     else → offline (offer retry)
4. If deviceToken missing → needs_device_pair (or ready-with-warning if desktop has no /pair yet)
5. Else → ready
```

---

# 4. Step A — Cloud account + claim (IMPLEMENTED)

## 4.1 What the desktop does (do not reimplement on iOS)

On `pnpm desktop` (~3s after listen):

1. Load/create `data/desktop-client/identity.json`:
   - `desktopClientId` = UUID v4
   - `claimSecret` = 8 chars from alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no `I/O/0/1`)
   - `cloudDesktopToken` = server token from register
   - `displayName` = `DESKTOP_CLIENT_NAME` or `"Alfred"`
2. Detect LAN IPv4 + WAN via `api.ipify.org`
3. `POST https://api.alfrd.net/servers/register` with candidates:
   - LAN `http://{lanIp}:{PORT}` priority **10**
   - WAN `http://{wanIp}:{PORT}` priority **20**
   - Relay `{CLOUD_URL}/proxy/{serverId}` priority **100**
4. Open outbound WebSocket relay tunnel

Logs print:

```text
[CloudConnect] Desktop Client ID: <uuid>
[CloudConnect] Claim secret: <8-char>
[CloudConnect] Registered with control plane
[CloudConnect] Relay tunnel established (desktopClientId: …)
```

Same values are also available (when on the Mac / same LAN) from:

```http
GET http://{desktop}/connect/info
```

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

`/connect/info` and `/connect/health` are **intentionally unauthenticated**. The claim secret alone does not grant API access; it only lets a logged-in alfrd.net user bind that desktop to their account.

## 4.2 Cloud API client (implement `src/lib/cloud-api.ts`)

Base: `EXPO_PUBLIC_CLOUD_URL ?? "https://api.alfrd.net"`

### Types

```ts
export interface CloudUser {
  id: string;
  email: string;
  displayName: string;
}

export interface ConnectionCandidate {
  type: 'lan' | 'wan' | 'relay';
  url: string;
  priority: number;
}

export interface CloudServer {
  serverId: string;
  name: string;
  connectionCandidates: ConnectionCandidate[];
  lastSeen: string | null;
  createdAt?: string;
}

export class CloudApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'CloudApiError';
  }
}
```

### Endpoints

| Method | Path | Auth | Body / notes |
|--------|------|------|----------------|
| `POST` | `/auth/register` | none | `{ email, password, displayName }` → `{ token, user }` |
| `POST` | `/auth/login` | none | `{ email, password }` → `{ token, user }` |
| `GET` | `/auth/me` | Bearer cloud JWT | → `CloudUser` |
| `POST` | `/auth/logout` | Bearer cloud JWT | → `{ ok: true }` |
| `POST` | `/servers/claim` | Bearer cloud JWT | `{ serverId, claimSecret }` → `CloudServer` |
| `GET` | `/servers` | Bearer cloud JWT | → `CloudServer[]` |
| `GET` | `/servers/:serverId/candidates` | Bearer cloud JWT | → `CloudServer` (refresh candidates) |
| `DELETE` | `/servers/:serverId` | Bearer cloud JWT | unclaim / unlink |
| `GET` | `/relay/status/:serverId` | Bearer cloud JWT | `{ serverId, online: boolean }` |

### Claim rules the UI must handle

- `serverId` must be a UUID (validate client-side before submit).
- Normalize `claimSecret` with `.trim().toUpperCase()` before send.
- Require length ≥ 8.
- Errors (map to user copy):
  - `404` — desktop not registered / not running
  - `401` — wrong claim secret
  - `409` — already claimed by another account

On success:

1. `SecureStore.setItem(alfred_cloud_token)` already set from login
2. `SecureStore.setItem(alfred_cloud_server_id, result.serverId)`
3. Immediately run discovery on `result.connectionCandidates`

### Claim UI fields (manual fallback)

Always keep manual entry available:

1. **Desktop Client ID** (label may also say “Server ID” for compatibility)
2. **Claim secret** (8 characters, monospace, auto-caps)

Helper text: “On the Mac running Alfred, open **Claim phone** at `http://127.0.0.1:3000/connect/claim`, or read the terminal / `/connect/info`.”

### Claim via QR (preferred)

Desktop encodes a deep link in a QR code. Manual 8-char entry remains fully supported.

**Desktop surfaces (implemented):**

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/connect/claim` | Local HTML page: QR + Desktop Client ID + claim secret |
| `GET` | `/connect/claim.png` | PNG QR image |
| `GET` | `/connect/claim.svg` | SVG QR image |
| `GET` | `/connect/claim.json` | Structured payload (+ `uri`) |
| `GET` | `/connect/info` | Also includes `claimUri`, `claimQrPath`, `claimPagePath` |

**QR contents (canonical):** deep link URI

```text
alfred://claim?v=1&serverId=<uuid>&claimSecret=<8CHAR>&cloudUrl=https%3A%2F%2Fapi.alfrd.net&name=Alfred
```

Equivalent JSON (accepted if a scanner/tool embeds JSON instead of the URI):

```json
{
  "v": 1,
  "type": "alfred.desktop.claim",
  "serverId": "<uuid>",
  "desktopClientId": "<uuid>",
  "claimSecret": "AB12CD34",
  "cloudUrl": "https://api.alfrd.net",
  "name": "Alfred",
  "uri": "alfred://claim?…"
}
```

**iOS Claim screen requirements:**

1. Primary CTA: **Scan QR** (Camera permission: `NSCameraUsageDescription` — “Alfred scans a QR code on your Mac to link this phone.”).
2. Secondary: **Enter code manually** (Desktop Client ID + 8-char secret).
3. Also register the URL scheme / universal-link handler for `alfred://claim` so the iOS Camera app (or Safari) can hand off into the app when the user scans the desktop QR.
4. After a successful scan/parse, **do not skip cloud login**. Flow is still:
   - ensure cloud JWT
   - `POST /servers/claim` with parsed `{ serverId, claimSecret }`
   - discovery → device PIN (Step B)

**Parser to implement on iOS** (`src/lib/claim-qr.ts`):

```ts
export function parseClaimQrPayload(raw: string): {
  serverId: string;
  claimSecret: string;
  cloudUrl?: string;
  name?: string;
} | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) {
    try {
      const json = JSON.parse(trimmed) as {
        type?: string;
        serverId?: string;
        claimSecret?: string;
        cloudUrl?: string;
        name?: string;
      };
      if (
        json.type === 'alfred.desktop.claim' &&
        typeof json.serverId === 'string' &&
        typeof json.claimSecret === 'string'
      ) {
        return {
          serverId: json.serverId,
          claimSecret: json.claimSecret.trim().toUpperCase(),
          cloudUrl: json.cloudUrl,
          name: json.name,
        };
      }
    } catch {
      return null;
    }
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'alfred:' || url.hostname !== 'claim') return null;
    const serverId = url.searchParams.get('serverId');
    const claimSecret = url.searchParams.get('claimSecret');
    if (!serverId || !claimSecret) return null;
    return {
      serverId,
      claimSecret: claimSecret.trim().toUpperCase(),
      cloudUrl: url.searchParams.get('cloudUrl') ?? undefined,
      name: url.searchParams.get('name') ?? undefined,
    };
  } catch {
    return null;
  }
}
```

Expo notes:

- Use `expo-camera` / `expo-barcode-scanner` (or `expo-camera` barcode API) for in-app scan.
- Add scheme in `app.json`: `"scheme": "alfred"` (or merge with existing scheme).
- Handle cold-start deep links with `Linking.getInitialURL()` and warm links with `Linking.addEventListener('url', …)`.
- If `cloudUrl` in the QR differs from `EXPO_PUBLIC_CLOUD_URL`, prefer the **app’s configured** cloud URL unless you intentionally support multi-environment builds; still use scanned `serverId` + `claimSecret`.

Security: the QR contains the same claim secret as the terminal. Anyone who can see the Mac screen can claim the desktop to *their* alfrd.net account. That matches the existing physical-access model for `/connect/info`.

---

# 5. Step A continued — Discovery (IMPLEMENTED)

Implement `src/lib/server-discovery.ts` and `src/lib/backend-url.ts`.

## 5.1 Health probe

```http
GET {candidateUrl}/connect/health
```

Success body (desktop):

```json
{
  "status": "ok",
  "service": "alfred-desktop-client",
  "timestamp": "2026-08-10T…"
}
```

Treat any `resp.ok` as healthy. Timeout: **4–5 seconds** (`AbortSignal`).

### Relay auth on health checks

If `candidate.type === "relay"` (or URL contains `/proxy/`), you **must** send:

```http
X-Cloud-Token: Bearer <alfred_cloud_token>
```

Do **not** put the cloud JWT only in `Authorization` for desktop API calls you also want to authenticate with a device token. The relay strips `X-Cloud-Token` after verifying it and forwards `Authorization` unchanged to the desktop.

LAN/WAN health checks need no auth headers.

## 5.2 Discovery algorithm (copy this)

```ts
const HEALTH_TIMEOUT_MS = 5_000;

export async function discoverServer(
  candidates: ConnectionCandidate[],
  cloudToken?: string,
): Promise<{ url: string; candidateType: ConnectionCandidate['type'] } | null> {
  const sorted = [...candidates].sort((a, b) => a.priority - b.priority);

  for (const candidate of sorted) {
    const url = candidate.url.replace(/\/$/, '');
    const needsCloud = candidate.type === 'relay' || url.includes('/proxy/');
    const ok = await checkHealth(url, needsCloud ? cloudToken : undefined);
    if (ok) {
      await setBackendUrl(url);
      await SecureStore.setItemAsync('alfred_connection_type', candidate.type);
      return { url, candidateType: candidate.type };
    }
  }
  return null;
}

async function checkHealth(url: string, cloudToken?: string): Promise<boolean> {
  try {
    const headers: Record<string, string> = {};
    if (cloudToken) headers['X-Cloud-Token'] = `Bearer ${cloudToken}`;
    const resp = await fetch(`${url}/connect/health`, {
      headers,
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return resp.ok;
  } catch {
    return false;
  }
}
```

Priority expectations from desktop registration:

| type | priority | example URL |
|------|----------|-------------|
| `lan` | 10 | `http://192.168.1.20:3000` |
| `wan` | 20 | `http://203.0.113.10:3000` |
| `relay` | 100 | `https://api.alfrd.net/proxy/<uuid>` |

iOS notes:

- Request **Local Network** permission before LAN probes (`NSLocalNetworkUsageDescription`).
- Cleartext LAN/WAN HTTP is expected for v1; ATS must allow local networking.
- Always refresh candidates from cloud before rediscovery (`GET /servers/:id/candidates`) so IP changes are picked up.
- On repeated API failures (`TypeError`, timeouts, `502` with `{ error: "relay_local_error" }`, `504 relay_timeout`), call rediscovery once with backoff.

## 5.3 `desktopFetch` helper (use for ALL desktop HTTP)

```ts
export async function desktopFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const base = await getBackendUrl(); // from SecureStore cache
  const cloudToken = await SecureStore.getItemAsync('alfred_cloud_token');
  const deviceToken = await SecureStore.getItemAsync('alfred_device_token');

  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && init.body && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (deviceToken) headers.set('Authorization', `Bearer ${deviceToken}`);

  const isRelay = base.includes('/proxy/');
  if (isRelay) {
    if (!cloudToken) throw new Error('Relay URL requires alfred_cloud_token');
    headers.set('X-Cloud-Token', `Bearer ${cloudToken}`);
  }

  const url = `${base.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
  return fetch(url, { ...init, headers });
}
```

### Manual relay verification (agent / QA)

```bash
curl -s -H "X-Cloud-Token: Bearer $CLOUD_JWT" \
  "https://api.alfrd.net/proxy/$DESKTOP_CLIENT_ID/connect/health"
```

Expect `"service":"alfred-desktop-client"`.

---

# 6. Step B — Device PIN pairing (CLIENT CONTRACT)

## 6.1 Desktop status

**Alfred desktop mounts `/pair/*`.** PIN is logged on the Mac (`[Pair] PIN for …`) and shown on `/connect/claim` while a request is pending.

Always complete Step B before calling `/api/session/*`, `/api/conversation/*`, or `/api/memory/*`.

## 6.2 Pairing UX (user-visible)

```text
Discovery succeeded
  → POST /pair/request  { device: { name, device_type, app_version } }
  → Desktop shows 6-digit PIN (terminal / future Mac UI)
  → User types PIN on phone
  → POST /pair/confirm  { device_id, pin }
  → Store token + device_id
  → ready
```

PIN lifetime: **300 seconds**. On expiry, call `/pair/request` again for a new PIN.

Device name suggestion: `"{deviceName} (iOS)"` from `expo-device` / `Platform`.

## 6.3 Request / response contracts

### `POST /pair/request`

Request:

```json
{
  "device": {
    "name": "Devon’s iPhone",
    "device_type": "ios",
    "app_version": "1.0.0"
  }
}
```

Response `200`:

```json
{
  "device_id": "uuid",
  "pin": "123456",
  "expires_in_seconds": 300,
  "auto_paired": false
}
```

Notes:

- The `pin` in the response is for desktop display / debugging in some stacks; **the user should enter the PIN shown on the Mac**, not blindly trust a phone-displayed PIN unless product decides QR pairing later.
- If `auto_paired: true` (trusted origin shortcut used by some alfred-home setups), skip PIN entry and immediately call confirm with the returned pin (or treat as paired only if confirm returns a token). **For Alfred desktop over LAN/relay, assume `auto_paired` is false** — always collect PIN from the Mac.

### `POST /pair/confirm`

Request:

```json
{
  "device_id": "uuid",
  "pin": "123456"
}
```

`pin` must be exactly 6 characters.

Response `200`:

```json
{
  "device_id": "uuid",
  "token": "<opaque bearer>",
  "server_name": "Alfred",
  "server_id": "<desktopClientId uuid>"
}
```

On success:

```ts
await SecureStore.setItemAsync('alfred_device_token', result.token);
await SecureStore.setItemAsync('alfred_device_id', result.device_id);
```

Errors:

| Status | Body (typical) | UI |
|--------|----------------|----|
| 400 | `{ detail: "Invalid PIN" }` | shake + retry |
| 400 | `{ detail: "PIN has expired" }` | restart request |
| 404 | `{ detail: "Device not found" }` | restart request |

### Other pair routes (Settings later)

| Method | Path | Purpose |
|--------|------|---------|
| `DELETE` | `/pair/{device_id}` | Unpair this device (revoke token) |
| `GET` | `/pair/devices` | Admin list (desktop UI; optional on phone) |

Unpair from iOS Settings:

1. `DELETE /pair/{alfred_device_id}` via `desktopFetch` (with headers)
2. Clear `alfred_device_token` + `alfred_device_id`
3. Return to `needs_device_pair`

Logout from alfrd.net should also clear device credentials **or** leave them (product choice). Recommended: clear all SecureStore keys on full sign-out; keep device token on cloud-token refresh if still same account.

## 6.4 Implement `src/lib/pair-api.ts`

```ts
export type DeviceInfo = {
  name: string;
  device_type: 'ios' | 'android' | 'web';
  app_version: string;
};

export async function requestPairing(device: DeviceInfo) {
  const res = await desktopFetch('/pair/request', {
    method: 'POST',
    body: JSON.stringify({ device }),
  });
  if (res.status === 404) {
    throw new Error('PAIRING_NOT_SUPPORTED');
  }
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{
    device_id: string;
    pin: string;
    expires_in_seconds: number;
    auto_paired?: boolean;
  }>;
}

export async function confirmPairing(deviceId: string, pin: string) {
  const res = await desktopFetch('/pair/confirm', {
    method: 'POST',
    body: JSON.stringify({ device_id: deviceId, pin }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw Object.assign(new Error(err.detail ?? 'Pair confirm failed'), {
      status: res.status,
      detail: err.detail,
    });
  }
  return res.json() as Promise<{
    device_id: string;
    token: string;
    server_name: string;
    server_id: string;
  }>;
}
```

Call these **after** discovery so `desktopFetch` has a base URL. Pairing over relay is supported: `/pair/*` rides the same proxy as `/connect/health`.

---

# 7. Screen flow (implement in this order)

## Screen 1 — Cloud login / register

- Email, password, display name (register)
- On success → save `alfred_cloud_token` → load `GET /servers`
  - If servers length > 0 → Screen 2 (select)
  - Else → Screen 3 (claim)

## Screen 2 — Select desktop

- List `name`, `lastSeen`, relay online badge via `GET /relay/status/:id`
- Actions: Connect (discover), Claim another, Unlink (`DELETE /servers/:id`)

## Screen 3 — Claim desktop

- Primary: **Scan QR** (parse `alfred://claim?…` or claim JSON)
- Secondary: manual Desktop Client ID + Claim secret
- Submit / after scan → `POST /servers/claim` → save `alfred_cloud_server_id` → Screen 4

## Screen 4 — Connecting (discovery)

- Show progress: “Trying local network…” → “Trying direct…” → “Trying secure relay…”
- On success show mode chip: Local / Direct / Relay
- On failure: Retry, show “Is `pnpm desktop` running?” + relay status

## Screen 5 — Device PIN

- Trigger `/pair/request`
- Countdown from `expires_in_seconds`
- 6-digit PIN entry
- Confirm → store device creds → Home

## Home readiness check

Before Talk / Memory:

```text
cloudToken && cloudServerId && serverUrl && (deviceToken || pairingNotSupportedDevBypass)
```

Show connection pill always: Local | Direct | Relay | Offline.

---

# 8. Suggested file layout (Expo)

```text
src/lib/
  keys.ts                 # SecureStore key constants
  backend-url.ts          # get/set/clear alfred_server_url + in-memory cache
  cloud-api.ts            # api.alfrd.net typed client
  server-discovery.ts     # discoverServer + health probe
  desktop-fetch.ts        # Authorization + X-Cloud-Token rules
  pair-api.ts             # /pair/request + /pair/confirm
  connection-context.tsx  # state machine provider

src/screens/
  CloudLoginScreen.tsx
  DesktopSelectScreen.tsx
  ClaimDesktopScreen.tsx
  DiscoveringScreen.tsx
  DevicePinScreen.tsx
  ConnectionSettingsScreen.tsx
```

Wire `ConnectionProvider` at app root. All feature APIs import `desktopFetch`, never a hardcoded host.

---

# 9. Headers cheat sheet

| Destination | Path examples | `Authorization` | `X-Cloud-Token` |
|-------------|---------------|-----------------|-----------------|
| `api.alfrd.net` | `/auth/*`, `/servers/*` | cloud JWT | — |
| LAN/WAN desktop | `/connect/health`, `/pair/*`, `/api/*` | device token (when paired) | — |
| Relay desktop `…/proxy/{id}/…` | same paths | device token (when paired) | cloud JWT **required** |

Common bug: putting cloud JWT in `Authorization` for relay API calls and then being unable to send the device token. Always prefer `X-Cloud-Token` for the cloud JWT on relay.

---

# 10. Desktop endpoints useful during pairing QA

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/connect/health` | none | Discovery probe |
| `GET` | `/connect/info` | none | Desktop Client ID + claim secret |
| `GET` | `/connect/claim` | none | QR + secret + live pairing PIN |
| `POST` | `/pair/request` | none | Start PIN pair |
| `POST` | `/pair/confirm` | none | Finish PIN pair → device token |
| `GET` | `/status` | none | Route index |
| `GET`/`POST` | `/api/session/token` | device bearer | LiveKit join token (iOS) |
| `GET` | `/api/session/status` | device bearer | LiveKit config + agent hint |
| `POST` | `/api/conversation/turn` | device bearer | Text Talk fallback |
| `POST` | `/api/memory` | device bearer | Remember text / multipart artifact |
| `POST` | `/api/memory/search` | device bearer | Hybrid search |
| `POST` | `/api/memory/ask` | device bearer | Ask + optional synthesis |
| `GET` | `/api/token` | none | Local `/voice/` UI only |

After claim + discovery + pair, smoke test from the phone:

```ts
const res = await desktopFetch('/api/session/token', { method: 'POST' });
const { url, room, token, identity } = await res.json();
// connect LiveKit RN SDK — and ensure `pnpm voice` is running on the Mac
```

---

# 11. Error / edge cases the agent must handle

1. **Desktop not running** — claim may 404; discovery all fail → Offline with retry.
2. **Wrong claim secret** — 401; do not rotate anything on the phone.
3. **Claimed by another account** — 409; tell user to unclaim from the other account or reset desktop identity (Mac-side: delete `data/desktop-client/identity.json` and restart — destructive; document in Settings help only).
4. **Multiple desktops** — store one active `alfred_cloud_server_id`; switching desktops clears `alfred_server_url` + device creds for the previous host, then rediscovers + re-pairs.
5. **Relay only (cellular)** — Local Network failures are normal; do not treat LAN fail as fatal if relay succeeds.
6. **Stale LAN IP** — always refresh candidates before rediscovery.
7. **App resume** — re-validate `/auth/me`, then cheap `/connect/health` on cached URL; full rediscover on failure.
8. **Clock skew** — PIN expiry is desktop-authoritative; on “expired”, request a new PIN.
9. **Alfred-home conflict** — multiple desktops can be claimed on one account; shutting down alfred-home avoids user confusion when claiming, not a protocol error.

---

# 12. Minimal acceptance checklist (iOS)

- [ ] Register / login against `https://api.alfrd.net`
- [ ] Claim using Desktop Client ID + 8-char secret from `pnpm desktop` logs
- [ ] Claim by scanning QR from `http://127.0.0.1:3000/connect/claim`
- [ ] `alfred://claim` deep link opens Claim flow when already installed
- [ ] Discovery prefers LAN when phone and Mac share Wi-Fi
- [ ] Discovery falls back to relay on cellular with `X-Cloud-Token`
- [ ] `alfred_server_url` persisted and reused on next launch
- [ ] Rediscover works after Mac sleep/wake
- [ ] Device PIN flow implemented against `/pair/*`
- [ ] `desktopFetch` attaches device bearer + relay cloud header correctly
- [ ] Logout clears SecureStore keys
- [ ] Unlink desktop calls `DELETE /servers/:id` and clears local server keys

---

# 13. Copy-paste constants

```ts
export const CLOUD_URL =
  process.env.EXPO_PUBLIC_CLOUD_URL ?? 'https://api.alfrd.net';

export const CLAIM_SECRET_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// Desktop generates length 8 from this alphabet.

export const DISCOVERY_TIMEOUT_MS = 5_000;
export const PIN_LENGTH = 6;
```

Info.plist / Expo usage strings to add when enabling discovery + mic later:

```text
NSLocalNetworkUsageDescription = "Alfred looks for your Mac on the local network to connect securely."
NSMicrophoneUsageDescription   = "Alfred uses the microphone so you can talk to your assistant."
```

---

# 14. Relationship to other docs

| Doc | Use it for |
|-----|------------|
| [alfrd-net-desktop-handoff.md](./alfrd-net-desktop-handoff.md) | Desktop runbook + high-level claim/discovery |
| This file | **Implement iOS pairing/connectivity now** |
| [alfred-ios-prd.md](./alfred-ios-prd.md) | Full product scope after pairing (voice, memory, permissions) |

**Bottom line for the vibecode agent:** implement Step A (cloud auth → claim → LAN/WAN/relay discovery → `desktopFetch`) and Step B (PIN pair) completely against this desktop client; use `/api/session/token` for Talk and `/api/memory/*` for memory; keep `pnpm voice` running on the Mac for voice audio.
