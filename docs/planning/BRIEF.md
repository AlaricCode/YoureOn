YOU'RE ON - Project brief for Claude Code
UBC 2026 Hackathon - Consumer Applications track
Working name: You're On

(Copy of the brief the lead engineer gave Claude Code.)

>>> AMENDMENT (lead engineer decision) — NO HANDSHAKE.
>>> Face identification is ONLY used to find/address the person you want to
>>> challenge and send them the request. The agreement/authorization happens
>>> on each user's OWN phone: both phones show the final terms card, and each
>>> party confirms their own stake there (default: hold-to-confirm + Face ID
>>> via iOS LocalAuthentication, which also unlocks the device key that signs
>>> that party's deposit). The second confirmation locks the bet onchain.
>>> Handshake detection is dropped. A spoken "accept" is no longer the binding
>>> act. Sections below are edited accordingly (look for "AMENDED").
>>> All demo phones are iPhones.

============================================================
READ THIS FIRST - TIMING RULE
============================================================
- The hackathon rules say projects must be substantially built DURING the
  hackathon window: Fri Nov 13, 2026 12:00 PM CST (18:00 UTC) to
  Fri Nov 20, 2026 12:00 PM CST (18:00 UTC). The repo must be public, and
  judges can see the commit history.

============================================================
1. THE PRODUCT
============================================================
You're On is a mobile app for betting your friends on anything, settled by
an AI judge.

- Point your phone at a friend's face to challenge them. (AMENDED: the face
  scan only finds the person and sends them the request; it never
  authorizes anything.)
