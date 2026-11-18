# Demo-day runbook

For the operator at the laptop on pitch day. It covers the pre-show checklist, opening the stage,
the REPLAY fallbacks, what to do when something breaks, and settling orphaned bets. The pitch script
is [`pitch.md`](pitch.md); the deploy steps are [`../scripts/deploy-devnet.md`](../scripts/deploy-devnet.md).

**Never paste a secret** (the demo admin token, the stage key, a keypair, a demo-claim QR) into a
slide, a chat or a shared screen. Commands below read them from your shell environment:

```sh
cd UBC-2026
read -rs DEMO_ADMIN_TOKEN && export DEMO_ADMIN_TOKEN   # paste, no echo, no history
read -rs SOLANA_RPC_URL && export SOLANA_RPC_URL       # optional: a devnet RPC for the chain checks
SERVER=https://youre-on.fly.dev
demo() { curl -sS -H "X-YO-Demo-Key: $DEMO_ADMIN_TOKEN" -H 'content-type: application/json' "$@"; }
```

Every `/v1/demo/*` route needs `DEMO_MODE=true` on the server and the `X-YO-Demo-Key` header; without
them it answers 404.

## Known gaps on 2026-11-18

Check these first; each changes the script ([`pitch.md`](pitch.md)).

| Gap                         | Effect                                                                                                                                                                                                               | Check                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| ElevenLabs key pending      | No voice judge: A uses "Type it instead" in Beat 2. The projector still speaks each ruling and payout, in the browser's voice (`Voice: browser` on the strip).                                                       | `demo "$SERVER/v1/demo/voice"`                                      |
| QuickNode key pending       | No Stream: chain events arrive through `rpc_poll`, about 5 s after the send (30 s once a Stream token is set); the stage ticker won't say "via QuickNode Streams". The RPC is not QuickNode's, so it can rate-limit. | `stream.last_delivery_at` in the health report is `null`            |
| Signed iPhone build pending | No phones: run the bets from the laptop with `cp1-drive` (see "No phones" in the pitch).                                                                                                                             | The app is installed and opens on each phone                        |
| Beat 6 rehearsal            | Ran live once on 2026-11-18 (see measurements). Rehearse again on the day; keep `REPLAY 6` and the Gemini replay feed ready.                                                                                         | `GET /v1/demo/health` `gemini.current.lockable`                     |
| Beat 5 appeal rehearsal     | Rehearse it on devnet before showing it ("The appeal (Beat 5)" below); without the appeal key an appealed bet is refunded after 300 s instead of paid.                                                               | `appeal_key` set and no `appeal_key_*` warning in the health report |

## 1. Pre-show checklist (start 60 minutes before)

### Server and chain: one command

```sh
npm run demo-check                          # GO / NO-GO; exit 0 = GO (warnings allowed)
npm run demo-check -- --json                # the same, machine-readable
npm run demo-check -- --warmup              # first warm up (one paid judge call), then check
```

`scripts/demo-check.ts` is read-only (it signs nothing and, without `--warmup`, sends nothing). It
reads `GET /health` (reachable, latency, clock skew) and, with `DEMO_ADMIN_TOKEN`,
`GET /v1/demo/health`, including the judge (last success and failure, p50 / p95) and the
`cached_ruling` toggle. With `--warmup` it first calls `POST /v1/demo/warmup` (see "Warm-up"
below) and adds one `warmup.*` line per dependency. With `SOLANA_RPC_URL` set it also checks the
chain directly: the program is deployed, Config exists and is not paused, the fee payer's SOL, the
nonce accounts, the demo wallets' USDC, and live bets past a deadline. With `QN_API_KEY` and
`QN_STREAM_ID` set it reads the Stream's status. Every failed check prints its fix.

