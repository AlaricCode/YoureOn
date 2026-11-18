#!/usr/bin/env -S npx tsx
// Judge eval (TASKS E3-7): run the PRODUCTION attempt judge over real bottle-flip clips and score
// it, so prompt changes and the model choice are decided on data, not vibes.
//
//   ANTHROPIC_API_KEY=... npm run judge-eval -- --clips <dir> [--frames 12] [--models a,b]
//       [--runs 1] [--out docs/judge-eval.md] [--json results.json] [--max-px 1024] [--mock]
//   --mock: no model call (MockLlm), to check ffmpeg / labels / the report before spending.
//
// Clips: any video ffmpeg reads. The expected answer comes from the file name prefix
//   made_* / landed_* / met_*      -> MET     (the performer wins)
//   miss_* / fail_* / notmet_*     -> NOT_MET (the other party wins)
//   ambig_* / unclear_* / redo_*   -> UNCLEAR (a REDO is the right call)
// or from <dir>/labels.json: { "<file>": "MET" | "NOT_MET" | "UNCLEAR" } (wins over the prefix).
//
// Frames are sampled like the phone does (apps/mobile judge cam: 8-12 stills spread over the clip),
// downscaled to --max-px, JPEG. Each clip goes through the same judgeFrames() + buildRuling() the
// server uses (apps/server/src/judge), including the deterministic bottle checks and REDO_BELOW.
// Scoring: a "wrong winner" (decisive and wrong) is the only unacceptable error; a REDO on a clean
// clip costs a re-try, not money. Target: 0 wrong winners, REDO rate <= 25% on clean clips.
// Costs real money (one vision call per clip per model per run). Needs ffmpeg on PATH.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { sha256Hex } from '@youre-on/shared/primitives';
import type { Terms } from '@youre-on/shared/terms';
import { loadEnv } from '../apps/server/src/env';
import { createLogger } from '../apps/server/src/log';
import { MockLlm } from '../apps/server/src/providers/mock/llm';
import { createProviders } from '../apps/server/src/providers/registry';
import { buildRuling, judgeFrames, type Judged } from '../apps/server/src/judge/ruling';
import { parseCli, run } from './lib/cli';

type Expected = 'MET' | 'NOT_MET' | 'UNCLEAR';

const USAGE = `usage: npm run judge-eval -- --clips <dir> [--frames 12] [--models <m1,m2>] [--runs 1]
       [--out <report.md>] [--json <results.json>] [--max-px 1024] [--mock]
Needs ANTHROPIC_API_KEY and ffmpeg. Expected answers from file-name prefixes or <dir>/labels.json.`;

const VIDEO_EXT = new Set(['.mov', '.mp4', '.m4v', '.avi', '.mkv', '.webm']);

/** The binding terms every clip is judged against (the demo bet; SCHEMAS terms-v1-001 shape). */
function demoTerms(): Terms {
  return {
    schema_version: 1,
    bet_id: randomUUID(),
    escrow: {
      cluster: 'devnet',
      program_id: 'BL3gwTBcftGQFdPNp7rZiAyDojkSusdAJ2dzNvFouwcp',
      mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    },
    party_a: { pubkey: '7wiFKtDnNvdJwZgw3i6x8Zi6Q5GC2kTGpfRDARQyi1sy', display_name: 'Logan' },
    party_b: { pubkey: '7BFWFKZwDdmEVBthxD1xroSGj6XexqAhMzq5WYuv4pNm', display_name: 'Jake' },
    type: 'skill',
    claim: 'Jake lands a water bottle flip upright on the table.',
    performer: 'B',
    yes_party: 'B',
    attempts: { count: 1, rule: 'single' },
    success_criteria: [
      'The bottle rotates at least once in the air.',
      'The bottle comes to rest standing upright on its base.',
    ],
    failure_criteria: [
      'The bottle ends on its side, upside down, or off the table.',
      'Jake touches the bottle after releasing it.',
    ],
    edge_cases: [
      {
        question: 'Does landing on the cap count?',
        answer: 'No. Only upright on its base counts.',
        asked_by: 'judge',
      },
    ],
    evidence_source: 'camera',
    market: null,
    stakes: { a: '1000000', b: '1000000', currency: 'USDC' },
    deadline: new Date(Date.now() + 10 * 60_000).toISOString().replace(/\.\d{3}Z$/, '.000Z'),
    created_at: new Date().toISOString(),
  } as Terms;
}

