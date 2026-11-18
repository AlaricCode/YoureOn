# Building the iOS app on your own Mac (free Apple ID)

Use this when your iPhone can't be plugged into the lead's Mac. A free Apple ID ("Personal
Team") can only install on phones that Xcode has seen over USB at least once, and a bundle ID
belongs to exactly one team. So each teammate signs with their own team and their own bundle
ID. The app talks to the same server (https://youre-on.fly.dev) either way.

## One-time setup (about 15 minutes, plus the Xcode download)

1. **Xcode 26**, signed in: Xcode → Settings → Accounts → **+** → Apple ID. You'll see a
   team "Your Name (Personal Team)".
2. **The iOS platform**, if Xcode asks for it: Xcode → Settings → Components → iOS. It needs
   about 9 GB free. You can also run `xcodebuild -downloadPlatform iOS`.
3. **CocoaPods**: `brew install cocoapods`.
4. **Your team ID** (10 characters):
   `defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier | grep teamID`
5. **Plug in your iPhone** with a cable and tap **Trust**. Then turn on Settings → Privacy &
   Security → **Developer Mode** and restart when asked. In Xcode → Window → Devices and
   Simulators, tick **Connect via network** so later installs work over Wi-Fi.

## Build and install

```bash
git checkout devnet-launch && git pull && npm ci
cd apps/mobile
printf 'EXPO_PUBLIC_API_URL=https://youre-on.fly.dev\nEXPO_PUBLIC_VOICE=off\n' > .env.local

# Your own bundle ID + team (app.config.js reads these; never commit them into app.json)
export IOS_BUNDLE_ID=dev.youreon.app.<yourname>
export APPLE_TEAM_ID=<your team id>

CI=1 npx expo prebuild -p ios --no-install && (cd ios && pod install)
npx expo run:ios --configuration Release --device   # pick your phone from the list
```

After the first install, open the phone's Settings → General → VPN & Device Management →
your Apple ID → **Trust**.

Notes:

- **Release** bundles the JavaScript into the app, so the phone needs nothing from your laptop
  afterwards. Free-team installs expire after **7 days**, so rebuild before the demo if needed.
- `EXPO_PUBLIC_VOICE=off` uses the typed-terms form. Once the ElevenLabs key is live on the
  server, drop that line and rebuild.
- If the build fails on `WebRTC/WebRTC.h`, your `node_modules` predates the 144.1.2 pin.
  Run `npm ci` again.