| Check                  | GO                              | Warn                                    | What to do                                                                          |
| ---------------------- | ------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------- |
| `/health` round trip   | ≤ 1.5 s                         | ≤ 4 s                                   | Slow network or a cold machine: `fly machine list -a youre-on`                      |
| Clock skew             | < 10 s                          | < 45 s                                  | Fix the laptop clock; requests are signed with a 60 s window                        |
| Fee payer SOL          | ≥ 1 SOL                         | ≥ 0.1 SOL                               | A human tops up `ADEMopwqe6cVs9cEyMSbK1pGsJgnyBc3zkC3Wsqf9pQ8` from the bank wallet |
| Free nonces            | ≥ 2 of 5                        |                                         | See "Nonce pool" below                                                              |
| demo-a / demo-b USDC   | ≥ $5 each                       | ≥ $1 each                               | `POST /v1/demo/rebalance`, then `npm run fund` from the treasury                    |
| RPC p95                | ≤ 1.5 s                         | ≤ 4 s                                   | See "RPC rate-limited" below                                                        |
| Gemini relay           | a good poll < 2 min ago         |                                         | See "Gemini is down" below                                                          |
| Judge (`server.judge`) | a success since boot, p95 ≤ 8 s | no success yet, or the last call failed | `npm run demo-check -- --warmup`; still failing: see "The judge is slow or wrong"   |
| `server.cached_ruling` | off                             | on                                      | Fine for a staged flip; otherwise turn it off (see "The judge is slow or wrong")    |

### The health report

```sh
demo "$SERVER/v1/demo/health" | jq '{ok, warnings, lock_signer, fee_payer_sol, nonce_pool,
  balances, rpc_stats, keeper, inflight, stuck_bets, escrow, stream, gemini, toggles, judge_llm,
  build}'
```

- `ok` is false when any warning is critical. Read every `warnings[]` entry: each has a `code`, a
  `level` and a message with the fix. Critical codes include `escrow_paused`, `config_missing`,
  `rpc_unreachable` and `keeper_task_stuck`.
- `lock_signer`: `phones` (each phone signs after Face ID) or `server` (the server signs with the
  custodial demo keys).
- `nonce_pool`: `size`, `free`, `leased`, `advancing`, `retired`. `inflight.stuck` lists sent
  transactions older than 2 minutes; `stuck_bets` lists bets that are not moving.
- `escrow`: orphaned escrow (bets on chain whose row is gone or terminal). See section 5.
- `build`: which image and machine answered, to confirm the deploy you expect.
- `toggles`: `cached_ruling` and whether it comes from the env (`CACHED_RULING`, the boot default)
  or was set at runtime. `judge_llm`: the judge's calls since boot (rulings and warm-ups): the last
  success and failure, p50 / p95, the provider (`live` or `mock`) and the model. These are in
  memory: a restart starts them again, which is why `judge_no_success` (a warning, not critical)
  shows until the first call. `judge_failing` means the last call failed after the last success;
  `cached_ruling_on` that every ruling is the stored verdict.

### Warm-up (10 minutes before the pitch)

```sh
demo -X POST "$SERVER/v1/demo/warmup" -d '{}' | jq '{ok, notes, checks}'
```

It makes no bet and moves no money. It runs four checks in parallel; each answers `ok`, `ms` and
`error`:

- `judge`: one live Claude call with the real prompt and output schema on a stored 16 px JPEG. It
  always calls the live judge, even while `cached_ruling` is on, and counts in `judge_llm`. Its
  verdict is meaningless (`UNCLEAR` is normal); `ok` means Claude answered in the ruling's schema.
- `rpc`: `getLatestBlockhash` on the server's RPC.
- `gemini`: one poll of the Gemini relay and its current contract (`lockable`, `refusal`).
- `voice`: whether the voice judge is configured (no token is minted: that would start a billed
  session). Until the ElevenLabs key lands this is `ok: false` and A types the terms.

`notes` says when a check did not exercise the real thing: `LLM_PROVIDER=mock`, the cached ruling,
the REPLAY feed. The server allows one warm-up per 10 s (429 with `Retry-After` otherwise): each is
a paid call.

### Head-to-head history (once, after the phones are claimed)

