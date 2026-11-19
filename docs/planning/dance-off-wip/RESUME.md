# Resume here: Dance Off + Jarvis (paused 2026-11-18 evening)

Branch: `feat/dance-off`, local only and NOT pushed. It was branched from main `44b00ef`. Everything is in a
single WIP commit. Nothing has been compiled, typechecked or tested, because no heavy commands could run
during class. The only things that ran were the shared scorer test file and the routine generator.

Deadline: code freeze is Thu Nov 19, 20:00 CST.

## Where things stand

| Piece | State |
|---|---|
| Design contract | `docs/planning/DANCE-OFF.md`. This is the source of truth. |
| Shared: scorer, tracker, terms, evidence, 3 synthetic routines | Built and reviewed. The fix pass was interrupted. |
| Server: `/terms/dance`, `/attempts/:n/dance`, Claude validator, ruling, `/rematch` | Built and reviewed. The fix pass was interrupted. |
| Native `apps/mobile/modules/dance-pose` (Swift, Apple Vision live pose and recording) | Built and reviewed. The fix pass was interrupted. |
| Mobile bet flow (Dance panel, routes, upload, Double-or-nothing) and dance screens (`src/dance/`) | Built and reviewed. The fix pass was interrupted. |
| Stage support | Built and reviewed. The fix pass was interrupted. |
| `tools/dance-ref` macOS CLI | Built and reviewed. The fix pass was interrupted. |
| Jarvis: `apps/mobile/modules/wake-word`, `src/wake/` (detector, hook, RainbowLoop) | Built, reviewed and fixed. **Not wired into the app yet.** |
| Alaric's PR #13 (SAM 3.1 camera checks) | **Merged into main on GitHub (`a796ff1`)**. Not yet merged into this branch. |

The builder reports and all 24 review findings (2 blocker, 6 major, 16 minor) are in
`BUILD-REPORT.md` and `JARVIS-REPORT.md` in this folder. The fixers were stopped partway through, so some
findings may already be fixed. Re-verify each one against the code.

## Next steps, in order

1. **Finish the Dance Off fix pass.** Resume the workflow in Claude Code. The cached build and review steps
   replay instantly and only the fixers run again:
   `Workflow({scriptPath: "/Users/loganstaples/.claude/projects/-Users-loganstaples-dev-hackathons-ubc26-UBC-2026/6122719e-dfeb-48a6-92fe-3391fe06c61f/workflows/scripts/dance-off-build-wf_9afc6ab2-9e9.js", resumeFromRunId: "wf_9afc6ab2-9e9"})`
   If that session is gone, ask Claude to work through `BUILD-REPORT.md` → "Review findings".
2. **Merge Alaric's main.** Run `git fetch https://github.com/AlaricCode/UBC-2026.git main:refs/remotes/gh/main && git merge gh/main`.
   Expect conflicts in `apps/server/src/judge/routes.ts`, `apps/server/src/lock/terms.ts`, `packages/shared/src/realtime.ts`,
   `apps/stage/src/{App.tsx,ticker.ts,view.tsx,stage.css}`, `.easignore` and `packages/shared/test/review.test.ts`.
   You must also:
   - exclude `dance_off` from camera checks. `scheduleCompile`, `scheduleCompileCurrent` and `onTermsFrozen` in
     `apps/server/src/judge/camera-checks.ts` gate only on `evidence_source === 'camera'`, and dance offs are camera bets;
   - skip `runAttemptChecks` and `warmForAttempt` for dance attempts;
   - keep both `checks.*` and `dance.scored` in the realtime union.
3. **Wire up Jarvis.** DONE (commit "mobile: Jarvis wake word + rainbow loop wired in"): gating rules in
   `apps/mobile/src/app/wakeGate.ts` (+ tests), the hook / loop / Tap to talk in `DemoApp.tsx`, the first user
   message in `voice/session.ts` (`initialUtterance`), preview entries `jarvis` / `jarvisDenied`.
   `EXPO_PUBLIC_WAKE=off` restores the old auto-start. Not compiled or run yet (step 4). The original list,
   from `JARVIS-REPORT.md` under each "INTEGRATION" list:
   - Add `NSSpeechRecognitionUsageDescription` to `apps/mobile/app.json` under `ios.infoPlist`. This is required.
   - In `apps/mobile/vitest.config.mts`, add `'modules/**/*.test.ts'` to `include`.
   - Add the `spectrum` exception to `ui/tokens.ts`.
   - Mount `useWakeWord` once in DemoApp. It should be enabled only on challenge screens and never while the
     LiveKit judge is live.
   - Gate the JudgeVoice auto-start on the wake word, with a "Tap to talk" fallback. Pass the captured sentence
     to the judge as its first user message (`sendUserMessage`).
   - Mount `<RainbowLoop>` as the last child of the app root.
   - On Home, saying "Jarvis" starts a challenge.
   - Add `wake` to `SCREEN_DIRS` in `cryptoCopyAudit.test.ts`, and add preview and maestro entries.
4. **Verify (heavy, so do it when you can).** Run `npm run typecheck`, then `npm test`, then
   `npx tsx scripts/dance-routine.ts selftest`. Then rebuild native with
   `cd apps/mobile && npx expo prebuild -p ios --clean && (cd ios && pod install)` and a device build,
   because there are two new local Swift modules. Then run `cd tools/dance-ref && swift build`.
5. **Device QA.** Check:
   - framing check;
   - count-in and sync;
   - self-score about 100;
   - standing still about 0;
   - 20 head-to-head rounds;
   - Dance Off → Double or nothing → typed throw;
   - "Jarvis, I bet …" → rainbow → judge.
6. **Content.** Record 3 reference videos and make royalty-free or ElevenLabs Music tracks, with no
   copyrighted songs. Then run `tools/dance-ref` and `scripts/dance-routine.ts import` (see
   `tools/dance-ref/README.md`). Until then the routines are synthetic and the phone shows a skeleton reference.
7. **Before turning Alaric's checks on in production,** apply migration `0009_camera_checks` to Neon and set the Fly
   secrets listed in PR #13.
