#!/usr/bin/env -S npx tsx
// SAM 3.1 smoke test, for any challenge: sample frames from a clip, send them to the SAM 3.1
// endpoint on Modal (services/sam3/modal_app.py) with one or more text prompts naming what to
// find, and print what it found on each frame, the per-object tracks (measurements only, no
// verdict) and the timings. Frames are fit to 512 px like the phone's.
//   --sampling uniform  n frames spread evenly over the clip (default)
//   --sampling judge    the phone's attempt sampler (packages/shared/src/judge/frames.ts: 4 lead-in
//                       frames, the rest packed into the last ~1.2 s), i.e. what the server holds
//                       for a real attempt. The landing crop is left out: it is a different view
//                       of the last frame, not part of the sequence SAM tracks through.
//
//   npm run sam3-smoke -- --clip <video> --prompt "<thing>" [--prompt "<other thing>"]
//       [--sampling uniform|judge] [--frames 12] [--url https://...modal.run]
//       [--save-frames <dir>] [--json out.json] [--masks]
//   --masks  also return each mask (run-length encoded) in the --json output
//
// Env: SAM3_URL (or --url), SAM3_API_TOKEN (the bearer token; also read from
// ~/.config/youre-on/sam3.env). Needs ffmpeg on PATH. Each call is billed GPU time on Modal; the
// first call after the app scales to zero also pays the cold start (container + model load).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import {
  fitSize,
  FRAME_MAX_PX,
  judgeFrameTimesMs,
  JUDGE_FRAMES,
} from '@youre-on/shared/judge/frames';

const DEFAULT_URL = 'https://loganstaples--youre-on-sam3.us-east.modal.run';
const TOKEN_FILE = join(homedir(), '.config', 'youre-on', 'sam3.env');

const MAX_PROMPTS = 4;

const USAGE = `usage: npm run sam3-smoke -- --clip <video> --prompt "<thing>" [--prompt ...] (1-${MAX_PROMPTS})
  [--sampling uniform|judge] [--frames 12] [--url <endpoint>] [--save-frames <dir>] [--json <file>] [--masks]
Env: SAM3_URL, SAM3_API_TOKEN (else ${TOKEN_FILE}). Needs ffmpeg.`;

type Box = [number, number, number, number];
interface SamObject {
  id: number;
  score?: number;
  box_xyxy: Box | null;
  box_all_xyxy: Box | null;
  components: number;
  mask_area: number;
}
interface TrackEnd {
  index: number;
  mask_area: number;
  box_xyxy: Box;
  aspect_h_over_w: number | null;
}
interface SamTrack {
  id: number;
  frames: number[];
  missing: number[];
  max_score: number;
  first: TrackEnd;
  last: TrackEnd;
}
interface SamResult {
  prompt: string;
  frames: { index: number; objects: SamObject[] }[];
  tracks: SamTrack[];
  timing_ms: Record<string, number>;
}
interface SamReply {
  model: string;
  rev: string;
  gpu: string;
  results: SamResult[];
  timing_ms: Record<string, number>;
  boot_ms: Record<string, number>;
}

function token(): string {
  const env = process.env['SAM3_API_TOKEN'];
  if (env) return env;
  if (existsSync(TOKEN_FILE)) {
    const m = /^SAM3_API_TOKEN=(.+)$/m.exec(readFileSync(TOKEN_FILE, 'utf8'));
    if (m?.[1]) return m[1].trim();
  }
  throw new Error(`no SAM3_API_TOKEN (env or ${TOKEN_FILE})`);
}

/** Duration in ms from ffmpeg's own header line (no ffprobe needed). */
function durationMs(clip: string): number {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', clip], { encoding: 'utf8' });
  const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(r.stderr ?? '');
  if (!m) throw new Error(`cannot read the duration of ${clip} (is ffmpeg on PATH?)`);
  return Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000);
}

/** One still at tMs, autorotated upright (as the phone's thumbnailer), through an optional vf. */
function still(clip: string, tMs: number, vf: string | null, file: string): Buffer {
  execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-ss',
      (tMs / 1000).toFixed(3),
      '-i',
      clip,
      '-frames:v',
      '1',
      ...(vf ? ['-vf', vf] : []),
      '-q:v',
      '3',
      '-y',
      file,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  return readFileSync(file);
}