The face-match reply on A's phone says "You're 4-7 against Jake" from the head-to-head record.
Seed it once demo-a and demo-b have accounts (the phones are claimed, or `cp1-drive` signed them
up):

```sh
demo -X POST "$SERVER/v1/demo/seed-h2h" -d '{}' | jq '{inserted, replaced, head_to_head}'
demo -X POST "$SERVER/v1/demo/seed-h2h" -d '{"a_wins": 4, "b_wins": 7}'   # the same, explicit
demo -X POST "$SERVER/v1/demo/seed-h2h" -d '{"a_wins": 0, "b_wins": 0}'   # remove the history
```

- The rows are demo history, labelled `is_seed` (titles "Demo history: …"): 11 settled bets with
  no on-chain footprint, one a day in the past, so the record reads 4-7 and −$7.00 for demo-a.
  The phones' history lists them, flagged `is_seed`.
- Re-running replaces the old seed rows (it never doubles them). `POST /v1/demo/reset` keeps them.
- 409 `demo_player_missing`: that demo wallet has no account yet; claim its phone first.
- Live bets between A and B add to the record as they settle.

### Reset between rehearsals

```sh
demo -X POST "$SERVER/v1/demo/reset" -d '{"rebalance": true}'   # back to a clean demo pair
demo -X POST "$SERVER/v1/demo/rebalance" -d '{}'                # even out demo-a / demo-b only
demo -X POST "$SERVER/v1/demo/sweep" -d '{}'                    # run every money sweep now
```

- **Reset** pauses the keeper, advances every leased nonce (a lock in flight can no longer land),
  returns the escrow of every rehearsal bet (a Locked one gets `resolve(Refund)` from the judge key
  and is finalized after the 10 s window; an Open one is cancelled), re-syncs the nonce pool from the
  chain, deletes the non-seed bets, and resumes the keeper. Users, devices, sessions, rooms and face
  enrollments are kept, so the phones stay signed in. With `rebalance: true` it evens out the demo
  wallets once the refunds have landed.
- **Rebalance** moves USDC from the richer demo wallet to the poorer, paid by the fee payer. It
  answers 409 `rebalance_in_flight` while an earlier one may still land, and refuses while a bet of
  the demo pair is about to lock.
- **Sweep** runs the boot reconcile and the orphan scan now and returns the health report.

### Nonce pool

The lock uses one of 5 durable nonces, `yo-nonce-0` … `yo-nonce-4`, owned by the fee payer. Two
free nonces are enough for the demo. If `free` is low:

1. `demo -X POST "$SERVER/v1/demo/reset" -d '{}'` (advances leased nonces and re-syncs the pool).
2. Still low? `inflight.stuck` / the `nonces_stuck` warning says which nonce is stuck; the keeper's
   lock sweep settles it within a few ticks.
3. Missing accounts: a human runs `npm run nonce-pool -- --database-url "$DATABASE_URL"`
   with the fee-payer key (`scripts/deploy-devnet.md` step 9). It creates only the missing ones and
   spends devnet SOL.

### Money

- Fee payer: ≥ 1 SOL. Party wallets, the judge, the appeal key and the treasury hold 0 SOL; never
  send SOL to a party wallet.
- USDC: each demo wallet ≥ $5 (a few $1–$2 rehearsals), treasury ≥ $20. Top-ups:
  `npm run fund -- --dry-run`, then `npm run fund` (needs the treasury key; a human runs it). Circle's
  faucet (faucet.circle.com, "Solana Devnet") gives 20 USDC per address per 2 hours.

### Phones and room

- Sign the phones in as the demo players: `npm run demo-claim-qr -- --party a --base-url $SERVER`
  (and `--party b`), scanned on each phone's "Demo account" screen. Each QR is single-use, lasts 10
  minutes and unlocks a wallet seed: show it only to the phone.
- Force-quit and reopen A's app before the pitch (a second voice session in one app launch can come
  up with a silent mic). Face ID permission accepted, Low Power Mode off, Wi-Fi off (cellular),
  passcodes known, B's app in the foreground.