- Say the bet out loud. The AI judge turns it into precise terms by asking
  edge-case questions ("Does landing on the cap count? One flip or best of
  three?") and reads the terms back.
- (AMENDED) Each person reviews the final terms on their own phone and
  authorizes their own stake there (hold-to-confirm + Face ID). When both
  have authorized, both stakes lock in a Solana escrow.
- The judge watches the attempt through the camera and rules out loud. The
  winner is paid in under a second.
- Disputes get a 30-second hearing and can be appealed to a panel of three
  different AI models.
- Bets on real-world events get fair odds from Gemini's prediction markets
  and settle from Gemini's results.
- Nobody ever sees crypto: signup is a selfie, there are no seed phrases or
  gas fees, and money shows as dollars.

Pitch line: "Friends bet each other every day, and it all runs on trust.
You're On makes a handshake enforceable in under a second."

============================================================
2. HACKATHON CONTEXT (build to these requirements)
============================================================
- Event: University Blockchain Conference (UBC) 2026. Finals are in person at
  UT Austin on Sat Nov 21. Finalists pitch for 5 minutes + 2 minutes of Q&A.
- Main track: Consumer Applications.
  Requirements: interacts with the blockchain; working user-facing frontend.
  Objectives: hide crypto complexity (bridging, gas, seed phrases); something
  people want to use every day; intentional design and UX.
- Chain award: Best use of Solana.
  Requirements: core onchain functionality on Solana (devnet is fine);
  include program IDs; README explains how the project uses Solana.
  Objectives: Anchor or native Rust programs; Solana-native primitives (SPL
  tokens, Token Extensions, Solana Pay); integrate existing tooling; smooth
  wallet UX.
- Bounties we are entering:
  * ElevenLabs: the ElevenLabs API/SDK must be a core feature, not an add-on.
    The demo video must show it in action with audio. README must say which
    ElevenLabs products we used and how.
  * QuickNode Streams: Streams must be a core data source. Configure at least
    one Stream with a filter and a destination. README must explain the
    network, dataset, filter logic, destination, and why.
  * Gemini Prediction Markets: must use the Gemini Prediction Markets API
    (market data and/or trading endpoints).
- Judging criteria: technical execution, product & UX, innovation, impact &
  potential, demo.
- Submission (due Fri Nov 20, 12:00 PM CST): public GitHub repo with source
  and setup instructions; README with technical docs and architecture;
  working demo; 2-3 minute demo video; Devpost written answers (What did you
  build? What problem does it solve? How does it work? What makes it unique?
  What would you build next?); technologies used; program IDs.
- Team: three people. The user is the lead engineer. The demo runs ONLY on
  the team's own phones (judges will not install anything), plus a laptop
  driving a big-screen "stage view."

============================================================
3. THE DEMO WE ARE BUILDING TOWARD
============================================================
Every P0 feature exists to make these moments work live.

Beat 1 - Challenge by face: A points the camera at B -> "Challenge Jake?"
  -> B's phone buzzes with the challenge.
Beat 2 - Terms by voice: A says "Bet you $5 you can't land a bottle flip."
  The AI judge asks 1-2 funny edge-case questions and reads the final terms
  back; the terms card appears on both phones.
Beat 3 - (AMENDED) Lock it in: each person confirms the terms and their
  stake on their own phone (hold-to-confirm + Face ID). The second
  confirmation locks both stakes onchain (the transaction appears on the
  stage view). No handshake detection.
Beat 4 - The attempt: the camera records the flip -> the judge rules out
  loud within a few seconds -> the loser taps "GG" (or it auto-finalizes
  after 10s) -> the winner's phone buzzes with the payout.
Beat 5 - Dispute: a contested shot -> each side gets about 10 seconds to
  argue -> the judge reviews the clip and rules -> "I appeal!" -> the
  three-model panel votes live -> the ruling stands or flips.
Beat 6 - Closer: "Bitcoin's up by the end of this pitch." The judge pulls
  Gemini's 5-minute BTC market, sets fair stakes from the live price
  (e.g. 62/38), and settles from Gemini's result at the end.
Extra: point the camera at a friend to see your head-to-head record
  ("You're 4-7 against Jake").

============================================================
4. ARCHITECTURE (suggested - verify library compatibility first)
============================================================
Monorepo:
- apps/mobile - Expo (React Native, TypeScript), development build (not Expo
  Go). Camera and frame processing, face enrollment and scan, voice session
  with the judge, bet flows, haptics, push notifications.
- apps/server - Node + TypeScript (Hono or Fastify), Postgres, WebSockets.
  Judge orchestration, ElevenLabs tool webhooks, face matching, Solana
  transaction building and fee sponsorship, Gemini market service, QuickNode
  Streams webhook receiver, push notifications.
- apps/stage - web app (Vite/React or Next.js) for the projector.
- programs/escrow - Anchor program (Rust) on Solana devnet.
- packages/shared - shared types and Zod schemas (Terms, Ruling, BetState,
  events).
Hosting: the server needs public HTTPS for the ElevenLabs tool calls and the
QuickNode webhook (Fly.io, Railway, Render or similar).

============================================================
5. COMPONENT SPECS
============================================================

5a. Escrow program (Anchor, devnet, SPL USDC)
- Config account: admin, judge_authority, appeal_authority, max_stake
  (demo: $20), default deadlines.
- Bet PDA (seeds: "bet", bet_id): party_a, party_b, mint, stake_a, stake_b,
  terms_hash (sha256 of the canonical terms JSON), status, outcome,
  evidence_hash, ruling_hash, deadlines. Vault token account owned by the
  PDA.
- Instructions:
  * create_bet - A deposits
  * accept_bet - B deposits; must match terms_hash -> Locked
  * resolve - judge_authority only; outcome is one of {A, B, Split, Refund};
    stores evidence and ruling hashes; opens a short appeal window
  * concede - the loser finalizes immediately (instant payout path)
  * appeal - the loser, within the window
  * resolve_appeal - appeal_authority only
  * finalize - after the window closes
  * timeout_refund - anyone, after deadlines pass
- Hard constraints enforced onchain: funds can only ever go to party_a or
  party_b; stakes <= max_stake; terms_hash is immutable after lock; there is
  no admin withdrawal path.
- Emit an Anchor event for every state change (QuickNode Streams reads them).
- Test every path, including an attempted payout to a third party (must fail).

5b. Wallets and money (crypto must be invisible)
- Each user gets an embedded Solana wallet at signup (an embedded-wallet
  provider with Expo + Solana support, or a device-generated keypair in
  secure storage for the hackathon).
- The server is the fee payer for every transaction. Users never hold SOL.
- Balances display as dollars. Demo accounts are pre-funded with devnet USDC
  (Circle faucet). The demo uses devnet test money only.

5c. AI judge
- Brain: Claude via the Anthropic API, with structured JSON outputs validated
  by Zod.
- Terms: turn a spoken bet into the Terms schema: claim, type
  (skill | real_world), attempts, success_criteria, failure_criteria,
  edge_cases [{question, answer}], evidence_source (camera | gemini), stakes,
  deadline. Ask at most 2 clarifying questions, then read the terms back.
- Ruling (skill bets): record a short clip, sample about 8 frames (including
  the final frames), and send them with the terms. Output
  {outcome: A_WINS | B_WINS | REDO, confidence, reason}. Confidence below
  0.8 -> REDO. Hash the clip -> evidence_hash onchain.
- Hearing: each party gets a short push-to-talk turn (one phone each, so we
  always know who is speaking). The judge rules with reasons that reference
  the evidence.
- Appeals: three different model providers vote independently on the same
  evidence and terms. Majority decides.
- Persona: quick, stern, funny, PG-13, short lines. Refuses unsafe, illegal
  or harmful challenges (anything dangerous, alcohol or drugs, self-harm, or
  involving minors) and says so with a joke.
- Guardrails: 18+ only; stake cap. In the product, peer-to-peer money bets
  are limited to skill challenges, and real-world bets would route each side
  to Gemini's regulated market. For the hackathon demo, the BTC closer
  settles in our escrow on devnet with Gemini as the oracle.

5d. Voice (ElevenLabs - must be core)
- The judge is an ElevenLabs Agent (conversational) with server tools that
  call our backend: propose_terms, ask_clarification, confirm_terms,
  lock_bet, request_attempt, issue_ruling, open_hearing, file_appeal.
- ElevenLabs voices the judge's rulings and announcements and handles the
  parties' speech through the Agent.
- Target: the judge's first audio < 1.5s after a party stops talking.
- Verify ElevenLabs React Native/Expo SDK support and tool-call latency early.

5e. Face scan to challenge (privacy is a feature)
- Opt-in only: enrollment is a selfie at signup with a simple liveness check
  (blink or head turn) plus an explicit consent screen. Users can disable or
  delete it anytime.
- Compute face embeddings on the device and send embeddings (never raw
  images) to the server. Store them encrypted at rest, never log them, and
  NEVER put biometric data onchain.
- Match only against opted-in users in the same "room" (people nearby or in
  the same session), never a global search. No confident match -> show
  nothing, store nothing.
- A match only addresses the challenge. The other person still accepts on
  their own phone, so a wrong match can never move money. (AMENDED: this is
  now the only role of the face scan — find and address; all agreement and
  authorization happen on each party's own phone.)
- Target: match < 1s. The README should explain this design (Texas and
  Illinois have biometric consent laws, and the finals are in Texas).

5f. (AMENDED) On-phone authorization — replaces handshake detection
- After the judge reads the final terms back, both phones show the same
  terms card (claim, criteria, edge cases, stakes in dollars, deadline) and
  the terms_hash it binds to.
- Each party authorizes on their own phone: hold-to-confirm + Face ID (iOS
  LocalAuthentication). Authorization unlocks that party's device key and
  signs that party's own deposit (A: create_bet; B: accept_bet with the
  matching terms_hash). The server is only the fee payer.
- The second authorization locks the bet onchain. Either party can decline
  or let it expire; nothing moves without each party's own signature.
- Handshake detection is dropped (no camera-based lock).

5g. Gemini Prediction Markets (real-world bets + the closer)
- Market data is public (no API key needed):
  * list active events: GET https://api.gemini.com/v1/prediction-markets/events?status=active
  * event details: GET https://api.gemini.com/v1/prediction-markets/events/{eventTicker}
  * live prices over WebSocket: wss://ws.gemini.com, subscribing with each
    contract's instrumentSymbol (e.g. <instrumentSymbol>@bookTicker)
  * recently settled events, for resolution
- 5-minute crypto contracts use tickers like GEMI-BTC05M{YYMMDDHHmm}-UP. The
  strike for UP contracts comes from the API, not the ticker. Never build
  symbols by hand; use the instrumentSymbol the API returns.
- Fair stakes: if A takes YES at price p, A stakes pot*p and B stakes
  pot*(1-p).
- Settlement: when Gemini settles the contract, the judge resolves the escrow
  with the Gemini result as evidence.
- Docs index: https://developer.gemini.com/llms.txt (official TypeScript SDK:
  @gemini-markets/sdk). Read the docs instead of guessing endpoints, and
  check whether the sandbox lists prediction markets.

