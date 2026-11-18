# You're On: Devpost submission

Drafts of the Devpost answers, the technologies, the program IDs and the bounty write-ups. Every
claim here is meant to be true of the code in this repo; the
[README](../README.md#status-honestly) has the same status table. Fill in the TODOs before
submitting.

**Tagline:** Bet your friends on anything you can film. An AI judge rules, the loser's GG settles
it, and a Solana escrow pays out.

**Tracks and bounties:** Consumer Applications; Best use of Solana; ElevenLabs; QuickNode Streams;
Gemini Prediction Markets.

**Links:** repo TODO · demo video TODO · live server https://youre-on.fly.dev · program
[`BL3gwTBcftGQFdPNp7rZiAyDojkSusdAJ2dzNvFouwcp`](https://explorer.solana.com/address/BL3gwTBcftGQFdPNp7rZiAyDojkSusdAJ2dzNvFouwcp?cluster=devnet)

## What did you build?

You're On is an iPhone app for betting your friends on anything you can film, plus a stage view for
the room. You point your phone at a friend to challenge them. You say the bet out loud, and a voice
judge (an ElevenLabs agent) asks the edge-case questions and reads the terms back. Each of you
confirms on your own phone with hold-to-confirm and Face ID, and both stakes move into a Solana
escrow in one transaction. A judge-cam iPhone films the attempt, Claude rules on the frames, and the
loser taps GG (or stays silent for 10 seconds) and the winner is paid in USDC. For real-world bets,
Gemini's Bitcoin 5-minute prediction market sets fair stakes from its live odds and settles the bet.

Under the hood it is an Anchor escrow program on Solana devnet (12 instructions, SPL USDC vaults,
an atomic durable-nonce lock), a Hono server on Fly with Postgres, an Expo iPhone app, and a
projector page that shows the bet, the judge's words and every on-chain event live.

Where it stands (2026-11-18): the escrow, the server, the atomic lock, the live Claude ruling and
the GG / finalize payouts run on devnet (10/10 soak runs). The voice judge and the QuickNode Stream
are built and waiting on their API keys, the iPhone app is waiting on its signed build, the
Bitcoin closer is built and tested but not yet run live, and the spoken hearing and appeal panel
are not built. See "Honest status" below.

## What problem does it solve?

Friends bet each other every day: a bottle flip, a free throw, who finishes first. It all runs on
trust. Nobody wrote down the terms, the shot is argued about, and the $5 is forgotten or resented.
The tools that could enforce it don't fit: betting apps don't take "bet you can't land this", and
crypto escrow means wallets, seed phrases and gas.

You're On makes a handshake enforceable in seconds. The terms are precise because the judge asks
the questions friends skip. Neither side can back out of a locked bet, because the stakes sit in an
escrow that only pays the two of them. The verdict comes from a judge that saw the frames, not
from whoever argues louder. And none of the crypto shows: no wallet setup, no seed phrase, no SOL,
just dollars.

## How does it work?

1. **Challenge by face.** The phone computes a face embedding on the device and the server matches
   it only against opted-in people in the same room. A match only addresses the challenge; the
   other person still accepts on their own phone.
2. **Terms by voice.** One ElevenLabs Agents Platform conversation per bet runs on the challenger's
   phone. When the judge has the bet, it calls our `propose_terms` webhook. The server composes the
   binding Terms, applies the guardrails and the $20 cap, and hashes them (`sha256` of the
   canonical JSON). Both phones show the same terms card.
3. **Lock it in.** The server builds one transaction on a durable nonce:
   `[AdvanceNonceAccount, SetComputeUnitLimit, create_bet, accept_bet]`, with three signers: A, B
   and our fee payer. Each phone decodes the message, checks it against the card it showed, and
   signs after Face ID. The
   second signature triggers one submission: both USDC stakes move into a PDA-owned vault together,
   or nothing moves. The program checks that B agreed to the same terms hash, stakes and opponent.
4. **The attempt.** The judge cam uploads 8 frames with their SHA-256s. Claude Sonnet 5.5 returns a
   structured verdict and two yes/no observations; if they disagree, or confidence is under 0.8,
   it's a REDO. The server's judge key sends `resolve` with the ruling's hash (which commits to the
   frame hashes). The loser taps GG (`concede`, instant payout) or the 10-second appeal window
   closes and anyone can `finalize`.
5. **Money moved.** The program emits an Anchor event with `emit_cpi!` for every state change. A
   QuickNode Stream on Solana devnet filters our program's events out of every block and posts
   them to our webhook (HMAC-signed), which updates the bet and pushes it to both phones and the
   stage. If the Stream is late, the server polls the RPC for its own transactions instead. (The
   Stream is built and waiting on its QuickNode key; until it exists, the polling path runs.)
6. **The closer.** For "Bitcoin's up by the end of this pitch", the server reads Gemini's live
   5-minute BTC contract, sets the stakes from the mid price (62% Up means a 62/38 split of the pot),
   and writes the contract and quote into the terms. When Gemini settles, the server hashes
   Gemini's exact response as the bet's evidence and resolves the escrow from Gemini's result.
   Anyone with the evidence can re-run the check, and the stage does so itself before it shows
   "verified" (that stage view lands with the stage port now being merged).

If our server disappears, nobody's money is stuck: every live state has a permissionless exit
(`timeout_refund` or `finalize`), and `scripts/crank.ts` lets anyone with a funded key send them.

## What makes it unique?

- **Nothing moves until both say yes, and then both stakes move in one transaction.** The atomic
  durable-nonce lock is three signatures on one message, signed on two different phones, with no
  blockhash expiry while people decide and a revoke that makes the signatures useless.
- **The program decides where money can go; the AI only decides who won.** Payouts go only to the
  two parties, stakes are capped, there is no admin withdrawal, and the server's judge key can
  choose an outcome but never a destination.
- **An AI judge you can check.** Each ruling commits on chain to the hashes of the exact frames the
  model saw; each Gemini bet commits to the hash of Gemini's exact response. Deterministic checks
  can veto the model (REDO), never pick a winner.
- **Consent first.** The loser's GG settles it; silence settles it after 10 seconds. The judge
  speaks, but a spoken "accept" is theatre: only each person's own Face ID signature locks money.
- **Privacy-first face addressing.** Embeddings are computed on the phone, matched only inside the
  room, encrypted at rest, deleted on a schedule, and never authorize anything.
- **Crypto is invisible.** No seed phrase, no SOL, no gas: the server pays every fee and fronts the
  rent, which comes back when the bet closes. Money is shown in dollars.

## What would you build next?

- **The dispute flow.** A spoken 10-second hearing per side, then an appeal to a panel of three
  models from different providers (Anthropic, OpenAI, Google), majority wins. The escrow already
  has `appeal` and `resolve_appeal`, and the server already has a three-vendor model client.
- **Accept without installing:** a web link so a friend can take a challenge from a browser.
- **More markets:** sports and other Gemini prediction markets; in a product, real-world bets would
  route each side to Gemini's regulated market, and peer-to-peer money bets would stay skill-only.
- **Mainnet hardening:** a multisig upgrade authority, an audit, a sealed transport for face
  embeddings, a commercial face model, and top-ups.
- **Head-to-head records:** "You're 4-7 against B" from the bets you've settled.

## Built with

| Area       | Technologies                                                                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chain      | Solana devnet, Anchor 1.2.2 (Rust 1.89), SPL Token and Token-2022 via `token_interface` (`transfer_checked`), durable nonces, `emit_cpi!` events, Circle devnet USDC, `@solana/kit` 8.6, Codama, LiteSVM, Agave 4.1.2                            |
| iPhone app | Expo SDK 58, React Native 0.88, react-native-vision-camera, react-native-fast-tflite (InsightFace `w600k_mbf`), expo-local-authentication (Face ID), expo-secure-store, @noble/ed25519, expo-camera / expo-video-thumbnails (judge cam), Maestro |
| Voice      | ElevenLabs Agents Platform (`@elevenlabs/react-native`, LiveKit WebRTC), webhook tools, client tools, conversation tokens                                                                                                                        |
| AI         | Anthropic Claude Sonnet 5.5 (vision ruling, structured output), Claude Haiku 5.5 (the agent's LLM, served by ElevenLabs)                                                                                                                         |
| Data feeds | QuickNode Streams (Solana devnet, `block` dataset, JavaScript filter, webhook), Gemini Prediction Markets API                                                                                                                                    |
| Server     | Node.js, Hono, WebSockets, zod, Drizzle ORM, PostgreSQL (Neon), Fly.io                                                                                                                                                                           |
| Stage      | Vite, React                                                                                                                                                                                                                                      |
| Quality    | TypeScript, Vitest, Rust LiteSVM matrix, GitHub Actions, gitleaks, ESLint, Prettier                                                                                                                                                              |

## Program IDs and accounts (Solana devnet)

| Item                           | Value                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Escrow program                 | [`BL3gwTBcftGQFdPNp7rZiAyDojkSusdAJ2dzNvFouwcp`](https://explorer.solana.com/address/BL3gwTBcftGQFdPNp7rZiAyDojkSusdAJ2dzNvFouwcp?cluster=devnet)             |
| Config PDA                     | [`FYF8BZaszwttYxSsnXXdtf75YQUhAMwYDNK73eNzDoz`](https://explorer.solana.com/address/FYF8BZaszwttYxSsnXXdtf75YQUhAMwYDNK73eNzDoz?cluster=devnet)               |
| Event-authority PDA            | `2R3N7HdDrqP4nteeBL88v7EESXabbcrLCPasi88F5i7m`                                                                                                                |
| USDC mint (Circle devnet)      | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`                                                                                                                |
| Fee payer / nonce authority    | `ADEMopwqe6cVs9cEyMSbK1pGsJgnyBc3zkC3Wsqf9pQ8`                                                                                                                |
| Program binary sha256          | `826f0874b350743c8f6fcd99f2bd57bc472b618e8a5846593fb26e9843b9e67a` (reproducible from this repo, see the README)                                              |
| Sample lock                    | [`3Dq7rQ9h…HgU9q`](https://explorer.solana.com/tx/3Dq7rQ9h1b1PdVEwfEsQzqT9C2Lc9GXz73zWbqG4eysTJ1bj3CTJyK3E5A4dDfYkKBoLAHWzQmFT51GwmXrHgU9q?cluster=devnet)    |
| Sample resolve                 | [`4LLGESFA…cTsKVvft`](https://explorer.solana.com/tx/4LLGESFAjhRXZ79AgcCBvUuxB4fp91iduMRfshCRR1vAyHy1J637kkBUQBiwybJUgJ2vEx8EvNrCdFkbcTsKVvft?cluster=devnet) |
| Sample finalize                | [`3AzeFcB9…KUhUFg`](https://explorer.solana.com/tx/3AzeFcB97yfdUWDeM4VCodbb7n8ktgo6MHkkxgJU27dt2vC9c53uscZdA85ZMgppc8fzEdfPncNaWrbPdGKUhUFg?cluster=devnet)   |
| Sample timeout refund (keeper) | [`2dvcUpmF…C2JxmXzx`](https://explorer.solana.com/tx/2dvcUpmFNiE76aRqRoGCUKrLTAYywAfFSkuZnkEQKP6CVyTVYnHMj53HXa2egLnY42U7sQqhgoLq5WqFC2JxmXzx?cluster=devnet) |

## Bounty write-ups

### Best use of Solana

Every You're On bet is escrowed and settled by our Anchor program on Solana devnet
(`BL3gwTBcftGQFdPNp7rZiAyDojkSusdAJ2dzNvFouwcp`, 12 instructions). Each bet is a Bet PDA
(`["bet", bet_id]`) that owns an SPL token vault PDA (`["vault", bet_id]`) holding Circle devnet
USDC. When both people have seen the same terms card, our server builds **one** transaction,
`[AdvanceNonceAccount, SetComputeUnitLimit, create_bet, accept_bet]`, on a durable nonce from a
5-account pool. It needs three signers: party A, party B and our fee payer (also the nonce
authority). Each phone decodes and checks the exact message, then signs it after Face ID; the
second signature triggers one submission, so both stakes move together or nothing moves. The
program stores the SHA-256 of the canonical terms, and `accept_bet` fails unless B agreed to the
same hash, stakes and opponent. All five terminal instructions pay out through one
`transfer_checked` path, only to the two parties; stakes are capped at $20; there is no admin
withdrawal; every live state has a permissionless exit. Our server's judge key picks an outcome
(with the evidence and ruling hashes on chain), never a destination. Every state change emits an
Anchor event via `emit_cpi!`, signed by the event-authority PDA, which our QuickNode Stream filter
picks out of each block. Users hold no SOL: the server pays every fee and fronts the rent, and
`close_bet` returns it. Tested by a 167-test Rust LiteSVM matrix, a TypeScript LiteSVM suite and a
local Agave suite; live on devnet, 10/10 soak runs passed on 2026-11-18, with confirm → LOCKED in
4.0–4.6 s. So far the devnet locks were signed with the two demo keys, not yet on an iPhone: phone
signing is built and waiting on the signed iPhone build. The binary is reproducible from the repo
(sha256 `826f0874…b9e67a`).

### ElevenLabs

The judge is an ElevenLabs Agents Platform agent. One conversation per bet runs on the
challenger's iPhone over WebRTC (`@elevenlabs/react-native` with LiveKit), started with a
conversation token our server mints so the API key never reaches a phone. The agent (Claude Haiku
5.5 as its LLM, `eleven_v4_turbo` for text-to-speech) negotiates the bet, asks the edge-case
questions and reads the terms back. It calls our server through **webhook tools** (`propose_terms`,
`confirm_terms`, and `get_market_odds` for the Bitcoin closer), each authenticated with a workspace
secret and bound to its bet. **Client tools** run on the phone: `request_attempt` arms the judge
cam, `show_terms_card` brings the card forward, `cue` plays a gavel or a cheer on the stage. Server
results (locked, ruling, paid) are injected back into the conversation so the judge announces them,
and the phone relays the transcript to the server, which streams it to the stage as live captions.
On the projector, ElevenLabs **Text to Speech** speaks every ruling and payout in the judge's voice
and each appeal-panel vote in its own voice (the server generates each line once and streams it to
the stage), and ElevenLabs **Sound Effects** generates the gavel, drumroll, buzzer and cheer cues
the stage plays. Without the key the stage says the same lines in the browser's voice, so the
ruling is always heard.
The whole agent (secret, tools, agent) is defined as code and created idempotently by
`npm run el-agent`, checked against ElevenLabs' OpenAPI document. A spoken "accept" is theatre:
the judge never moves money. **Status:** built and tested end to end against the real webhook
routes with a fake ElevenLabs; the ElevenLabs key is pending, so the agent has not yet run on
ElevenLabs. TODO: update once the key lands and the demo video shows the judge with audio.

### QuickNode Streams

**Network:** `solana-devnet`. **Dataset:** `block` (batches of 5, elastic batching), because our
events are `emit_cpi!` inner instructions and the block dataset carries them. **Filter:**
[`infra/quicknode/filter.js`](../infra/quicknode/filter.js), generated from the escrow IDL. It drops
failed transactions and keeps only inner instructions whose program is our escrow, whose data
starts with Anchor's event tag, and whose first account is our event-authority PDA, so no other
program can forge an event. It forwards the raw event bytes with the signature, block height and
instruction position, and sends nothing for a batch without our events. **Destination:** a webhook,
`POST https://youre-on.fly.dev/webhooks/quicknode`, verified with QuickNode's HMAC signature
(constant-time, 300 s window). The server re-decodes each event with the IDL compiled into it,
stores it idempotently, and folds it into the bet in one database transaction. **Why:** it is our
source of truth for "money moved": it updates each bet's on-chain status and payout, catches up a
bet when the chain is ahead of the server, and pushes every event to both phones and the stage's
on-chain ticker with an Explorer link. If the Stream is late, an `rpc_poll` fallback fetches the
server's own transactions after 30 s through the same decoder and projector. **Status:** built and
tested offline (HMAC fixtures, real LiteSVM transactions through the filter, webhook and projector,
and a mimic program whose look-alike events the filter rejects); the QuickNode key is pending, so
the Stream is not created yet and the live server runs on `rpc_poll`. Creating it is one command
(`npm run qn-stream -- create --fly-app youre-on`). TODO: update once the Stream is live.

### Gemini Prediction Markets

The closer is a bet on Gemini's 5-minute Bitcoin market (series `BTC05M`), locked at the start of
the pitch and settled at the end. Our server relays Gemini's public market data for every client:
it discovers the current contract with `GET /v1/prediction-markets/events?status=active&category=Crypto`,
refreshes it every 2 s with `GET /v1/prediction-markets/events/{eventTicker}` (plus the
`/strike` endpoint as a fallback), and shows BTC/USD from `GET /v1/pubticker/btcusd`. Fair stakes
come from the live odds: the mid of the best bid and ask sets the split, so taking "Up" at 62%
means putting in 62% of the pot. It refuses a bad quote (no two-sided book, a stale snapshot, under
2 minutes to expiry, a price outside 5–95%) with a reason the judge can say. The contract, strike,
price and quote time are written into the terms, so the terms hash on chain commits to them. When
the contract expires the server fetches its settlement, hashes Gemini's exact response body, and
puts that hash (through a canonical settlement record) on chain as the bet's `evidence_hash` in
`resolve`. The evidence chain is served at `GET /v1/bets/:id/settlement`, with the on-chain hashes
read from the chain itself (not from our database), and the stage re-runs the shared
`verifySettlement` over it before it shows "verified". Public data only: no key, no trading.
**Status:** built and tested offline against recorded real Gemini responses, with a labelled
REPLAY feed as the fallback. The stage's own re-check lands with the stage port now being merged.
TODO: add the live run once it is measured.

## Honest status

| Live on devnet                                                                                                      | Built, pending                                                                                                                                          | Not built                                           |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Escrow program, atomic lock, live Claude ruling, GG / finalize payouts, timeout-refund keeper, server on Fly + Neon | ElevenLabs agent (key), QuickNode Stream (key), the signed iPhone build (so face scan, Face ID signing and the judge cam on a phone), a live Beat 6 run | The spoken hearing and the three-model appeal panel |

## Team

TODO: names and roles as the team wants them shown.
