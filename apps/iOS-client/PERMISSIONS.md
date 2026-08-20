# iOS native configuration

Applied in `app.json`. Rebuild the Dev Client / run `npx expo prebuild` after
changing plugins or Info.plist strings — Expo Go cannot load LiveKit / WebRTC.

## Bundle / deep links

- Display name: Alfred
- Bundle ID: `net.alfrd.alfred`
- URL scheme: `alfred://` (claim deep links: `alfred://claim?…`)

## Info.plist strings

- `NSMicrophoneUsageDescription` — Speak / LiveKit mic
- `NSCameraUsageDescription` — claim QR scan
- `NSPhotoLibraryUsageDescription` — memory photo attach
- `NSLocalNetworkUsageDescription` — LAN discovery probe
- Speech recognition string **removed** — primary STT is desktop/cloud via LiveKit PCM

## App Transport Security

```json
"NSAppTransportSecurity": {
  "NSAllowsLocalNetworking": true
}
```

Do **not** add `NSAllowsArbitraryLoads`. LAN may be HTTP; WAN/relay stay HTTPS.

## Background modes

```json
"UIBackgroundModes": ["audio"]
```

## Plugins

- `expo-router`, `expo-dev-client`, `expo-secure-store`
- `expo-audio`, `expo-camera`, `expo-notifications`
- `@livekit/react-native-expo-plugin`
- `@config-plugins/react-native-webrtc`

## JS already handles

- Permission primer + lazy re-request on Talk
- LiveKit missing → text Talk (`no-sdk` blocker)
- Keychain credentials via `expo-secure-store`
- Offline capture outbox + memory mirror

See also [APP_STORE.md](./APP_STORE.md) and repo docs `ios-livekit-voice.md`.
