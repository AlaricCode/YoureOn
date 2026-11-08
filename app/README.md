# Verdict app (Flutter)

iOS + Android client for the Verdict backend (`docs/CONTRACTS.md` §12).

```
flutter pub get
flutter analyze && flutter test
flutter run --dart-define=VERDICT_API=http://10.0.2.2:8787   # backend root, without /v1
```

## Layout
| Path | What |
|---|---|
| `lib/contracts/` | §0.5 constants (`npm run gen:dart` target), §12.8 error messages |
| `lib/core/` | LE bytes, base58, money/duration formatting (§12.9, §2.8), state labels |
| `lib/crypto/` | ed25519 keys, domain-tagged messages (login, accept_sig, chunk sig) |
| `lib/wallet/` | passkey-gated embedded wallet (§12.1, D-10), per-bet witness keys, sign→submit loop |
| `lib/api/` | typed client for every §12.3 route + §12.2 shapes |
| `lib/ws/` | §12.4 WebSocket client (re-subscribe, ping, backoff) |
| `lib/evidence/` | §7.2 hash chain, §7.3/§7.4 Merkle, WAV/MJPEG bodies, chunkers, uploader, audio/camera witnesses |
| `lib/beacon/` | §7.5 payload, CRC, 16-FSK synthesis, playback schedule |
| `lib/capture/` | camera + ML Kit face capture, microphone clips, JPEG ≤ 640 px |
| `lib/ui/` | design tokens (§12.12), theme, widgets (`DataText` marks data vs. copy) |
| `lib/nav/` | routes (§12.13), `screen_table.dart` maps routes to screens |
| `lib/screens/` | Sign in, Enroll, Home |

## Notes
- Server-built absolute URLs under `/v1/` (`upload_url`, `audio_url`, `wav_url`, `sfx_url`, `yaml_url`) are rebased onto `VERDICT_API` (`ApiTransport.resolve`), so the backend's default `PUBLIC_URL` (`127.0.0.1`) does not break device or emulator runs. `PUBLIC_URL` only matters for other clients and server-side consumers.
- Background: WS `notify` titles become local notifications while the app is backgrounded ([D-29], `flutter_local_notifications`); a reminder is scheduled ahead of a pending consent deadline; on resume the app re-fetches bets. Scene check, Huddle and Record keep the screen on (`wakelock_plus`) and release/reopen the camera on pause/resume. Keep witness phones in the foreground: leaving Record mid-recording finalizes this phone's witnesses.
- Cleartext HTTP is allowed in debug/profile builds only (`src/debug`, `src/profile` manifests).
- Google sign-in is the offline mock (`credential = "mock:<email>"`); a real Google SDK is not wired.
- Camera witnesses record MP4 segments without an audio track; the phone's audio witness provides the beacon offset (§7.5).
- `test/copy_rule_test.dart` enforces the copy rule on every route in `screen_table.dart`.
- Fonts: Inter 400/600 (SIL OFL, `assets/fonts/OFL.txt`).
