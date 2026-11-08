/**
 * Demo setup: two simulated phones sign in (§12.1), enroll face + voice with
 * consent (§8, init_profile signed by the wallet), take the demo faucet drip,
 * and form a huddle (code join + the creator's face scan confirms members).
 */
import { AppClient } from './client.js';
import { frameJpeg, speechWav } from './media.js';
import type { Transcript } from './transcript.js';
import { usd } from './transcript.js';

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

export interface Crew {
  alice: AppClient;
  bob: AppClient;
  huddleId: string;
  code: string;
}

export async function signIn(baseUrl: string, name: string, email: string, t: Transcript): Promise<AppClient> {
  const c = new AppClient(baseUrl, name, email);
  const user = await c.login();
  t.step(name, `signed in (wallet ${c.wallet.publicKey.slice(0, 6)}…, user ${String(user['id']).slice(0, 8)})`);
  return c;
}

export async function enroll(c: AppClient, t: Transcript): Promise<void> {
  const ch = await c.get<{ challenge_id: string; face_prompts: string[]; voice_phrases: string[] }>('/enroll/challenge');
  const face = await c.post<{ ok: boolean; liveness: boolean }>('/enroll/face', {
    challenge_id: ch.challenge_id,
    frames_b64: [frameJpeg(), frameJpeg(), frameJpeg()].map(b64),
  });
  t.check(`${c.name} face liveness`, face.liveness === true);
  await c.post('/enroll/voice', { challenge_id: ch.challenge_id, clips_b64: [speechWav(), speechWav(), speechWav()].map(b64) });
  const done = await c.post<{ face_commit: string; voice_commit: string; sign: never }>('/enroll/complete', { consent: true, display_name: c.name });
  await c.signConfirmed(done.sign, 'init_profile');
  const me = await c.get<{ enrolled: { face: boolean; voice: boolean } }>('/me');
  t.check(`${c.name} enrolled`, me.enrolled.face && me.enrolled.voice);
  t.step(c.name, `enrolled (prompts ${ch.face_prompts.join('/')}; face ${done.face_commit.slice(0, 8)}…, voice ${done.voice_commit.slice(0, 8)}…) → init_profile signed`);
  const f = await c.post<{ usdc_units: number }>('/faucet');
  t.step(c.name, `faucet → balance ${usd(f.usdc_units)}`);
}

export async function formHuddle(alice: AppClient, bob: AppClient, t: Transcript): Promise<Crew> {
  const h = await alice.post<{ huddle_id: string; code: string }>('/huddles');
  t.step(alice.name, `POST /huddles → code ${h.code}`);
  const joined = await bob.post<{ members: unknown[] }>('/huddles/join', { code: h.code });
  t.step(bob.name, `joined huddle with code (${joined.members.length} members, unconfirmed)`);
  const scan = await alice.post<{ matches: { user: { display_name: string } | null; matched: boolean; cos_bps: number }[] }>(
    `/huddles/${h.huddle_id}/scan`,
    { faces: [{ crop_b64: b64(frameJpeg()), bbox: [5200, 1800, 6800, 4200] }] },
    { 'x-mock-subject': bob.userId },
  );
  const m = scan.matches[0];
  t.check('huddle face scan matched Bob', !!m?.matched && m.user?.display_name === bob.name);
  t.step(alice.name, `camera scan → ${m?.user?.display_name ?? 'nobody'} matched (cos ${m?.cos_bps ?? 0} bps), confirmed`);
  const view = await alice.get<{ members: { confirmed: boolean }[] }>(`/huddles/${h.huddle_id}`);
  t.check('all huddle members confirmed', view.members.every((x) => x.confirmed));
  return { alice, bob, huddleId: h.huddle_id, code: h.code };
}