5h. QuickNode Streams (must be core)
- One Stream on Solana devnet. Filter (JavaScript): only transactions that
  invoke our escrow program; decode the Anchor events. Destination: webhook
  to apps/server.
- The webhook updates the database and pushes every state change (locked,
  resolved, appealed, paid) to both phones and the stage view in real time.
  It is the source of truth for "money moved."
- Free-trial Solana Streams follow the chain tip only (no historical
  backfill). That is fine for us.
- README must document the network, dataset, filter logic, destination, and
  why.

5i. Stage view (projector)
- One screen per active bet: both parties' photos and names, terms card, live
  judge transcript, evidence frames, ruling, escrow events streaming in with
  Solana Explorer links, and a Gemini price chart + countdown for the closer.
- Demo mode: seeded accounts, short timers, and a toggle to play a
  pre-recorded fallback for any beat.

============================================================
6. PERFORMANCE TARGETS
============================================================
- Face match < 1s
- Judge first audio < 1.5s
- (AMENDED) Second on-phone authorization -> lock confirmed < 2s
- Attempt -> ruling < 4s
- Concede/finalize -> payout visible < 1s
Everything must work over cellular (never depend on venue Wi-Fi).

============================================================
7. PRIORITIES
============================================================
P0: escrow program + tests on devnet; embedded wallets + fee sponsorship;
    voice terms; on-phone authorization (hold + Face ID) -> lock (AMENDED,
    replaces handshake lock); skill-challenge vision ruling;
    payout UX (haptics + animation); face scan (room-scoped); QuickNode
    Stream -> realtime updates; README skeleton.
