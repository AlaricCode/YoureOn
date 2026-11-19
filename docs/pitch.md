# You're On: finals pitch, demo video and Q&A

The finals are 5 minutes of pitch plus 2 minutes of Q&A (UT Austin, Sat 2026-11-21). This is the
script, beat by beat, with what each phone and the stage show; the 2–3 minute demo-video shot
list; and likely judge questions with answers. Operations (pre-show checks, fallbacks, keys) are
in [`runbook.md`](runbook.md).

**Cast.** Presenter (talks, holds no phone). Player A (phone A: challenger, hosts the voice judge).
Player B (phone B: opponent). Operator (laptop: stage, runbook, judge cam on its tripod). Use the
players' own first names on stage; this script says A and B.

**What must be true before you walk on** (see the runbook):

- `npm run demo-check` says GO; the stage is open and full screen (`F`); `M` unmuted.
- Phones A and B are signed in as the demo players, foregrounded, on cellular, Low Power Mode off.
- The REPLAY clips are cached (the stage's bottom strip says so), in case a beat fails.
- **Four things are still pending as of 2026-11-18.** Check each and pick the script variant:
  - ElevenLabs key → the voice judge. Without it, A uses **"Type it instead"** in Beat 2.
  - The signed iPhone build → phones. Without it, see "No phones" at the end of the script.
  - A live Beat 6 rehearsal on Gemini → if it has not run cleanly, keep `REPLAY 6` ready.
  - The stage port (being merged) → the stage's "verified" line for the Gemini evidence in Beat 6.
    The stage deployed from `edc3613` does not show it; if it still doesn't, say "the evidence hash
    is on chain" and point at the resolve transaction (`Q`) instead.

## Timing the closer (Beat 6)

The Bitcoin bet locks in the first 25 seconds and must settle before the close. Gemini's 5-minute
BTC contracts expire on the five-minute marks. You can only lock a contract with at least 2:00
left, and both signatures must land within 60 s of the quote.

- **Aim:** lock at about 0:20 into the pitch, on a contract with about 3:30–3:40 left. It expires
  around 3:55, Gemini settles a few seconds later, the server resolves, and the loser GGs at about
  4:15.
- **So:** start the pitch about **1:05 after a five-minute mark** (for example 14:06:05 or
  14:11:05). Keep a phone clock visible to the operator.
- If the slot doesn't line up, lock the closer whenever the current contract has 3–4 minutes left,
  and move the settle beat to match. If it has under 2:00 left, the phone counts down to the next
  round: do Beats 1–4 first.

## The 5-minute script

### Before 0:00 · Stage the closer's challenge

Within the 5 minutes before you walk on (an unanswered draft expires after 5 idle minutes), A
challenges B from the room list and B accepts, so both phones sit on the negotiate screen. The
bottle-flip bet in Beat 1 is a second bet: a pair can have only one bet before its lock, and the
Bitcoin bet is past its lock by then.

### 0:00–0:25 · Cold open: lock the closer (Beat 6, part 1)

> **Presenter:** "Before we start: Bitcoin's going up by the end of this pitch. A, put money on
> it." (A and B do Beat 6's lock while the presenter goes on.)

| Phone A                                                                                                                                | Phone B                                                                  | Stage                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Negotiate screen → "Bet on Bitcoin" → Up, $2 a side → Gemini's live odds and the fair split (e.g. 61/39) → terms card → hold → Face ID | Terms card with the side B holds, the line and the odds → hold → Face ID | Gemini panel: BTC 5-minute odds, the line, the countdown. Phase rail at Lock. Ticker: the lock transaction with its Explorer link. |

### 0:25–0:55 · The problem

> **Presenter:** "Friends bet each other every day. A bottle flip, a free throw, who finishes
> first. And it all runs on trust: nobody wrote the terms down, the shot gets argued about, and the
> five bucks gets forgotten. You're On makes a handshake enforceable in seconds. Watch."

Phones: idle on the home screen. Stage: the closer's countdown keeps running on the right.

### 0:55–1:20 · Beat 1: challenge by face

> **Presenter:** "A wants to challenge B. No usernames, no QR codes. A just points the phone."

| Phone A                                            | Phone B                                | Stage                                        |
| -------------------------------------------------- | -------------------------------------- | -------------------------------------------- |
| "Scan a face" → camera on B → "Challenge B?" → tap | Full-screen invite + haptic → "Accept" | Phase rail at Challenge; both players' cards |

> **Presenter:** "The face match happens against people in this room who opted in, and it only
> addresses the challenge. It can never move money. The embedding is computed on the phone."

Fallback: if the scan says "No match", A picks B from the room list. Say "or just pick them from
the room".

### 1:20–2:00 · Beat 2: terms by voice

> **A (to the phone):** "Jarvis, bet you five bucks you can't land a bottle flip."
>
> (The judge waits for "Jarvis" or **Tap to talk** on A's negotiate screen: without the wake word
> nothing is heard. [`runbook.md`](runbook.md#phones-and-room).)
>
> **Judge (ElevenLabs, from A's phone):** asks one or two edge-case questions (cap landing? one
> try?) and reads the terms back.
>
> **A and B:** answer, then both say "accept".

| Phone A                                         | Phone B                                       | Stage                                                           |
| ----------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------- |
| Live captions of the judge; then the terms card | Captions (B's subtitles); then the terms card | The judge's live transcript; the terms card with its terms code |

> **Presenter:** "The judge asks the questions friends skip. But saying 'accept' doesn't lock
> anything. Only your own phone can."

Variant without the ElevenLabs key: A taps **"Type it instead"**, types the bet, and the same
server path writes the same terms card. Presenter: "Normally the judge talks you through this; today
we'll type it."

### 2:00–2:25 · Beat 3: lock it in

> **Presenter:** "Both of them hold, and Face ID. Both stakes go into one Solana transaction, on
> both phones' signatures. Either both stakes move, or nothing does."

| Phone A                   | Phone B                   | Stage                                                                                                 |
| ------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------- |
| Hold → Face ID → "Locked" | Hold → Face ID → "Locked" | LOCKED moment (lock sound); the ticker shows the lock transaction; `Q` puts its Explorer QR on screen |

Needs `LOCK_SIGNER=phones` on the server: with `LOCK_SIGNER=server` (what prod ran on 2026-11-19)
the server signs for the demo accounts and neither phone holds or asks for Face ID, so check
`lock_signer` in demo-check before the pitch and reword this beat if it is `server`.

Expect about 4–5 seconds from confirm to LOCKED on devnet. Fill it: "That's a real devnet escrow:
scan the QR."

### 2:25–3:20 · Beat 4: the attempt

> **Presenter:** "Now B flips. The judge cam is that third phone." (Two phones only: "A's phone is
> the camera now", and A films; [`runbook.md`](runbook.md#phones-and-room).)

| Judge cam (or phone A)                                      | Phone A / Phone B                                                       | Stage                                                                                 |
| ----------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 3-2-1, records the flip, uploads 12 frames + a landing crop | "Judging…" → the ruling and the reason → the loser's phone shows **GG** | Attempt → Ruling on the phase rail; the evidence frames; the ruling and reason; gavel |

> **Presenter:** "Claude looked at the frames and ruled in about three seconds. The ruling's hash,
> which commits to every frame it saw, is on chain. Now the loser has two choices: GG, or appeal
> within ten seconds."
>
> **Loser:** taps GG → Face ID.

Stage: the PAID moment and its sound, the payout amount, the `concede` (or `finalize`) transaction
in the ticker. Winner's phone: the payout. If nobody taps GG, the 10-second window closes and the
server finalizes.

"About three seconds" is with camera checks off; with them on the ruling takes 7-10 s (it waits
for SAM), so say "in a few seconds" or switch checks off ([`runbook.md`](runbook.md#camera-checks-sam-31-ref-cam-off-by-default)).

If the ruling is REDO ("Run it back"), flip again: that is the deterministic checks refusing a
verdict they can't confirm. If the judge is slow or wrong, see the runbook: the cached ruling is a
runtime switch (`POST /v1/demo/toggles {"cached_ruling": true}`), no restart.

### 3:20–3:45 · Beat 5: what if you disagree? (talk, no demo)

> **Presenter:** "What if B thinks the judge got it wrong? The escrow already has an appeal path:
> the loser can freeze the payout inside those ten seconds, and only a separate appeal key can
> settle it. Next we're putting a panel of three models from three different companies behind that
> key. And if our server vanished tomorrow, every bet has a deadline after which anyone can refund
> it. The program decides where money can go. The AI only decides who won."

Stage: stays on the paid bet. Don't show the stage preview's sample appeal: the hearing is not
built, and the panel (built and tested, see the runbook's "The appeal (Beat 5)") has not run live
yet.

### 3:45–4:25 · Beat 6, part 2: the closer settles

> **Presenter:** "Remember Bitcoin? That contract just expired."

| Phone A / Phone B                                           | Stage                                                                                                                        |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Market clock → "Settled" → the ruling → the loser's GG card | Countdown hits 0 → Gemini's result → "verified" on the evidence chain (Gemini's response hash, on chain at `resolve`) → PAID |

> **Presenter:** "The stakes were set by Gemini's live odds, not fifty-fifty. And the evidence is
> Gemini's own response, hashed and written on chain, so anyone can check that the money moved on
> what Gemini said."

### 4:25–5:00 · Close

> **Presenter:** "Everything you saw runs on Solana devnet today: an Anchor escrow with twelve
> instructions, locks in about four and a half seconds, rulings in about three, ten out of ten soak
> runs settled. No seed phrase, no gas, just dollars. You're On: bet your friends on anything you
> can film. Thank you."

### No phones (if the signed iPhone build has not landed)

Do not fake it. The money path runs without phones: on the laptop, `npm run cp1-drive -- --base-url
https://youre-on.fly.dev --through paid --gg` plays both players over the real API with the demo
keys, and the stage shows the real devnet bet. Say so: "The phones aren't signed yet, so the laptop
plays both of them; what you see on the stage is the real escrow." No voice judge hosts a laptop
bet, so the projector speaks its ruling and payout itself. Its judge-cam frames are synthetic test
images, so don't present the ruling as a real flip. Use `REPLAY 1` for the face scan
only if a recorded clip of the real app exists, and say "replay".

## Demo video (2–3 minutes)

Required by the rules and the ElevenLabs bounty: it must show the voice judge **with audio**. Record
the phones' screens (iOS screen recording with the mic on), one over-the-shoulder camera, and the
stage page. Label any replayed segment.

| #   | Time      | Shot                                                                                                                                  | Audio                                      | Proves             |
| --- | --------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------ |
| 1   | 0:00–0:10 | Title card; two friends, a water bottle.                                                                                              | VO: the one-line pitch                     | Hook               |
| 2   | 0:10–0:25 | Close-up: an argument over a flip; "you owe me five".                                                                                 | VO: the problem                            | Problem            |
| 3   | 0:25–0:40 | Over the shoulder: A scans B's face → "Challenge B?" → B's phone buzzes.                                                              | Ambient                                    | Beat 1             |
| 4   | 0:40–1:10 | Phone A screen recording + room audio: the judge's voice, its edge-case question, the read-back. Cut to the stage captions.           | **The ElevenLabs judge, audible**          | Beat 2, ElevenLabs |
| 5   | 1:10–1:25 | Split screen: both phones, hold → Face ID → Locked. Stage LOCKED; Explorer page of the lock transaction.                              | VO: "one transaction, three signers"       | Beat 3, Solana     |
| 6   | 1:25–1:55 | Judge cam POV of the flip; the ruling on the phones and stage; the loser taps GG; the winner's payout; Explorer link.                 | The judge announces the result (A's phone) | Beat 4             |
| 7   | 1:55–2:25 | Beat 6: "Bet on Bitcoin" with Gemini's odds; time-lapse to expiry; settled, "verified", paid.                                         | VO: fair odds, evidence on chain           | Gemini             |
| 8   | 2:25–2:45 | Under the hood: the architecture diagram; the stage ticker reading "via QuickNode Streams"; the webhook log; the program on Explorer. | VO: Streams, the program, the tests        | QuickNode, Solana  |
| 9   | 2:45–3:00 | End card: program ID, repo URL, team.                                                                                                 | VO: close                                  |                    |

Gates: shot 4 needs the ElevenLabs key. The stage speaks a ruling only in a bet no voice judge is
hosting (the "No phones" run, or typed terms before the judge spoke): with the voice judge on, A's
phone announces it and the projector stays quiet, so the hall hears one judge. The stage's own
voice is ElevenLabs only with the key (without it the strip says `Voice browser`, so don't present
it as ElevenLabs). Shot 8's "via QuickNode Streams" needs the live Stream (the
stage only says it when the Stream delivered). Without them those bounties lose their evidence, so
record those shots last and don't substitute footage that implies otherwise. No Beat 5 shot: the
hearing and panel are not built.

## Likely judge questions

**Isn't this gambling?** Peer-to-peer money bets are meant for skill challenges between friends,
18+ only, with a $20 cap enforced on chain, and the demo runs on devnet test money. The
Bitcoin closer is a demo exception: in the product, real-world bets would route each side to
Gemini's regulated market instead of our escrow.

**What if the AI judge is wrong?** Three guards. It rules on frames whose hashes are committed on
chain, so the evidence can't be swapped later. Deterministic checks can veto a verdict (REDO), and
low confidence or a model error is a REDO too; a third REDO refunds both. And the loser
can appeal inside the window; only a separate appeal key can settle an appeal. Behind that key, a
panel of three models from three companies votes on the same frames; two must agree to flip it.

**Can your server steal the money?** No. The program pays out only to the two parties' own token
accounts; there is no admin withdrawal. Our judge key can pick who won, not where money goes. We
disclose the trust that remains: the judge key's verdict, the upgrade authority on devnet, and
Circle's freeze authority over devnet USDC. One more, for the demo only: phones A and B use two
custodial demo keys that the server also holds, so a rehearsal can run without phones. In the
product each phone generates its own key and it never leaves the device.

**What if your server goes down mid-bet?** Every live state has a deadline after which anyone can
send `timeout_refund` or `finalize`. Our keeper does it, and `scripts/crank.ts` lets anyone with a
funded key do it. On the live server the keeper already refunded a stranded bet on boot.

**Why one transaction, and why a durable nonce?** So neither person is ever exposed: both stakes
move together or not at all, with no "A paid, B walked away" state. A normal blockhash expires in
about a minute; a durable nonce lets two people sign at their own pace, and declining just advances
the nonce, which kills the signatures.

**How do users not see crypto?** The phone holds the wallet key, unlocked by Face ID. Our server pays
every fee and fronts the rent (returned when the bet closes). Money shows in dollars. No seed phrase,
no SOL, no wallet app.

**What does the phone actually check before signing?** It decodes the exact message and refuses
anything that isn't our program with the expected instructions, the stakes and terms hash on the
card it showed, our pinned fee payer and a nonce account it can derive itself. Only then does it ask
for Face ID.

**Why QuickNode Streams instead of just polling the RPC?** Our events are inner instructions
(`emit_cpi!`), which the block dataset carries and which survive log truncation. The Stream pushes
them to us once, filtered to our program, with no polling of our own; we verify the HMAC, store
each event idempotently, and the chain wins any disagreement. Polling remains as a fallback.

**How are the odds fair?** From Gemini's live order book: the mid of the best bid and ask. At 62%
Up, the Up side puts in 62% of the pot. We refuse to quote a stale, one-sided or extreme book, and
the quote is written into the terms hash on chain.

**Why trust Gemini's result?** It's the oracle, and we don't hide that. What we add is
accountability: the hash of Gemini's exact response is on chain, and anyone can re-run the check.

**How fast is it?** On live devnet: terms confirm to LOCKED in 4.0–4.6 s (that includes building and
simulating the transaction), a Claude ruling in 2.8–4.0 s, and a whole bet in 18–28 s including the
10-second appeal window.

**Is the face scan legal in Texas?** It's opt-in with explicit consent, computed on the device,
matched only inside the room, encrypted at rest, deleted on a schedule, and never on chain. Texas
CUBI and Illinois BIPA were the design constraints.

**What's the business?** A small fee on settled bets, and leagues or venues that run challenge
nights with a stage screen. Not built; it's the direction.

**Is this mainnet-ready?** No. Next: an audit, a multisig upgrade authority, a sealed transport for
face embeddings, a commercial face model, and the dispute panel.

**What was built during the hackathon?** The team wrote two prototypes before the window, and the
organizers confirmed that reusing them is allowed. One was imported as the base on 2026-11-14,
with the planning docs; the commit history shows everything after that. The README's "Prior work"
section and `docs/MERGE-PLAN.md` say what was kept, ported and dropped.
