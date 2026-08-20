# Alfred iOS — App Store / TestFlight

## Companion Mac requirement (review notes)

Paste into App Review notes:

```text
Alfred on iPhone is a client for a user-owned Mac running the Alfred desktop
companion (claim, discovery, pairing, memory) and the voice agent process.

Speak (real-time voice) requires:
1. User is signed into alfrd.net on both phone and Mac
2. Phone claimed and paired to that Mac
3. Alfred desktop + voice agent running on the Mac
4. Microphone and Local Network permissions on the phone

Without the companion Mac, Text Talk and Memory are unavailable after pairing
fails; the app will show onboarding to claim/pair. We do not run a hosted
conversation service that replaces the user’s Mac.

Demo account / hardware: [provide reviewer Mac access or TestFlight pairing
instructions if requested].
```

## Privacy (nutrition labels)

| Data | Purpose | Linked to user | Tracking |
|------|---------|----------------|----------|
| Microphone | LiveKit WebRTC → user’s Mac → configured STT/LLM/TTS vendors | Yes (account) | No |
| Photos (optional) | Memory artifacts stored on the Mac | Yes | No |
| Camera | Scan claim QR only | No | No |
| Local Network | Prefer LAN path to Mac | No | No |
| Account (email) | alfrd.net login / claim | Yes | No |

Canonical memories stay on the user’s Mac. The phone keeps credentials
(Keychain), discovered URL, and optional offline outbox / mirror.
`PrivacyInfo.xcprivacy` sets `NSPrivacyTracking` to false.

## Listing checklist

- [ ] Screenshots (Talk text, Speak, Memory, Settings) for required device sizes
- [ ] Subtitle / description mention companion Mac
- [ ] Support URL (e.g. https://alfrd.net)
- [ ] Privacy policy URL covering mic → desktop vendors
- [ ] Category: Productivity / Lifestyle as appropriate

## EAS

```bash
cd apps/iOS-client
eas login
eas init                    # writes real extra.eas.projectId into app.json
eas build --profile development-device --platform ios   # Dev Client on device
eas build --profile preview --platform ios              # TestFlight internal
eas build --profile production --platform ios
eas submit --platform ios --latest
```

Profiles: `eas.json` (`development` = Simulator Dev Client, `development-device`,
`preview`, `production`). Replace `replace-with-eas-project-id` after `eas init`.

Apple Developer: App ID `net.alfrd.alfred`, certificates via EAS credentials.

## Xcode local

```bash
cd apps/iOS-client
bun install
cp .env.example .env
npx expo prebuild --platform ios   # if needed
open ios/Alfred.xcworkspace
```

Signing: select your Apple Team on target **Alfred**. Display name Alfred.
Physical device required for mic + Local Network Speak tests.

## Encryption export

`ITSAppUsesNonExemptEncryption` is `false` in `app.json` (HTTPS / standard
crypto only). Revisit if you add custom encryption beyond TLS.
