// The projector's audio routes: is the stage voiced (GET /v1/stage/audio), each spoken line's
// MP3 (GET /v1/stage/tts/:clip_id, which waits for a generation in flight) and the cue clips
// (GET /v1/stage/sfx/:kind). For a stage session's bearer only: anything else, a phone session
// included, gets 404. The ElevenLabs key stays here; the stage fetches the bytes with its bearer
// and plays them through its AudioContext. CORS comes from stageRoutes' '/v1/stage/*' middleware
// (mounted first, routes.ts).
// Spec: docs/planning/API-CONTRACT.md §2.17.
import type { Context, MiddlewareHandler } from 'hono';
import { StageCueKind } from '@youre-on/shared/api';
import { CLIP_ID_RE } from '@youre-on/shared/stage-voice';
import type { AppEnv, RouteModule } from '../context';
import { requireSession } from '../auth/middleware';
import { sha256Hex } from '../crypto';
import { HttpError } from '../errors';
import { UpstreamError } from '../voice/elevenlabs';

/** A clip never changes (its id is the hash of what it says). */
export const CLIP_CACHE_CONTROL = 'private, max-age=31536000, immutable';
/** A cue's clip changes only with its prompt (a deploy). */
export const SFX_CACHE_CONTROL = 'private, max-age=3600';

const stageOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('auth').scopes.includes('stage')) throw new HttpError('NOT_FOUND', 'Not found.');
  await next();
};

function audioResponse(
  c: Context<AppEnv>,
  bytes: Uint8Array,
  mime: string,
  etag: string,
  cacheControl: string,
): Response {
  const headers = {
    ETag: `"${etag}"`,
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
  };
  if (c.req.header('if-none-match') === headers.ETag)
    return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { ...headers, 'Content-Type': mime, 'Content-Length': String(bytes.length) },
  });
}

function upstream(err: unknown): never {
  if (err instanceof UpstreamError && err.kind === 'timeout')
    throw new HttpError('UPSTREAM_TIMEOUT', 'The voice took too long.');
  throw new HttpError('UPSTREAM_ERROR', "Couldn't make the voice clip.");
}

export const stageAudioRoutes: RouteModule = {
  name: 'stage-audio',
  register(app) {
    app.get('/v1/stage/audio', requireSession, stageOnly, (c) => {
      const voice = c.get('deps').stageVoice;
      c.header('Cache-Control', 'no-store');
      return c.json(voice?.status() ?? { tts: false, tts_off: 'off', model: null, sfx: null }, 200);
    });

    app.get('/v1/stage/tts/:clip_id', requireSession, stageOnly, async (c) => {
      const tts = c.get('deps').stageVoice?.tts;
      const id = c.req.param('clip_id');
      if (!tts || !CLIP_ID_RE.test(id)) throw new HttpError('NOT_FOUND', 'No such clip.');
      let bytes: Uint8Array | null;
      try {
        bytes = await tts.bytes(id);
      } catch (err) {
        upstream(err);
      }
      if (!bytes) throw new HttpError('NOT_FOUND', 'No such clip.');
      return audioResponse(c, bytes, 'audio/mpeg', id, CLIP_CACHE_CONTROL);
    });

    app.get('/v1/stage/sfx/:kind', requireSession, stageOnly, async (c) => {
      const voice = c.get('deps').stageVoice;
      const kind = StageCueKind.safeParse(c.req.param('kind'));
      if (!voice?.sfxLive || !kind.success) throw new HttpError('NOT_FOUND', 'No such cue.');
      let blob;
      try {
        blob = await voice.sfx(kind.data);
      } catch (err) {
        upstream(err);
      }
      return audioResponse(c, blob.bytes, blob.mime, sha256Hex(blob.bytes), SFX_CACHE_CONTROL);
    });
  },
};