function expectedFor(file: string, labels: Record<string, Expected>): Expected | null {
  if (labels[file]) return labels[file]!;
  const p = basename(file).toLowerCase();
  if (/^(made|landed|met)[_-]/.test(p)) return 'MET';
  if (/^(miss|fail|notmet|not_met)[_-]/.test(p)) return 'NOT_MET';
  if (/^(ambig|ambiguous|unclear|redo)[_-]/.test(p)) return 'UNCLEAR';
  return null;
}

function durationSecs(path: string): number {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
    { encoding: 'utf8' },
  );
  const d = Number.parseFloat(out.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`cannot read the duration of ${path}`);
  return d;
}

/** N stills spread over the clip (the last one just before the end), JPEG, longest side maxPx. */
function extractFrames(
  path: string,
  n: number,
  maxPx: number,
): { t_ms: number; bytes: Uint8Array }[] {
  const dur = durationSecs(path);
  const dir = mkdtempSync(join(tmpdir(), 'yo-judge-eval-'));
  try {
    const frames: { t_ms: number; bytes: Uint8Array }[] = [];
    for (let i = 0; i < n; i++) {
      const t = Math.min(dur - 0.05, (dur * (i + 0.5)) / n);
      const file = join(dir, `f${i}.jpg`);
      execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-ss',
          t.toFixed(3),
          '-i',
          path,
          '-frames:v',
          '1',
          '-vf',
          `scale='if(gt(iw,ih),min(${maxPx},iw),-2)':'if(gt(iw,ih),-2,min(${maxPx},ih))'`,
          '-q:v',
          '3',
          '-y',
          file,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      frames.push({ t_ms: Math.round(t * 1000), bytes: new Uint8Array(readFileSync(file)) });
    }
    return frames;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Row {
  clip: string;
  model: string;
  run: number;
  expected: Expected;
  claim: string;
  confidence: number;
  outcome: string;
  disagreement: string | null;
  reason: string;
  latency_ms: number;
  verdict: 'correct' | 'redo' | 'WRONG_WINNER' | 'missed_redo' | 'error';
}

function score(expected: Expected, outcome: string): Row['verdict'] {
  // yes_party = B (the performer): MET -> B_WINS, NOT_MET -> A_WINS.
  const want = expected === 'MET' ? 'B_WINS' : expected === 'NOT_MET' ? 'A_WINS' : 'REDO';
  if (outcome === want) return 'correct';
  if (outcome === 'REDO' || outcome === 'VOID') return expected === 'UNCLEAR' ? 'correct' : 'redo';
  if (expected === 'UNCLEAR') return 'missed_redo'; // decisive on an ambiguous clip
  return 'WRONG_WINNER';
}

const pct = (a: number, b: number) => (b === 0 ? '-' : `${Math.round((100 * a) / b)}%`);
function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

run(async () => {
  const { values } = parseCli(USAGE, {
    clips: { type: 'string' },
    frames: { type: 'string' },
    models: { type: 'string' },
    runs: { type: 'string' },
    out: { type: 'string' },
    json: { type: 'string' },
    'max-px': { type: 'string' },
    mock: { type: 'boolean' },
  });
  if (!values.clips) throw new Error(`--clips is required\n\n${USAGE}`);
  const mock = values.mock ?? false; // pipeline smoke test (ffmpeg, scoring, report): no model call
  if (!mock && !process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  const nFrames = Number(values.frames ?? 12);
  if (!Number.isInteger(nFrames) || nFrames < 4 || nFrames > 16)
    throw new Error('--frames must be 4..16');
  const runs = Number(values.runs ?? 1);
  const maxPx = Number(values['max-px'] ?? 1024);

  const labelsPath = join(values.clips, 'labels.json');
  const labels: Record<string, Expected> = existsSync(labelsPath)
    ? (JSON.parse(readFileSync(labelsPath, 'utf8')) as Record<string, Expected>)
    : {};
  const clips = readdirSync(values.clips)
    .filter((f) => VIDEO_EXT.has(extname(f).toLowerCase()))
    .sort()
    .map((f) => ({ file: f, expected: expectedFor(f, labels) }));
  const unlabeled = clips.filter((c) => !c.expected).map((c) => c.file);
  if (unlabeled.length) console.warn(`skipping unlabeled clips: ${unlabeled.join(', ')}`);
  const todo = clips.filter((c): c is { file: string; expected: Expected } => !!c.expected);
  if (!todo.length) throw new Error(`no labeled clips in ${values.clips}`);

  const base = loadEnv({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgres://unused@127.0.0.1:1/none',
    LLM_PROVIDER: 'live',
    ALLOW_SPEND: 'true',
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? 'mock-run',
  });
  const providers = createProviders(base, mock ? { overrides: { llm: new MockLlm() } } : {});
  const log = createLogger('warn');
  const models = (values.models ?? base.JUDGE_MODEL).split(',').map((m) => m.trim());
  const terms = demoTerms();

  const rows: Row[] = [];
  for (const clip of todo) {
    const frames = extractFrames(join(values.clips, clip.file), nFrames, maxPx);
    const frameHashes = frames.map((f) => sha256Hex(f.bytes));
    for (const model of models) {
      for (let r = 1; r <= runs; r++) {
        const env = { ...base, JUDGE_MODEL: model, CACHED_RULING: false };
        const t0 = performance.now();
        let judged: Judged;
        try {
          judged = await judgeFrames(
            { env, providers, log },
            { terms, performer_name: 'Jake', frames },
          );
        } catch (e) {
          judged = { kind: 'failure', model, status: 'error', message: String(e) };
        }
        const latency = Math.round(performance.now() - t0);
        const ruling = buildRuling(
          {
            ruling_id: randomUUID(),
            bet_id: terms.bet_id,
            attempt_no: 1,
            yes_party: 'B',
            terms_hash: sha256Hex('eval'),
            evidence_hash: sha256Hex(clip.file),
            frame_hashes: frameHashes,
            created_at: new Date().toISOString(),
          },
          judged,
        );
        const row: Row = {
          clip: clip.file,
          model,
          run: r,
          expected: clip.expected,
          claim:
            judged.kind === 'verdict' ? judged.verdict.claim_result : `failure:${judged.status}`,
          confidence: judged.kind === 'verdict' ? judged.verdict.confidence : 0,
          outcome: ruling.outcome,
          disagreement: judged.kind === 'verdict' ? judged.disagreement : judged.message,
          reason: ruling.reason,
          latency_ms: latency,
          verdict: judged.kind === 'failure' ? 'error' : score(clip.expected, ruling.outcome),
        };
        rows.push(row);
        console.log(
          `${row.verdict.padEnd(12)} ${clip.file.padEnd(28)} ${model.padEnd(20)} expected ${row.expected.padEnd(7)} -> ${row.outcome.padEnd(6)} (${row.claim} ${row.confidence.toFixed(2)}) ${latency} ms`,
        );
      }
    }
  }

  // ---- report --------------------------------------------------------------------------------
  const lines: string[] = [
    '# Judge eval',
    '',
    `${todo.length} clips, ${nFrames} frames each, ${runs} run(s) per model. Terms: the demo bottle flip (performer B).`,
    'Wrong winner = decisive and wrong (the only error that moves money the wrong way).',
    '',
    '| Model | Correct | Wrong winner | REDO on a clean clip | Decisive on an ambiguous clip | Errors | p50 latency | p95 latency |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const model of models) {
    const rs = rows.filter((r) => r.model === model);
    const clean = rs.filter((r) => r.expected !== 'UNCLEAR');
    const n = (v: Row['verdict']) => rs.filter((r) => r.verdict === v).length;
    const lat = rs.map((r) => r.latency_ms);
    lines.push(
      `| ${model} | ${n('correct')}/${rs.length} (${pct(n('correct'), rs.length)}) | ${n('WRONG_WINNER')} | ${pct(n('redo'), clean.length)} | ${n('missed_redo')} | ${n('error')} | ${quantile(lat, 0.5)} ms | ${quantile(lat, 0.95)} ms |`,
    );
  }
  lines.push(
    '',
    '| Clip | Expected | Model | Outcome | Claim (conf.) | Result | Reason |',
    '|---|---|---|---|---|---|---|',
  );
  for (const r of rows) {
    lines.push(
      `| ${r.clip} | ${r.expected} | ${r.model} | ${r.outcome} | ${r.claim} (${r.confidence.toFixed(2)}) | ${r.verdict} | ${r.reason.replace(/\|/g, '/')} |`,
    );
  }
  const report = `${lines.join('\n')}\n`;
  console.log(`\n${report}`);
  if (values.out) writeFileSync(values.out, report);
  if (values.json) writeFileSync(values.json, `${JSON.stringify(rows, null, 2)}\n`);
  const wrong = rows.filter((r) => r.verdict === 'WRONG_WINNER').length;
  if (wrong) process.exitCode = 2;
});
