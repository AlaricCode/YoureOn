# Verdict reference

Verdict was Alaric's prototype for the same product. On 2026-11-14 the team chose You're On as the base
(see [`docs/MERGE-PLAN.md`](../../MERGE-PLAN.md)). Verdict's specs stay here as design reference. Its code is
not in this tree any more; every file is still on `main` before the merge commit and in git history:

```sh
git show 1d9139c:packages/backend/src/providers/registry.ts
git log --all -- app/lib/screens        # the Flutter screens, used as the UI spec
```

| File | What it is |
|---|---|
| `verdict-spec.md` | Product spec v0.2 (consent-first settlement, trust map, design system §6) |
| `CONTRACTS.md` | Verdict's binding interface contract (rule language §3, encodings §5, perception §6) |
| `CONTRACTS-ERRATA.md` | Implementation decisions against the contract |
| `README.md` | Verdict's README as of 2026-11-08 |

Eva's `enroll-redesign` branch (consent-before-capture enroll) stays as it is. Its flow is rebuilt in `apps/mobile`.
