# Alfred iOS client

Expo SDK 54 Dev Client with LiveKit/WebRTC. Not Expo Go.

## Quick start (Xcode)

```bash
cd apps/iOS-client
bun install
cp .env.example .env   # EXPO_PUBLIC_CLOUD_URL=https://api.alfrd.net
npx expo prebuild --platform ios   # if ios/ missing
cd ios && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install && cd ..
open ios/Alfred.xcworkspace
```

In Xcode: select a Simulator or device, set your Signing Team on target **Alfred**, Run.

Metro (JS reload) in another terminal:

```bash
npx expo start --dev-client
```

## LiveKit / Speak acceptance

```bash
./scripts/verify-livekit-natives.sh
```

Checks pods + `WebRTC.framework` in the Simulator app. JS falls back to text
Talk when `isLiveKitAvailable()` is false (`no-sdk`).

End-to-end Speak (physical device):

1. Mac: `pnpm desktop` + `pnpm voice` (same LiveKit env as desktop)
2. Phone: claim → discover → pair → grant mic
3. Talk → Speak: blocker leaves `no-sdk`; hold-to-talk publishes mic
4. Captions on topics `alfred.caption` / `alfred.user`
5. Text Talk still works if mic denied

Details: [ios-livekit-voice.md](../../docs/ios-livekit-voice.md).

## App Store

See [APP_STORE.md](./APP_STORE.md) and [eas.json](./eas.json). Review notes must
state the companion Mac requirement.

## CocoaPods note

If `pod install` fails with `Unicode Normalization not appropriate for ASCII-8BIT`:

```bash
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
pod install
```