- Judge cam on its tripod, 1–1.5 m from the landing spot, the bottle's cap taped. It is a third
  iPhone claimed as party `a` with Profile → Judge cam on (`docs/IOS-BUILD.md`).
- **Two phones only:** decide before the pitch. With no working third phone, leave Judge cam off
  (or turn it off on that phone in Profile). The non-performer's phone films instead: A's in the
  demo, since B flips. A's Start, or the voice judge's `request_attempt`, arms A's camera with the
  same 3-2-1; A holds it landscape, 1–1.5 m from the landing spot with the whole table in the
  shot, and taps Stop a beat after it lands. The recording has no audio, so the voice judge keeps
  A's mic. Camera permission must already be granted on A's phone (the face scan asks for it). If
  A performs, B's phone has Start and films. A judge cam left on but dead still gets the attempt
  (the server has no liveness check on it): turn it off on that phone, or play REPLAY `4`.
- Phone A creates the room; its 6-character code goes into the stage URL.
- Pick the pitch start time for the Bitcoin closer: about 1:05 after a five-minute mark
  ([`pitch.md`](pitch.md#timing-the-closer-beat-6)).

### The appeal (Beat 5)

Optional, and built without the hearing. The loser of a decisive ruling taps **I appeal!** (Face
ID, no hold) on the ruling screen before the last second of the 10 s window. Claude, GPT and Gemini
vote on the same frames (8 s each at most); two agreeing votes decide, anything else (a tie, all
abstaining) upholds the ruling. The appeal key then pays with `resolve_appeal`, about 1 s later.

- **Needs:** migration 0008 applied (the `appeals` tables); `APPEAL_AUTHORITY_SECRET_KEY` on Fly,
  equal to Config's `appeal_authority` (health: `appeal_key`, warnings `appeal_key_missing` /
  `appeal_key_mismatch`); for real votes `LLM_PROVIDER=live`, `ALLOW_SPEND=true` and
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`. A vendor without its key
  abstains; with no key at all every vote abstains and the ruling stands. `CACHED_RULING` does not
  replay the panel.
- **From the laptop** (`LOCK_SIGNER=server`, the custodial demo): right after `RULED`,
  `demo -X POST "$SERVER/v1/demo/bets/$BET/appeal" -d '{}'` files the losing demo party's appeal
  (`{"party":"A"}` only for a VOID ruling). It answers 202 `{status, signature, appeal_id}`, or
  `APPEAL_WINDOW_CLOSED` after `appeal_deadline − 1 s`. The admin route is not rate-limited.
- **Driver:** `npm run cp1-drive -- --base-url $SERVER --through paid --appeal` runs a whole bet,
  appeals as the loser inside the window, prints the three votes and the result, and waits for
  `PAID via resolve_appeal`.
- **Rate limit:** 3 appeals per hour per player (the phones and `cp1-drive`), held in memory on the
  one machine (a restart clears it). Rehearse with the admin route, or keep the last hour's player
  appeals under 3 before the pitch.
- **If it stalls:** `stuck_bets` lists an `APPEALED` bet; the keeper's `appeal-sweep` re-runs a lost
  panel and resends a failed `resolve_appeal`. Past `appeal_resolve_deadline` (300 s after the
  appeal) the timeout-refund keeper returns both stakes (`EXPIRED`, `appeal_timeout`).

## 2. Opening the stage

```
https://youre-on.fly.dev/stage/?room=<CODE>#key=<STAGE_KEY>
```

- `<CODE>`: the room's 6-character code from phone A (or the room's uuid).
- After `#` (the fragment, never sent to any server or its logs): `key` is the `STAGE_KEY` (it is
  exchanged for a stage token). The page reads it and removes it from the address bar. A secret
  put in the query (`?key=`) is ignored, and the form says so.
- The health strip needs no admin key: the page reads `/v1/demo/health` with its own stage token
  (`DEMO_MODE=true`). The old link with `&demo=<DEMO_ADMIN_TOKEN>` still works, but keep the admin
  key off the projector.
