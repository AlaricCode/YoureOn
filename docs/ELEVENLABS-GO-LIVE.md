# ElevenLabs voice judge: go-live runbook

The server half of the voice judge is built and tested without a key: the token route
(`POST /v1/voice/tokens`), the webhook tools (`/el/tools/propose_terms`, `confirm_terms`,
`get_market_odds`, `request_review`), the post-call webhook (`POST /webhooks/elevenlabs`) and the agent-as-code
script (`scripts/el-agent.ts`). Nothing calls ElevenLabs until the steps below. Run them in order,
once the ElevenLabs API key exists. They take about 15 minutes.

App: `youre-on` (https://youre-on.fly.dev). The specs are API-CONTRACT §2.6, §4 and §4.6, and
SETUP-CHECKLIST K2.

## 0. Before you start

- The server that is live must include branch `feat/voice-finish`, which adds the post-call webhook
  route. Only that build reports `webhook_url` in the readiness check, so this prints `true` once it
  is deployed (`false` means an older build):

  ```sh
  curl -s -H "X-YO-Demo-Key: $DEMO_ADMIN_TOKEN" https://youre-on.fly.dev/v1/demo/voice | jq 'has("webhook_url")'
  ```

- On Fly today: `ELEVENLABS_TOOL_SECRET` (the production boot requires it), `PUBLIC_BASE_URL` and
  `ALLOW_SPEND=true` (both in fly.toml). Still missing: `ELEVENLABS_API_KEY`,
  `ELEVENLABS_AGENT_ID` and `ELEVENLABS_WEBHOOK_SECRET`. The server lists them itself:

  ```sh
  curl -s -H "X-YO-Demo-Key: $DEMO_ADMIN_TOKEN" https://youre-on.fly.dev/v1/demo/voice | jq .missing
  ```

- A voice conversation is a billed ElevenLabs session (agent minutes plus the agent LLM). Every
  conversation token the server mints starts one. `ALLOW_SPEND=true` is already on, because the
  live LLM judge needs it. To stop the voice spend, see the last section.

## 1. Local env for the script (never commit it)

In `apps/server/.env` (gitignored), on the laptop:

```sh
ELEVENLABS_API_KEY=<the new key>
ELEVENLABS_TOOL_SECRET=<the SAME value as the Fly secret>
PUBLIC_BASE_URL=https://youre-on.fly.dev
ELEVENLABS_JUDGE_VOICE_ID=<the Voice Design voice id, optional>
```

If nobody has the Fly value of `ELEVENLABS_TOOL_SECRET`, pick a new one
(`openssl rand -base64 32`). Put it in `.env`, run step 2 with `--rotate-secret`, and set the same
value on Fly in step 4.

## 2. Create the agent: `scripts/el-agent.ts`

First, an offline check that sends nothing. It fetches the public OpenAPI document and no key is
used:

```sh
npm run el-agent -- --dry-run --check-openapi
```

Expect `every body matches`, then four webhook tools (`propose_terms`, `confirm_terms`,
`get_market_odds` and `request_review`, each `POST https://youre-on.fly.dev/el/tools/<name>`), three
client tools (`request_attempt`, `show_terms_card`, `cue`), the built-in `skip_turn` in the agent
body (`prompt.built_in_tools`), and an `llm` line with `claude-haiku-5-5` and
`reasoning_effort=low`. The secret is printed by reference only.

Then create the agent for real:

```sh
npm run el-agent -- --check-openapi          # add --rotate-secret if step 1 picked a new value
```

It ends with:

```
ELEVENLABS_AGENT_ID=agent_...
next: fly secrets set ELEVENLABS_AGENT_ID=agent_... -a youre-on   (and ... in apps/server/.env)
```

**Odds (feat/odds).** Since the odds work, `DEFAULT_WEBHOOK_TOOLS` includes `suggest_odds`
(`POST /el/tools/suggest_odds`) and `propose_terms` has the optional `stake_b_usd`. Run this sync
only after that server is deployed (the new tool's route must exist): it creates the
`suggest_odds` tool and PATCHes the live agent's tool ids and prompt (the `# Odds` section). The
old agent keeps working until then (`stake_b_usd` is not required). Running it against the live
agent is the owner's call.

Run it once more. It must print `no changes (no-op)`. If you pass `--llm <id>`, also set
`ELEVENLABS_AGENT_LLM=<id>` on Fly. The post-call check compares the billed model against it.

## 3. Create the post-call webhook in the ElevenLabs dashboard

ElevenLabs dashboard, Agents Platform settings, post-call webhook (the exact menu names may
differ):

- **URL:** `https://youre-on.fly.dev/webhooks/elevenlabs` (`webhook_url` in `/v1/demo/voice`).
- **Auth:** HMAC. Copy the signing secret ElevenLabs shows: it is `ELEVENLABS_WEBHOOK_SECRET`.
- **Events:** transcription on. **Audio off.** The server discards audio (DATA-MODEL §10), and a
  long call's audio is over the 16 MiB body cap. **Call initiation failure:** on, if offered.
- If the webhook is workspace-wide, other agents' calls are acknowledged and not stored
  (`voice.webhook_ignored`).

Do step 4 straight away. Until the secret is on Fly, the route answers 404, and ElevenLabs
auto-disables a webhook that keeps failing.

## 4. Fly secrets (one command = one restart)

Every secret change restarts the machine, so do not run it during a demo:

```sh
fly secrets set -a youre-on \
  ELEVENLABS_API_KEY='<key>' \
  ELEVENLABS_AGENT_ID='agent_...' \
  ELEVENLABS_WEBHOOK_SECRET='<signing secret from step 3>'
# only if step 1 picked a new tool secret:  ELEVENLABS_TOOL_SECRET='<new value>'
# only if step 2 used --llm:                ELEVENLABS_AGENT_LLM='<id>'
```

Optional, the Voice Design voice: put `ELEVENLABS_JUDGE_VOICE_ID` in `apps/server/.env` and
re-run step 2, because the agent carries the voice. Add it to the command above too. The server
does not use it, but without it `/v1/demo/voice` keeps listing it under `optional`.

## 5. Check the config (no phone, no ElevenLabs call)

```sh
curl -s -H "X-YO-Demo-Key: $DEMO_ADMIN_TOKEN" https://youre-on.fly.dev/v1/demo/voice | jq
fly logs -a youre-on | grep voice.readiness
```

Expect `"ready": true`, `"judge_ready": true`, `"missing": []`, three `tool_urls` and the
`webhook_url`. Each entry in `missing` names the setting to fix. `optional` lists only
`ELEVENLABS_JUDGE_VOICE_ID` when it is unset. An unsigned
`curl -s -X POST https://youre-on.fly.dev/webhooks/elevenlabs` now answers 401
`SIGNATURE_INVALID` with `"reason":"missing"`. A 404 means the secret did not reach the server.

**Webhook secret check.** Sign one harmless event with the secret and send it. A wrong secret
gets a 401:

```sh
BODY='{"type":"call_initiation_failure","data":{"agent_id":"agent_...","conversation_id":"conv_golive_check","failure_reason":"go-live signature check"}}'
T=$(date +%s)
SIG=$(printf '%s' "$T.$BODY" | openssl dgst -sha256 -hmac "$ELEVENLABS_WEBHOOK_SECRET" | awk '{print $NF}')
curl -s -X POST https://youre-on.fly.dev/webhooks/elevenlabs \
  -H 'Content-Type: application/json' -H "ElevenLabs-Signature: t=$T,v0=$SIG" --data-binary "$BODY"
```

Expect `{"ok":true,"type":"call_initiation_failure","conversation_id":"conv_golive_check","duplicate":false}`
and a `voice.call_initiation_failure` line in the logs. A second send prints `"duplicate":true`.
With another agent id, the response carries `"ignored":"foreign_agent"` (still signed correctly).
The check writes one `audit_log` row, labeled with its failure reason.

**Tool secret check (Beat 6 odds).** This reads the Gemini relay. It costs nothing and touches no
chain:

```sh
curl -s -X POST https://youre-on.fly.dev/el/tools/get_market_odds \
  -H 'Content-Type: application/json' -H "X-YO-Tool-Secret: $ELEVENLABS_TOOL_SECRET" \
  -d '{"conversation_id":"conv_golive_check","asset":"BTC","horizon":"5m","a_side":"YES","amount_usd":"2"}'
```

Expect `{"ok":true,"odds":"..","a":"$..","b":"$..",...}`, or `{"ok":false,"fix":..,"say":..}`
when no round is lockable. A 401 means Fly's `ELEVENLABS_TOOL_SECRET` is not the value in
`apps/server/.env`. Fix it with step 2 `--rotate-secret` plus step 4.

## 6. The server half end to end: `cp1-drive --via-tools`

This sends the terms and the confirm exactly as the agent does: `POST /el/tools/propose_terms`,
then `/el/tools/confirm_terms` with `X-YO-Tool-Secret`, on a conversation bound by `POST /v1/bets`.
It then waits for LOCKED. There is no phone and no ElevenLabs call, but it locks a $1 fixture bet
on devnet between the demo wallets (their keys come from `--keys-dir`, default
`~/.config/solana/youre-on`, or `DEMO_A_SECRET_KEY` / `DEMO_B_SECRET_KEY`):

```sh
npx tsx --env-file=apps/server/.env scripts/cp1-drive.ts \
  --base-url https://youre-on.fly.dev --admin-token "$DEMO_ADMIN_TOKEN" --via-tools
```

Expect `propose_terms: {"ok":true,...,"next":"readback"}`, then `terms .. confirmed by the judge`,
then `LOCKED in .. ms after confirm. lock tx <sig>`. Add `--through paid` to go on to the payout.
`POST /v1/demo/reset` refunds rehearsal bets.

## 7. The first real call (two phones)

A dashboard test call works too, and is billed like any call. It has no `voice_sessions` row, so
it is archived with no bet (`voice.post_call_unknown_conversation`). Use it to see which LLM served
before the phones do.

Watch `fly logs -a youre-on`:

| Log line                                | Meaning, and what to do                                                                                                                                                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `voice.token_minted`                    | A's phone got a conversation (`voice_session_id`, `conversation_id`, `bet_id`).                                                                                                                                                                               |
| `voice.token_failed`                    | ElevenLabs refused the token (`kind`, `status`): check the key and `ELEVENLABS_AGENT_ID`. The phone falls back to typed terms.                                                                                                                                |
| `voice.spend_disabled`                  | Key set but `ALLOW_SPEND` is not true: tokens are refused.                                                                                                                                                                                                    |
| `el_tool.call`                          | One per tool call: `tool`, `status`, `latency_ms` (the budget is the 5 s `response_timeout_secs`).                                                                                                                                                            |
| `el_tool.unauthorized`                  | Wrong `X-YO-Tool-Secret`: re-run step 2 with `--rotate-secret` using the Fly value.                                                                                                                                                                           |
| `voice.post_call`                       | After each call: `llms` (the models ElevenLabs billed), `expected_llm`, `llm_match: true`, `turns`, `transcript_sha256`. This is the evidence that Haiku 5.5 served.                                                                                          |
| `voice.llm_mismatch` (warn)             | Another model billed the call (a backup LLM or an override): check the agent's `llm` and `backup_llm_config`.                                                                                                                                                 |
| `voice.webhook_rejected` (error, alert) | `reason`: `bad_signature` (Fly's `ELEVENLABS_WEBHOOK_SECRET` differs from the dashboard's), `stale` (a timestamp off by more than 30 min, or 5 min ahead), `missing` / `malformed`. Fix it, then re-enable the webhook in ElevenLabs if it was auto-disabled. |
| `voice.webhook_unconfigured`            | `ELEVENLABS_WEBHOOK_SECRET` is unset on Fly: every delivery gets a 404.                                                                                                                                                                                       |
| `voice.post_call_duplicate`             | A redelivery: ignored (dedupe on conversation_id + type).                                                                                                                                                                                                     |
| `voice.post_call_audio_discarded`       | Audio is switched on in the webhook settings: turn it off.                                                                                                                                                                                                    |
| `voice.call_initiation_failure`         | The call never started (`failure_reason`).                                                                                                                                                                                                                    |
| `voice.webhook_ignored`                 | Another agent's conversation in the same workspace.                                                                                                                                                                                                           |
| `voice.transcript_redacted`             | ElevenLabs echoed a secret (for example a tool header) in the transcript. It was stored as `[redacted]`.                                                                                                                                                      |

The phones need no new build for this: they get the agent through `POST /v1/voice/tokens`.

## 7b. The stage voice (no phone needed)

The same key turns on the projector's ElevenLabs voice: the rulings, payouts and appeal votes as
Text to Speech clips, and the stage cues as Sound Effects (`SFX_PROVIDER=auto`, the default). It
needs `ELEVENLABS_API_KEY` and `ALLOW_SPEND=true` and nothing else. The key needs the Text to
Speech and Sound Effects permissions.

- After the restart, the `server.listening` log line says `stage_tts: "on"` and `sfx: "live"`
  (else `stage_tts` names what is missing: `no_key`, `spend_disabled` or `off`), and
  `fly logs -a youre-on | grep stage_voice.sfx_ready` shows the four cues generated at boot (about
  6.5 seconds of Sound Effects in total).
- Open the stage and press a key. The bottom strip says `Voice ElevenLabs`.
- With the stage open, rehearse one bet (`cp1-drive --through paid`). Each ruling and payout logs
  `stage_voice.line` (the text and the clip id), then `stage_voice.tts` (characters, bytes, ms).
  `stage_voice.tts_failed` gives `status` (401: the key; 429: the quota). A clip that is late or
  fails is spoken by the browser instead, so the hall always hears it.
- In a bet the voice judge hosts (A's phone has relayed its transcript), the ruling and payout log
  `stage_voice.phone_judge` instead, and the projector stays quiet for them: the judge on A's phone
  says them, so the hall hears one voice. That needs no switch (`V` and `STAGE_TTS=off` are not
  for it), and the appeal votes are still voiced on the stage.
- Cost: one TTS request per new line (at most 300 characters). A repeated line is served from
  the cache, and nothing is generated while no stage is connected to the room.
- Voices: the judge is `ELEVENLABS_JUDGE_VOICE_ID` (the Voice Design voice), else a premade voice;
  the three appeal seats are `ELEVENLABS_PANEL_VOICE_IDS` (three comma-separated ids), else three
  premade voices. `STAGE_TTS_MODEL` overrides `eleven_v4_turbo`. Each is a Fly secret or a
  `fly.toml [env]` value, and changing one restarts the machine.
- To switch the stage voice off (the browser voice takes over):
  `fly secrets set STAGE_TTS=off -a youre-on`. That restarts the machine, so do it before the pitch.
  Pressing `V` on the projector silences the voice for that page only.

## 8. Where the transcripts are

There is no object store yet, so each transcript is one append-only `audit_log` row (action
`el_webhook.post_call_transcription`). `voice_sessions.transcript_key` is `audit_log:<id>`, and
`transcript_sha256` is sha256 of the stored JCS transcript. Check them read-only (Neon,
`DATABASE_URL_DIRECT` from the laptop):

```sql
SELECT v.el_conversation_id, v.status, v.ended_at, a.details->'llms' AS llms,
       encode(sha256(convert_to(a.details->>'transcript_json', 'UTF8')), 'hex')
         = v.transcript_sha256 AS hash_ok
FROM voice_sessions v JOIN audit_log a ON v.transcript_key = 'audit_log:' || a.id
ORDER BY v.ended_at DESC LIMIT 5;
```

`details.metadata.charging` (with `llm_usage`), `details.analysis` and `details.client_data` are
kept with each transcript as evidence.

## Switching the voice judge off

`fly secrets unset ELEVENLABS_AGENT_ID -a youre-on` (one restart). Tokens then answer 502
`not_configured`, A's phone types the terms instead, and no new voice session is billed. Do not
set `ALLOW_SPEND=false` for this: with `LLM_PROVIDER=live` the server then refuses to boot (the
spend guard).