P1: hearing + appeals panel; Gemini BTC closer; head-to-head records; stage
    view; demo mode.
P2: web link so a judge can accept a challenge without installing; more
    real-world markets (NFL/NBA via Gemini); top-up flow.

============================================================
8. BUILD PLAN (window: Fri Nov 13 12 PM CST -> Fri Nov 20 12 PM CST)
============================================================
Fri: scaffold monorepo; escrow program skeleton + tests; Expo app with auth +
     wallet; server skeleton.
Sat: escrow complete and deployed to devnet; create/accept/resolve/finalize
     end-to-end from the app; Stream -> webhook -> push working.
Sun: ElevenLabs judge agent + terms flow; on-phone authorization -> lock
     (AMENDED, replaces handshake detection).
Mon: vision rulings + REDO logic; payout UX; face enrollment + matching.
Tue: hearing + appeals; Gemini closer; head-to-head records.
Wed: stage view + demo mode; polish; testing with real users; bug bash.
Thu: README + architecture diagram + bounty sections; record the 2-3 minute
     demo video; Devpost answers; rehearse.
Fri morning: final fixes; submit before 12 PM CST.
Sponsor office hours run Nov 16-19, so have something to show by Monday.

============================================================
10. HOW TO WORK
============================================================
- TypeScript everywhere except the Rust program. Shared Zod schemas. Secrets
  in .env, never committed.
- Work in small, verified steps. Run tests. Commit early and often with clear
  messages (the commit history is evidence the project was built during the
  window).
- Keep the README current as features land: setup, architecture (Mermaid
  diagram), program IDs, how we use Solana, Streams config, ElevenLabs usage,
  Gemini usage, privacy design, guardrails.
- When unsure about any external API, read the official docs first.
- Ask the user before signing up for paid services, and tell them exactly
  which keys you need and where they go.
- Optimize for the demo: if something threatens a demo beat, fix that first.
