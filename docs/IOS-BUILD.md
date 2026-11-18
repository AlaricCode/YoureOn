# Building and installing the iOS app

There are two ways to get the app onto an iPhone:

- **[Paid account (EAS)](#paid-account-eas)**, the demo path. EAS builds the app in the cloud,
  signs it with the paid Apple team, and gives each phone an install link. Teammates register
  their phones remotely, and JS-only fixes reach the phones over the air.
- **[Free Apple ID on your own Mac](#free-apple-id-on-your-own-mac)**, the fallback while
  Apple's approval is pending. Each teammate builds with Xcode for their own phone.

Both talk to the same server (https://youre-on.fly.dev).

## Paid account (EAS)

From `eas login` to "installed on 3 phones" takes about an hour, most of it waiting for the
build. The lead runs everything on their Mac. Teammates only open a link on their phone, twice
(once to register it, once to install the app), then scan a sign-in QR the lead prints.

### At a glance

| Step                          | Who                                    | Command                                          |
| ----------------------------- | -------------------------------------- | ------------------------------------------------ |
| 0. Prerequisites              | lead                                   | `npm ci`, the face model, `eas()`                |
| 1. Preflight                  | lead                                   | `scripts/eas-preflight.sh`                       |
| 2. Log in, link the project   | lead                                   | `eas login`, `eas init`, commit `app.json`       |
| 3. Register the phones        | lead sends a link, each owner opens it | `eas device:create`                              |
| 4. Build                      | lead                                   | `eas build -p ios --profile preview`             |
| 5. Install, sign in           | each owner opens the build link        | (Safari), then `npm run demo-claim-qr` per phone |
| 6. JS-only fix                | lead                                   | `scripts/eas-update.sh --profile preview -m "…"` |
| 7. Native change or new phone | lead                                   | `eas build …` again, reinstall                   |

### 0. Prerequisites (once)

- **Apple Developer Program** approved (Individual is fine). Note the paid **Team ID**: on
  developer.apple.com → Account → Membership details. It is not the free "Personal Team" ID
  `2LFBZ8AAAX` in `app.json`. You never need to put it in a file (see step 3).
- **Expo account.** If the team uses an Expo organization, create the project under it in step
  2, so devices and credentials belong to the organization.
- **EAS plan.** Free gives 15 iOS builds a month in a low-priority queue that can take 90+
  minutes at peak. Starter ($19) gets the priority queue. Buy it before the build that matters.
- **Phones:** iOS 16.4 or later, a passcode, Face ID set up.
- **The Mac:**

  ```bash
  git checkout devnet-launch && git pull && npm ci
  ls apps/mobile/assets/models/w600k_mbf_float32.tflite || scripts/face-model.sh
  eas() { npx --yes eas-cli@27.10.0 "$@"; }   # the version everything here was checked with
  ```

  Run the `scripts/…` commands from the repo root. Run `eas` commands in `apps/mobile`, where
  `eas.json` lives. The blocks below use `(cd apps/mobile && eas …)` for that.

  The face model is not in git (see [How the face model gets to EAS](#how-the-face-model-gets-to-eas)).
  `scripts/face-model.sh` rebuilds it byte for byte from the official InsightFace release (needs
  `uv` or Python 3.12, about 5 minutes). You can also copy the file from a teammate's checkout.
  Only the Mac that runs `eas build` needs it.

### 1. Preflight

```bash
scripts/eas-preflight.sh
```

It needs no Expo login and changes nothing. It ends with `0 failed` when `eas build` has what it
needs. It checks:

- the face model's bytes, and that git does not track it;
- what EAS will install: the lockfile in sync for the worker's npm 10, the
  `@livekit/react-native-webrtc` 144.1.2 override, the face-detector patch;
- `eas.json` through eas-cli's own schema, and the app config with the profile's env;
- the upload itself. It replays eas-cli's own copy of the working tree and checks that the
  model and every needed file are in it, and that nothing git ignores is: no `.env` files,
  keypairs, `apps/mobile/ios/` or `.claude/` worktrees. It also checks that eas-cli treats the
  app as a managed project, so EAS runs `expo prebuild` itself.

A dirty git tree is only a warning: `eas build` uploads the working tree as it is, uncommitted
files included. Commit first anyway, so the build matches a commit. Run the preflight before
every build. `--profile pitch` evaluates another profile; `--offline` skips the network.

### 2. Log in and link the project

```bash
(cd apps/mobile && eas login)   # your Expo account
(cd apps/mobile && eas init)    # "create a project for @…/youre-on?" yes; pick the organization if asked
git add apps/mobile/app.json && git commit -m "Link the EAS project"
scripts/eas-preflight.sh        # now says "linked to EAS project …" and "EAS Update on"
```

`eas init` writes `extra.eas.projectId` and `owner` into `app.json` (`app.config.js` passes
them through), and the EAS Update URL is derived from the project ID. Commit that change, and
push it so teammates' checkouts match.

### 3. Register the phones (remote, about 2 minutes each)

Ad hoc builds install only on phones registered **before** the build. Register all of them
(A, B, the judge cam and the spare) first.

```bash
export EXPO_APPLE_TEAM_ID=<paid team id>   # picks the paid team at the Apple login
(cd apps/mobile && eas device:create)
```

1. Log in to Apple when asked (Apple ID, password, 2FA). The lead has to approve 2FA prompts, so
   stay reachable during the first device and build steps.
2. Choose **Website - generates a registration URL to be opened on your devices**. eas-cli
   prints a link (`https://expo.dev/register-device/…`) and a QR code. One link works for every
   phone.
3. Send the link to each phone owner. On the iPhone, in **Safari**:
   - open the link and tap through to download the profile (Allow);
   - open Settings → **Profile Downloaded** → Install, then enter the passcode;
   - Safari returns to the Expo page, which says the device was registered.
4. Check that every phone is listed: `(cd apps/mobile && eas device:list)`. You can also name
   them with `eas device:rename`.

The Apple portal lists the phones once EAS has signed a build for them, which happens in step 4.

### 4. Build

```bash
scripts/eas-preflight.sh
(cd apps/mobile && eas build -p ios --profile preview)
```

The first build asks a few questions. Answer them this way:

| Prompt                                         | Answer                                         |
| ---------------------------------------------- | ---------------------------------------------- |
| Log in to your Apple account?                  | Yes. Pick the paid team, not "(Personal Team)" |
| Generate a new Apple Distribution Certificate? | Yes                                            |
| Select devices for the ad hoc build            | All of them                                    |
| Generate a new Apple Provisioning Profile?     | Yes                                            |

EAS keeps the certificate and the profile on its servers (`eas credentials -p ios` shows them).
Later builds only ask again when the device list changes. EAS registers the bundle ID
`dev.youreon.app.eas` on the paid team. It is not `app.json`'s `dev.youreon.app`, because that
one may already belong to the free Personal Team, and a bundle ID belongs to exactly one team.

There is no export-compliance question: `app.json` already answers it
(`ITSAppUsesNonExemptEncryption: false`). The app only uses standard encryption: HTTPS, WSS,
WebRTC's DTLS-SRTP, Ed25519 signatures and the keychain. Confirm that before a TestFlight
upload. Left unanswered, `eas build` would ask and then write its evaluated config into
`app.json`, including the profile's bundle ID and the dev client's name. The preflight fails if
the answer goes missing.

What happens next:

- The upload is about 20 MB, including the 13.6 MB face model.
- The build runs on the `macos-tahoe-26.5-xcode-26.6` image. That is the Xcode the Release
  build was verified with; the SDK 58 default would be Xcode 27.1 RC.
- In the build log, `eas-build-hook(pre-install): ok: face model present` shows up within the
  first minute, and `post-install: ok: face-detector Swift patch applied` just before Xcode
  starts. If either fails, the build stops there, not after 20 minutes of Xcode.
- After about 15–25 minutes of building, plus the queue, eas-cli prints the build page URL and
  a QR code. `eas build … --no-wait` returns at once, and `eas build:list` finds the build later.

### 5. Install on the phones

1. On each phone, open the build page URL in Safari (or scan the QR code with the Camera app) and
   tap **Install**.
2. If iOS says the app needs Developer Mode, turn it on: Settings → Privacy & Security →
   Developer Mode → On, then restart and confirm.
3. Open the app once and accept the camera, microphone, Face ID and notification prompts, so
   none of them pops up on stage.
4. Delete any older free-team "You're On" (bundle ID `dev.youreon.app`) from the phone. It
   would otherwise stay as a second, identical icon.
5. **Sign the phones in.** To iOS the EAS build is a different app (bundle ID
   `dev.youreon.app.eas`, not the free team's `dev.youreon.app`), so its keychain starts empty:
   no device key, no session and no demo wallet, whatever the free-team build had. Without this
   step, phones A and B reach the demo signed out. On the lead's Mac, with the server's
   `DEMO_ADMIN_TOKEN` exported (from the password manager, since `fly secrets list` shows only a
   digest; never commit or paste it), print one QR per phone:

   ```bash
   npm run demo-claim-qr -- --party a --base-url https://youre-on.fly.dev   # phone A
   npm run demo-claim-qr -- --party b --base-url https://youre-on.fly.dev   # phone B
   npm run demo-claim-qr -- --party a --base-url https://youre-on.fly.dev   # judge cam
   ```

   On each phone, tap **Demo account** on the sign-up screen (or Profile → Demo account) and
   point the camera at its QR. Each QR is single use and expires after 10 minutes; run the
   command again for a new one. The judge cam is a second device of A, so it claims party `a`
   too, then turns on Profile → **Judge cam**. A claim binds that install's device key to the
   party and imports the party's wallet, so claiming again later is harmless.

Share build links only within the team. Anyone with the link can download the app file. It only
installs on the registered phones, but it contains the face model, whose licence is
non-commercial research only.

### 6. JS-only changes: EAS Update (recommended)

**Is it worth it for the demo? Yes.** Every build includes `expo-updates`. Without it, a JS fix
costs a build (the queue plus about 20 minutes) and a reinstall on every phone. With it, the fix
reaches the phones on their next cold start:

```bash
git commit -am "Fix the terms card copy"      # an update is always a commit
scripts/eas-update.sh --profile preview --message "Fix the terms card copy"
```

Then on each phone: force-quit the app and reopen it, and wait about 10 seconds while it
downloads the update in the background. Then force-quit and reopen it again to run the update.

The wrapper does three things plain `eas update` does not:

- It bundles with the build profile's own `EXPO_PUBLIC_*` values (API URL, voice) with dotenv
  off. Plain `eas update` would inline whatever `apps/mobile/.env.local` says, such as a laptop
  IP. Before publishing, it checks that the export contains the API URL and the face model.
- It refuses when native code or config changed since the latest finished build of that profile
  (`eas fingerprint:compare`). That case needs a new build; JS sent to an old binary that lacks
  a native module would crash.
- It refuses a dirty git tree.

`--dry-run` stops before publishing and needs no login. To undo an update, run
`eas update:rollback` in `apps/mobile`. Each profile listens on its own channel (`preview`,
`preview-typed`, `pitch`), because the voice setting is baked into each update.

Rebuild instead of updating when you change any of these: a native dependency or its version,
`app.json` (plugins, permissions), `app.config.js`, `patches/`, an `eas.json` profile's
`IOS_BUNDLE_ID`, or the set of phones. Also bump `expo.version` in `app.json` for native
changes. An update only reaches binaries of the same version (the `appVersion` runtime policy),
so the bump keeps new JS away from old binaries.

### 7. Native change, or a new phone: rebuild

```bash
scripts/eas-preflight.sh
scripts/eas-dry-run.sh --linked     # optional: proves it compiles, unsigned, before you spend a build
(cd apps/mobile && eas build -p ios --profile preview)
```

Then reinstall from the new link on each phone. A new build with the same bundle ID
(`dev.youreon.app.eas`) and team installs over the old one, so the app's data and keychain (the
device key, the session, the wallet) survive and the phones stay signed in. That holds only
between EAS builds: the first EAS install after the free-team build starts empty (step 5).

`scripts/eas-dry-run.sh` replays the EAS iOS pipeline on the Mac (5–20 minutes, needs Xcode and
CocoaPods). It starts from eas-cli's own upload copy and runs `npm ci`, `expo prebuild` with an
injected team ID, `pod install`, both hooks and an unsigned `xcodebuild archive`. Then it checks
the `.app` for the bundle ID, the face model's bytes, the inlined API URL and the entitlements.
`--worker-node` uses the worker's Node 22.23.4 and npm 10.9.9. It wipes its work directory
first, so `--out DIR` must be new, empty or an earlier run's; it refuses `$HOME`, the repo and
their parents.

For a new phone: run `eas device:create` for it, then build again. EAS asks to regenerate the
provisioning profile with the new device; say yes. Only the new phone has to install the new
build, but installing it everywhere keeps all phones on one build.

### 8. Profiles, voice on or off, and the freeze build

| Profile         | For                               | Voice   | Update channel  | Bundle ID                 |
| --------------- | --------------------------------- | ------- | --------------- | ------------------------- |
| `preview`       | the phones, day to day            | on      | `preview`       | `dev.youreon.app.eas`     |
| `preview-typed` | the phones, typed terms only      | off     | `preview-typed` | `dev.youreon.app.eas`     |
| `pitch`         | the freeze build for the demo     | on      | `pitch`         | `dev.youreon.app.eas`     |
| `development`   | dev client + Metro, for debugging | (Metro) | `development`   | `dev.youreon.app.eas.dev` |
| `production`    | TestFlight (`eas submit`)         | on      | `production`    | `dev.youreon.app.eas`     |

- All phone profiles are release builds with the JS bundled in, talking to
  https://youre-on.fly.dev. `EXPO_PUBLIC_BUILD` (the profile name) goes into `X-App-Version`.
- **Voice.** The "on" builds still fall back to typed terms when the server has no ElevenLabs
  key or the voice session fails. Use `preview-typed` only to take voice out completely. Switch
  by picking the profile. `eas.json`'s `env` beats EAS environment variables, so `eas env:create`
  cannot override these values.
- **Freeze (Thu 19 Nov, before 20:00 CST).** Run
  `(cd apps/mobile && eas build -p ios --profile pitch)` and install it on the three phones. After that, only publish to it on purpose:
  `scripts/eas-update.sh --profile pitch …`. Updates to `preview` do not reach it.
- The dev client (`eas build -p ios --profile development`, then `npm start -w apps/mobile`)
  installs beside the demo build as "You're On Dev". It loads JS from Metro, and its API URL
  comes from `apps/mobile/.env.local`. It has its own bundle ID, so it also has its own keychain
  and does not share the demo build's wallet. `preview`, `pitch` and `production` share one
  bundle ID, so they replace each other on a phone and keep the wallet. The free-team build
  (`dev.youreon.app`) shares nothing with them: after switching from it, claim the demo
  accounts again (step 5).
- **iOS Simulator:** on an Apple-silicon Mac, a simulator build does not link. The face
  detector's ML Kit frameworks (`MLImage`, `MLKitFaceDetection`) ship only x86_64 and
  arm64-device slices, so `ld` reports "building for 'iOS-simulator', but linking in object file
  … MLImage … built for 'iOS'". Use a phone.

### 9. Troubleshooting

| Symptom                                               | Fix                                                                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `eas-cli … doesn't satisfy >= 27.10.0`                | Use `npx eas-cli@27.10.0` (the `eas()` function in step 0).                                                                                                  |
| Pre-install hook: `face model … is not in the upload` | Make the model (`scripts/face-model.sh`) on the Mac that runs `eas build`. Keep `/.easignore`. Run the preflight.                                            |
| "App ID … is not available" / bundle ID already taken | Another team owns it. Set a new `base.env.IOS_BUNDLE_ID` in `apps/mobile/eas.json` (e.g. `dev.youreon.app.eas2`) and build again.                            |
| The Apple login offers "(Personal Team)"              | Pick the paid team, or `export EXPO_APPLE_TEAM_ID=<paid team id>` first. Personal teams cannot make ad hoc builds.                                           |
| "You don't have any registered devices"               | Do step 3 first.                                                                                                                                             |
| A phone says the app cannot be installed              | It was not registered before this build: `eas device:list`, register it, build again.                                                                        |
| The build waits in the queue for a long time          | That is the Free plan's low-priority queue. Upgrade the account (or the organization) to Starter.                                                            |
| `npm ci` fails on EAS                                 | The preflight's "package-lock.json in sync" line says why. Run `npm install` at the root and commit `package-lock.json`.                                     |
| Xcode fails on `WebRTC/WebRTC.h`                      | The `@livekit/react-native-webrtc` 144.1.2 override is broken. The preflight and the post-install hook both check it.                                        |
| `eas-update` refuses: native code or config changed   | Rebuild (step 7). `npx eas-cli@27.10.0 fingerprint:compare --build-id <id>` shows what changed. `--allow-native-changes` only if you are sure it is JS-safe. |

### How the face model gets to EAS

The app `require()`s `apps/mobile/assets/models/w600k_mbf_float32.tflite`, so Metro needs the
file when it bundles. Without it, the build fails at "Bundle React Native code and images". The
file is gitignored: the InsightFace weights are licensed for non-commercial research only, and
the repo is public. EAS uploads only what eas-cli copies from the Mac, so there were two options:

- **`/.easignore` that lets the model through (chosen).** eas-cli 27.x looks for `.easignore`
  at the **git root**, not in `apps/mobile`. When it exists, eas-cli uses it **instead of every
  `.gitignore`**, and it never reads `.git/info/exclude`. So `/.easignore` repeats every ignore
  rule of the repo, plus `.claude` and local build outputs, and re-includes only the model.
  Because `requireCommit` is unset, eas-cli copies the working tree, including this untracked
  file.
  - Pros: no network or Python on the build worker; the bytes are the ones the preflight
    checked; nothing extra in the build time.
  - Cons: the Mac that runs `eas build` needs the model; `.easignore` must follow every
    `.gitignore` change (a test in `easConfig.test.ts` fails when it does not); the weights sit
    in the EAS upload and in the app file. Both are private to the project, and both were in
    the app anyway.
- **A build hook that makes the model on the worker (not chosen).** It would run
  `scripts/face-model.sh` from `eas-build-pre-install`.
  - Pros: no local file needed.
  - Cons: every build would depend on GitHub, PyPI and a Python 3.12 toolchain on the macOS
    image, adding minutes and a new failure point. It could not be tested here without an Expo
    login.

  The pre-install hook instead checks the uploaded model's size and sha256 against
  `FACE_MODEL`, and fails fast with the fix if it is missing.

A production build would switch to a commercially licensed model, for example OpenCV SFace
(Apache-2.0). See `apps/mobile/assets/models/NOTICE-w600k_mbf.txt`.

### What was verified, and what was not

Verified without an Expo login (Nov 18):

- eas-cli 27.10.0 resolves every profile.
- eas-cli's own upload copy contains the model, and nothing git ignores.
- eas-cli resolves the app as a managed project.
- A local replay of the EAS iOS pipeline, from that copy (npm 10.9.9 `npm ci`, prebuild with an
  injected team ID, `pod install`, both hooks, unsigned `xcodebuild archive` on Xcode 26.6),
  ends in `ARCHIVE SUCCEEDED`. The `.app` has the right bundle ID, the face model byte for byte,
  the Fly URL inlined and no APNs entitlement. With a linked project, `Expo.plist` has the
  update URL, the `preview` channel and runtime `1.0.0`.
- `scripts/eas-update.sh --dry-run` exports a bundle that contains the Fly URL and the model.

Not verified, because it needs the logins: Apple and EAS credentials, device registration, the
real EAS worker, signing, installing on a phone, and publishing an update.

## Free Apple ID on your own Mac

Use this when your iPhone can't be plugged into the lead's Mac, or before the paid account is
approved. A free Apple ID ("Personal Team") can only install on phones that Xcode has seen over
USB at least once, and a bundle ID belongs to exactly one team. So each teammate signs with their
own team and their own bundle ID. These builds keep EAS Update off until `app.json` is linked
to an EAS project, and even then they set no update channel, so EAS updates are not meant for
them: rebuild to change their JS.

### One-time setup (about 15 minutes, plus the Xcode download)

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

### Build and install

```bash
git checkout devnet-launch && git pull && npm ci
ls apps/mobile/assets/models/w600k_mbf_float32.tflite || scripts/face-model.sh
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
- If you prebuilt before Nov 18 and Xcode says "Personal development teams … do not support the
  Push Notifications capability", your `ios/` still has the old `aps-environment` entitlement.
  The app now turns remote notifications off in `app.json`, so run
  `CI=1 npx expo prebuild -p ios --clean --no-install` and `pod install` again.
- Unset `IOS_BUNDLE_ID` and `APPLE_TEAM_ID` (or use a new shell) before you run EAS commands.
  EAS builds are not affected, but `scripts/eas-preflight.sh` points them out.