/** Width and height of a PNG from its IHDR chunk. */
function pngSize(png: Buffer): { width: number; height: number } {
  if (png.toString('ascii', 12, 16) !== 'IHDR') throw new Error('not a PNG');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** n instants spread evenly from the first frame to just before the end. */
function uniformTimesMs(durationMs: number, n: number): number[] {
  const last = Math.max(0, durationMs - 80); // a still at the very end can come back empty
  return Array.from({ length: n }, (_, i) => Math.round(n === 1 ? 0 : (last * i) / (n - 1)));
}

function sample(clip: string, n: number, sampling: 'uniform' | 'judge', saveDir: string | null) {
  const duration_ms = durationMs(clip);
  const times =
    sampling === 'judge' ? judgeFrameTimesMs(duration_ms, n) : uniformTimesMs(duration_ms, n);
  const dir = mkdtempSync(join(tmpdir(), 'yo-sam3-'));
  try {
    const src = pngSize(still(clip, times.at(-1)!, null, join(dir, 'full.png')));
    const fit = fitSize(src.width, src.height, FRAME_MAX_PX);
    const frames = times.map((t_ms, i) => ({
      t_ms,
      bytes: still(clip, t_ms, `scale=${fit.width}:${fit.height}`, join(dir, `f${i}.jpg`)),
    }));
    if (saveDir) {
      mkdirSync(saveDir, { recursive: true });
      frames.forEach((f, i) =>
        writeFileSync(join(saveDir, `${String(i).padStart(2, '0')}.jpg`), f.bytes),
      );
    }
    return { duration_ms, src, fit, frames };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      clip: { type: 'string' },
      prompt: { type: 'string', multiple: true },
      sampling: { type: 'string', default: 'uniform' },
      frames: { type: 'string', default: String(JUDGE_FRAMES) },
      url: { type: 'string' },
      'save-frames': { type: 'string' },
      json: { type: 'string' },
      masks: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const prompts = (values.prompt ?? []).map((p) => p.trim()).filter(Boolean);
  if (values.help || !values.clip || prompts.length === 0 || prompts.length > MAX_PROMPTS) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }
  if (values.sampling !== 'uniform' && values.sampling !== 'judge')
    throw new Error(`--sampling must be uniform or judge, got ${values.sampling}`);
  const sampling = values.sampling;
  const url = (values.url ?? process.env['SAM3_URL'] ?? DEFAULT_URL).replace(/\/$/, '');
  const s = sample(values.clip, Number(values.frames), sampling, values['save-frames'] ?? null);
  const kb = s.frames.reduce((a, f) => a + f.bytes.length, 0) / 1024;
  console.log(
    `clip ${values.clip}: ${s.duration_ms} ms, ${s.src.width}x${s.src.height} -> ${s.frames.length} frames ` +
      `at ${s.fit.width}x${s.fit.height} (${kb.toFixed(0)} KB total)`,
  );
  console.log(`${sampling} sampling, frame times (ms): ${s.frames.map((f) => f.t_ms).join(' ')}`);

  const t0 = performance.now();
  const res = await fetch(`${url}/segment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
    body: JSON.stringify({
      prompts,
      masks: values.masks,
      frames: s.frames.map((f) => f.bytes.toString('base64')),
    }),
    signal: AbortSignal.timeout(600_000),
  });
  const roundTrip = Math.round(performance.now() - t0);
  if (!res.ok)
    throw new Error(
      `POST ${url}/segment -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  const r = (await res.json()) as SamReply;

  console.log(`\n${r.model} on ${r.gpu} (rev ${r.rev})`);
  const box = (b: Box | null) => (b ? b.join(',') : '-');
  for (const res of r.results) {
    console.log(`\nprompt "${res.prompt}"`);
    for (const f of res.frames) {
      const objs = f.objects
        .map((o) => {
          const blobs = o.components > 1 ? ` blobs=${o.components} all=${box(o.box_all_xyxy)}` : '';
          return `#${o.id} ${o.score?.toFixed(2) ?? '?'} box=${box(o.box_xyxy)} area=${o.mask_area}${blobs}`;
        })
        .join('  ');
      const t = String(s.frames[f.index]?.t_ms).padStart(5);
      console.log(`  frame ${String(f.index).padStart(2)} @${t} ms: ${objs || '(nothing)'}`);
    }
    const found = res.frames.filter((f) => f.objects.some((o) => o.mask_area > 0)).length;
    console.log(`  found on ${found}/${res.frames.length} frames; ${res.tracks.length} track(s):`);
    for (const t of res.tracks) {
      const end = (e: TrackEnd) =>
        `frame ${e.index} box=${box(e.box_xyxy)} ${e.box_xyxy[2] - e.box_xyxy[0]}x${e.box_xyxy[3] - e.box_xyxy[1]} h/w=${e.aspect_h_over_w ?? '-'} area=${e.mask_area}`;
      const gaps = t.missing.length ? ` missing ${t.missing.join(',')}` : '';
      console.log(
        `    #${t.id} frames ${t.frames[0]}-${t.frames.at(-1)}${gaps}, best ${t.max_score.toFixed(2)}`,
      );
      console.log(`       first: ${end(t.first)}`);
      console.log(`       last:  ${end(t.last)}`);
    }
    console.log(`  timing (ms): ${JSON.stringify(res.timing_ms)}`);
  }
  console.log(
    `\nserver total: ${r.timing_ms['total']} ms; boot (ms): ${JSON.stringify(r.boot_ms)}`,
  );
  console.log(`round trip: ${roundTrip} ms (includes any cold start and upload)`);
  if (values.json) writeFileSync(values.json, JSON.stringify(r, null, 2));
}

main().catch((e: unknown) => {
  console.error(`sam3-smoke: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