- Optional query: `bet=<id>` pins one bet until it is over; `nopreload` turns off the REPLAY
  download.
- A reload of the same tab comes back to the same card without the URL (session storage).
- Never open `?preview` during the pitch: it is sample data.

| Key       | Does                                               |
| --------- | -------------------------------------------------- |
| `F`       | Full screen                                        |
| `M`       | Mute / unmute (the first key press unlocks audio)  |
| `V`       | Judge voice off / on (sounds keep playing)         |
| `Q`       | QR of the latest lock or payout on Solana Explorer |
| `H` / `?` | Key help                                           |
| `1`–`6`   | REPLAY clip of that beat                           |
| `Esc`     | Close any overlay                                  |

The bottom strip shows demo health: fee-payer SOL, free nonces, RPC and DB latency, and how many
REPLAY clips are cached. The ticker header says "via QuickNode Streams" only for events the Stream
delivered.

**Press any key once the page is up**: browsers keep audio locked until then, and the judge's voice
is part of the show. The projector speaks every ruling, payout and appeal vote, except in a bet the
voice judge is hosting: once A's phone has relayed one judge line for a bet, the judge on A's phone
announces that bet's ruling and payout, and the projector stays quiet for them (no clip, no browser
voice). Two judges talking over each other would be noise, and the hall's sound would reach A's
speakerphone. Nothing to press: the projector follows each bet by itself, and still voices appeal
votes. The strip's `Voice` item says whose voice it is:

| `Voice`                           | Meaning                                                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `ElevenLabs`                      | The server voices the stage (`ELEVENLABS_API_KEY` and `ALLOW_SPEND=true` on Fly): each line is an ElevenLabs clip.                       |
| `ElevenLabs (last line: browser)` | The last clip did not come in time (or failed), so the browser said that line. Check `stage_voice.tts_failed` in `fly logs -a youre-on`. |
| `browser`                         | No key yet, or `STAGE_TTS=off`: the browser's voice says the same lines, about 0.8 s after each moment.                                  |
| `… (last line: phone judge)`      | The last line was a ruling or payout of a bet the voice judge hosts: A's phone said it, the projector stayed quiet on purpose.           |
| `off (V)`                         | Turned off with `V`.                                                                                                                     |

Use the laptop's speakers or the hall's sound, not a phone: A's phone is busy with the voice judge.

## 3. REPLAY fallbacks

| Key | Clip                           | Use when                                                                    |
| --- | ------------------------------ | --------------------------------------------------------------------------- |
| `1` | `beat1.mp4`: challenge by face | The scan won't match and the room list isn't an option                      |
| `2` | `beat2.mp4`: terms by voice    | The voice judge fails mid-beat                                              |
| `3` | `beat3.mp4`: lock it in        | The lock can't land (RPC, nonce, funds)                                     |
| `4` | `beat4.mp4`: the attempt       | The judge cam or the ruling fails                                           |
| `5` | `beat5.mp4`: dispute           | Only if a clip of a built flow exists (the hearing and panel are not built) |
| `6` | `beat6.mp4`: the closer        | Gemini can't price or settle in time                                        |

- The clips are **not in git**. Put them in `apps/stage/public/replay/` as `beat1.mp4` … `beat6.mp4`
  before `fly deploy`; the image serves them at `/stage/replay/beat{n}.mp4`. Check each one:
  `curl -sI $SERVER/stage/replay/beat1.mp4` should answer 200. A missing clip is skipped.
- Encode for a fast start and keep each under about 30 MB (`apps/stage/public/replay/README.txt`).
- The stage downloads each clip once in the background and plays it from memory. The download holds
  while a live bet is in progress; the bottom strip shows cached / loading / paused. Let it finish
  before you walk on.
- Every replay is labelled REPLAY on screen. Say "here's the replay" out loud.

## 4. When something breaks

### The RPC is rate-limited (429s, slow locks)

