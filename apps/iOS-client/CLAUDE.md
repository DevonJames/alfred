# Alfred iOS client — agent notes

Expo SDK 54 + React Native Dev Client. LiveKit/WebRTC require a **custom native
build** (not Expo Go). Product protocols live in TypeScript; native modules are
only for media, Keychain, camera, and permissions.

## Stack

- Expo Router, React Query, NativeWind, Zustand
- alfrd.net cloud + desktop discovery/pair (see `docs/ios-desktop-pairing.md`)
- LiveKit voice (see `docs/ios-livekit-voice.md` at repo root)

## Commands

```bash
cd apps/iOS-client
bun install
npx expo prebuild --platform ios
npx expo run:ios                 # Simulator / device via Xcode toolchain
npx expo start --dev-client      # Metro against Dev Client binary
```

Open `ios/*.xcworkspace` in Xcode for signing and Simulator runs.

## Env

```bash
EXPO_PUBLIC_CLOUD_URL=https://api.alfrd.net
# alias also accepted by cloud-api.ts:
# EXPO_PUBLIC_ALFRD_CLOUD_URL=https://api.alfrd.net
```

## Companion Mac

Speak mode needs `pnpm desktop` + `pnpm voice` on the claimed Mac. Text Talk and
Memory work against desktop HTTP alone.
