# @verdict/backend

Node ≥ 20, TypeScript ESM, Fastify + `ws`. Implements `docs/CONTRACTS.md` §12–§13 on top of `@verdict/engine`.

```
npm start -w packages/backend     # creates ./.env (repo root) with generated keys on first run
npm test  -w packages/backend     # vitest, offline, all mocks, no ALLOW_SPEND
```

## Layout

| Path | What |
|---|---|
| `src/config/` | §13 table (`schema.ts`), `loadConfig`, spend guard (`spend.ts`), `.env` parsing + key generation (`dotenv.ts`) |
| `src/errors.ts` | §12.8 codes → fixed messages, `ApiError`, HTTP statuses |
| `src/persistence/` | `JsonStore` collections under `DATA_DIR/db`, `BlobStore` (`chunks/<bet>/<witness>/<index>`, `exhibits/<bet>/<eid>`), record types |
| `src/auth/` | login nonce + wallet signature (§12.1), users bound to one wallet, bearer sessions |
| `src/tx/` | sign payloads + `POST /tx/:id/submit` (§12.1); `ctx.txs.request(...)`, `ctx.txs.onConfirmed(kind, hook)` |
| `src/chain/` | `ChainClient` interface, IDL-driven message builder, typed instruction builders (`ixs.ts`), mock chain (engine `chainModel`), devnet skeleton, §12.5 event handler + QuickNode HMAC |
| `src/ws/` | §12.4 hub: topics, snapshots (`setSnapshotProvider`), `scene.frame`/`recording` handlers, ping/idle |
| `src/providers/` | interfaces for every §13 provider, deterministic mocks, paid providers (spend-guarded), registry |
| `src/keeper/` | §12.6 scheduler (`ctx.keeper.register(task)`) |
| `src/routes/` | route modules; `auth`, `tx`, `wallet`, `webhooks`, world reads are implemented; `identity`, `huddles`, `bets`, `booth`, `world` (rest) are **stubs with TODOs** for the service agents |

Service agents: replace the `stub(...)` calls in your route module, register chain triggers with
`ctx.events.on(name, fn)`, keeper tasks with `ctx.keeper.register`, and WS snapshots with
`ctx.hub.setSnapshotProvider`. Tests build an in-memory app with `test/appHelpers.ts` (`makeApp`, `login`).