Symptoms: an RPC warning in the health report, `rpc_stats` p95 over 1.5 s, locks taking longer than
the usual 4–5 s, 429s in `fly logs -a youre-on`.

- The server already retries, and the stream-gap poll stops at the first 429 so it never competes
  with the money path. Give a lock 10–15 s before you call it.
- During the pitch: don't touch the config. Fill the time, or press `3`.
- Before the pitch: point the server at a dedicated devnet RPC (the QuickNode endpoint once its key
  exists): `fly secrets set SOLANA_DEVNET_RPC=… SOLANA_DEVNET_WS=… -a youre-on`. Setting a secret
  restarts the machine. Timers and nonce leases come back from the database, but run
  `npm run demo-check` again afterwards.
- Congestion rather than rate limits: `CU_PRICE_MICROLAMPORTS` adds a priority fee to the
  server-only transactions (resolve, finalize, refunds), never to the phone-signed lock.

### Gemini is down, or has no usable book

Symptoms: the phone's "Bet on Bitcoin" shows Gemini's refusal reason (no two-sided quote, spread
too wide, too close to expiry) or counts down to the next round. In the health report, `gemini`
shows `last_ok_at`, `last_error`, `feed_mode` and the current contract with its `refusal`.

- Too close to expiry (under 2:00 left): wait for the next round, or do Beats 1–4 first.
- Gemini's API is down or the book is empty: switch the relay to the labelled replay of a recorded
  real round, then lock as usual:

  ```sh
  demo -X POST "$SERVER/v1/demo/gemini" -d '{"feed": "replay"}'
  demo -X POST "$SERVER/v1/demo/gemini" -d '{"feed": "live"}'    # back to live afterwards
  ```

  Everything is prefixed `REPLAY-` (tickers, the stage, the phones, the terms hash); say "replay".
  A bet settles from the feed it was quoted on, so switching back later does not affect it.

- Not enough time left in the pitch: press `6`.
- A Gemini contract that never settles leaves its bet waiting; the program's `timeout_refund`
  (anyone, one hour after the lock) refunds both. Nothing to do on stage.

### The judge is slow or wrong

The vision call has a 10 s deadline. A timeout, a model error, low confidence or a disagreement
with the deterministic checks is a REDO ("Run it back"); a third REDO voids the bet and refunds
both.

- A REDO on stage: flip again. That is the judge refusing a verdict it can't confirm.
- Check the judge first: `demo "$SERVER/v1/demo/health" | jq .judge_llm` (the last failure says
  why), or warm it up: `demo -X POST "$SERVER/v1/demo/warmup" -d '{}' | jq .checks.judge`.
- Rulings slow or flaky: switch on the cached ruling at runtime. It takes effect on the next
  ruling, with no restart and no deploy:

  ```sh
  demo -X POST "$SERVER/v1/demo/toggles" -d '{"cached_ruling": true}'    # on
  demo -X POST "$SERVER/v1/demo/toggles" -d '{"cached_ruling": false}'   # off (the live judge)
  demo -X POST "$SERVER/v1/demo/toggles" -d '{"cached_ruling": null}'    # back to the env default
  demo "$SERVER/v1/demo/toggles"                                         # what is on now
  ```

  The ruling then comes from a stored verdict with no model call (always "landed", B wins); it
  still commits to the hashes of the frames actually uploaded, and pays out on chain as usual.
  Every such ruling carries `model: "cache/demo-bottle@1"` in its payload. Use it only for a
  staged clean flip. The stage labels it "replay ruling" on the ruling panel; say it out loud
  too ("cached ruling"). Each switch is
  in the audit log (`demo.toggle`) and `/v1/demo/health` shows `toggles` and the
  `cached_ruling_on` warning while it is on.

- A runtime switch lasts until the machine restarts (a `fly secrets set`, a deploy, a crash); then
  the env `CACHED_RULING` in `fly.toml [env]` (`"false"`) applies again. To make it survive a
  restart, set `CACHED_RULING = "true"` there and `fly deploy` from a checkout of the deployed
  commit (a deploy ships whatever is checked out).

### The voice judge fails

A failed voice session ends cleanly on A's phone, and the negotiate screen offers "Type it
instead": the typed terms go through the same evaluation, guardrails and terms card. If A's mic
went silent after an earlier session, force-quit and reopen A's app. If the judge failed before it
said anything, the projector speaks that bet's ruling and payout. If it had already spoken, the
projector still leaves them to the phone (it can't tell the session dropped), so read the ruling
off the stage.

### Face match fails

Step within about 1 m, face the light. Otherwise challenge B from the room list: the match only
ever addressed the challenge.

### A phone can't sign

The lock waits for both signatures until its deadline, then expires and advances the nonce, so the
signatures are useless and nothing moved. Retry from the terms card. As a last resort before the
pitch (not during), set `LOCK_SIGNER=server` (`fly secrets set LOCK_SIGNER=server -a youre-on`,
which restarts the machine): the server signs with the demo keys, and the stage words the signature
slots "demo key" instead of Face ID. It needs `DEMO_A_SECRET_KEY` and `DEMO_B_SECRET_KEY` on the
server (`custodial.a` and `custodial.b` in the health report are not null).

## 5. Settling orphans: `scripts/crank.ts`

An orphan is escrow on chain whose bet the server no longer tracks (a reset deleted the row, or the
row is terminal but the Bet was never closed). The server handles them itself: the keeper's
`orphan-escrow` sweep runs every 60 s, and `timeout-refund` refunds any bet past its deadline.
`POST /v1/demo/sweep` runs both now. Use the crank when the server is down or you want to settle one
bet by hand.

The crank is permissionless: any funded key pays the fees and gets nothing else; rent goes back to
each Bet's stored rent payer (our fee payer); payouts go only to the two parties.

| On-chain status                | Due when                              | The crank sends               |
| ------------------------------ | ------------------------------------- | ----------------------------- |
| Open                           | at or after `accept_deadline`         | `timeout_refund`, `close_bet` |
| Locked                         | at or after `resolve_deadline`        | `timeout_refund`, `close_bet` |
| Appealed                       | at or after `appeal_resolve_deadline` | `timeout_refund`, `close_bet` |
| Resolved                       | at or after `appeal_deadline`         | `finalize`, `close_bet`       |
| Settled / Refunded / Cancelled | (left unclosed)                       | `close_bet`                   |

```sh
# 1. Look first: lists every Bet and what is due; sends nothing.
npm run crank -- --url "$SOLANA_RPC_URL" --devnet --payer <funded-keypair.json> --dry-run

# 2. Settle only specific bets (comma-separated Bet PDAs from the dry run):
npm run crank -- --url "$SOLANA_RPC_URL" --devnet --payer <funded-keypair.json> --only <pda1>,<pda2>

# 3. Or settle everything due except some (e.g. a bet the server is about to settle itself):
npm run crank -- --url "$SOLANA_RPC_URL" --devnet --payer <funded-keypair.json> --skip <pda1>
```

- `--devnet` is required for any public cluster; mainnet is always refused.
- Each sent transaction prints its Explorer link; the run fails if any bet could not be cranked.
- Prefer `--only` while the server is up, so you never race its own sweep on a bet it is settling
  (a race costs a fee, never money: the program makes every exit exclusive).
- A bet that is not due yet is skipped. Before its deadline only the two parties and the bet's
  judge or appeal key can move it.

## 6. After the show

- `demo -X POST "$SERVER/v1/demo/reset" -d '{"rebalance": true}'`.
- Pause the Stream once it exists, to save credits: `npm run qn-stream -- pause <stream id>`.
- Switch the Gemini relay back to live if you used the replay.
- Turn the cached ruling off if you switched it on
  (`demo -X POST "$SERVER/v1/demo/toggles" -d '{"cached_ruling": null}'`), and put
  `CACHED_RULING` and `LOCK_SIGNER` back if you changed them.
