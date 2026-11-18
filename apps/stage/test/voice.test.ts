// The projector's voice (voice.ts): the ElevenLabs clip plays when its stage.voice frame comes in
// time; otherwise, and whenever the clip fails, the browser speaks the same line; lines queue in
// order; mute skips them; a line the phone judge says (a voice judge hosts the bet) is never said
// here. Plus which events are voiced (fresh ones, once; not the phone judge's), the stage.voice
// frame in the ticker, the speechSynthesis adapter, and StageAudio playing a decoded clip.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GENERATED_FOR, StageAudio } from '../src/sound';
import { applyFrame, initialTicker, type TickerState } from '../src/ticker';
import {
  browserSpeech,
  cancelSpeech,
  CLIP_WAIT_MS,
  freshVoiceLines,
  StageVoice,
  VOICE_WAIT_MS,
  voiceKey,
  type Playable,
  type VoiceHow,
  type VoiceIo,
} from '../src/voice';
import { previewAt } from '../src/preview';

const BET = '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f';
const CLIP = 'c'.repeat(64);
const line = (seq: number, text = 'Jake wins. Clean flip.') => ({
  key: voiceKey(BET, seq),
  voice: 'judge' as const,
  text,
});

/** A fake io: records loads, plays and speech; `loads` resolve when the test says so. */
function fakeIo() {
  const io = {
    loads: [] as Array<{ url: string; resolve: (p: Playable) => void; reject: (e: Error) => void }>,
    played: [] as string[],
    spoken: [] as string[],
    on: true,
    playable(name: string, ms = 0): Playable {
      return {
        play: () =>
          new Promise<void>((r) => {
            io.played.push(name);
            setTimeout(r, ms);
          }),
      };
    },
    impl: null as unknown as VoiceIo,
  };
  io.impl = {
    load: (url) =>
      new Promise<Playable>((resolve, reject) => io.loads.push({ url, resolve, reject })),
    speak: async (l) => {
      io.spoken.push(l.text);
    },
    on: () => io.on,
  };
  return io;
}

function voiceOf(io: ReturnType<typeof fakeIo>) {
  const v = new StageVoice(io.impl);
  const done: Array<[string, VoiceHow]> = [];
  v.onDone = (k, how) => done.push([k, how]);
  return { v, done };
}

describe('StageVoice: the clip, or the browser after the timeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('no clip within ~800 ms: speechSynthesis speaks the line, not before', async () => {
    const io = fakeIo();
    const { v, done } = voiceOf(io);
    v.expect(line(5));
    await vi.advanceTimersByTimeAsync(VOICE_WAIT_MS - 1);
    expect(io.spoken).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(io.spoken).toEqual(['Jake wins. Clean flip.']);
    expect(done).toEqual([[voiceKey(BET, 5), 'speech']]);
    expect(v.last).toBe('speech');
    // a frame that comes late is ignored: the line was already said
    v.clip({ key: voiceKey(BET, 5), url: `/v1/stage/tts/${CLIP}`, text: 'x' });
    await vi.advanceTimersByTimeAsync(CLIP_WAIT_MS);
    expect(io.loads).toEqual([]);
  });

  it('the clip arrives in time: it plays, and the browser stays silent', async () => {
    const io = fakeIo();
    const { v, done } = voiceOf(io);
    v.expect(line(6));
    await vi.advanceTimersByTimeAsync(300);
    v.clip({ key: voiceKey(BET, 6), url: `/v1/stage/tts/${CLIP}`, text: 'Jake wins. Clean flip.' });
    expect(io.loads.map((l) => l.url)).toEqual([`/v1/stage/tts/${CLIP}`]);
    // the server is still generating it past the 800 ms mark: no fallback, the frame said it comes
    await vi.advanceTimersByTimeAsync(1_500);
    expect(io.spoken).toEqual([]);
    io.loads[0]!.resolve(io.playable('ruling'));
    await vi.advanceTimersByTimeAsync(10);
    expect(io.played).toEqual(['ruling']);
    await vi.advanceTimersByTimeAsync(CLIP_WAIT_MS * 2);
    expect(io.spoken).toEqual([]);
    expect(done).toEqual([[voiceKey(BET, 6), 'clip']]);
  });

  it('a frame that comes before its event (one render) is matched to it', async () => {
    const io = fakeIo();
    const { v, done } = voiceOf(io);
    v.clip({ key: voiceKey(BET, 7), url: '/v1/stage/tts/a', text: 'Paid. Jake takes $2.00.' });
    v.expect(line(7, 'Paid. Jake takes $2.00.'));
    io.loads[0]!.resolve(io.playable('paid'));
    await vi.advanceTimersByTimeAsync(VOICE_WAIT_MS * 3);
    expect(io.played).toEqual(['paid']);
    expect(io.spoken).toEqual([]);
    expect(done).toEqual([[voiceKey(BET, 7), 'clip']]);
  });

  it('the clip fails, or never loads: the browser says the server text', async () => {
    const io = fakeIo();
    const { v, done } = voiceOf(io);
    v.expect(line(8));
    v.clip({ key: voiceKey(BET, 8), url: '/v1/stage/tts/a', text: 'Server words.' });
    io.loads[0]!.reject(new Error('HTTP 502'));
    await vi.advanceTimersByTimeAsync(1);
    expect(io.spoken).toEqual(['Server words.']);

    v.expect(line(9, 'Second.'));
    v.clip({ key: voiceKey(BET, 9), url: '/v1/stage/tts/b', text: 'Second.' });
    await vi.advanceTimersByTimeAsync(CLIP_WAIT_MS - 1);
    expect(io.spoken).toEqual(['Server words.']);
    await vi.advanceTimersByTimeAsync(1);
    expect(io.spoken).toEqual(['Server words.', 'Second.']);
    // and a clip that loads but cannot play (audio still locked) is said instead
    v.expect(line(10, 'Third.'));
    v.clip({ key: voiceKey(BET, 10), url: '/v1/stage/tts/c', text: 'Third.' });
    io.loads[2]!.resolve({ play: () => Promise.reject(new Error('locked')) });
    await vi.advanceTimersByTimeAsync(1);
    expect(io.spoken.at(-1)).toBe('Third.');
    expect(done.map((d) => d[1])).toEqual(['speech', 'speech', 'speech']);
  });

  it('lines take turns: a vote waits for the ruling before it to finish', async () => {
    const io = fakeIo();
    const { v } = voiceOf(io);
    v.expect(line(11, 'First.'));
    v.expect({ key: voiceKey(BET, 12), voice: 'seat_1', text: 'Judge 1 votes.' });
    v.clip({ key: voiceKey(BET, 11), url: '/v1/stage/tts/1', text: 'First.' });
    v.clip({ key: voiceKey(BET, 12), url: '/v1/stage/tts/2', text: 'Judge 1 votes.' });
    io.loads[1]!.resolve(io.playable('vote')); // the second clip is ready first
    io.loads[0]!.resolve(io.playable('ruling', 2_000));
    await vi.advanceTimersByTimeAsync(100);
    expect(io.played).toEqual(['ruling']);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(io.played).toEqual(['ruling', 'vote']);
  });

  it("the phone judge's line: never said here, not even after the wait; a clip for it is ignored", async () => {
    const io = fakeIo();
    const { v, done } = voiceOf(io);
    v.expect({ ...line(20, 'Jake wins. Clean flip.'), phone: true });
    v.clip({ key: voiceKey(BET, 20), url: `/v1/stage/tts/${CLIP}`, text: 'Jake wins.' });
    // the next line (an appeal vote) is still the stage's, in its turn
    v.expect({ key: voiceKey(BET, 21), voice: 'seat_1', text: 'Judge 1 votes.' });
    await vi.advanceTimersByTimeAsync(VOICE_WAIT_MS + CLIP_WAIT_MS);
    expect(io.loads).toEqual([]);
    expect(io.played).toEqual([]);
    expect(io.spoken).toEqual(['Judge 1 votes.']);
    expect(done).toEqual([
      [voiceKey(BET, 20), 'phone'],
      [voiceKey(BET, 21), 'speech'],
    ]);
    // a frame that came first (one render) is dropped too
    v.clip({ key: voiceKey(BET, 22), url: '/v1/stage/tts/p', text: 'Paid. Jake takes $2.00.' });
    v.expect({ ...line(22, 'Paid. Jake takes $2.00.'), phone: true });
    await vi.advanceTimersByTimeAsync(VOICE_WAIT_MS + CLIP_WAIT_MS);
    expect(io.loads).toEqual([]);
    expect(io.spoken).toEqual(['Judge 1 votes.']);
    expect(v.last).toBe('phone');
  });

  it('muted (M) or voice off (V): the line is skipped', async () => {
    const io = fakeIo();
    io.on = false;
    const { v, done } = voiceOf(io);
    v.expect(line(13));
    await vi.advanceTimersByTimeAsync(VOICE_WAIT_MS);
    expect(io.spoken).toEqual([]);
    expect(done).toEqual([[voiceKey(BET, 13), 'skip']]);
  });
});

describe('StageVoice: M or V stops the line already playing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A 20 s clip (a 300-character line) whose source node records stop(). */
  function longClip() {
    const c = { started: 0, stopped: 0, end: null as (() => void) | null };
    const playable: Playable = {
      play: () =>
        new Promise<void>((r) => {
          c.started++;
          c.end = r;
          setTimeout(r, 20_000);
        }),
      stop: () => {
        c.stopped++;
        c.end?.();
      },
    };
    return { c, playable };
  }

  it('mid-clip: the clip stops at once, the line ends, the next is skipped while off', async () => {
    const io = fakeIo();
    let cancels = 0;
    io.impl.cancelSpeech = () => cancels++;
    const { v, done } = voiceOf(io);
    const { c, playable } = longClip();
    v.expect(line(30));
    v.expect(line(31, 'Judge 1 votes.'));
    v.clip({ key: voiceKey(BET, 30), url: '/v1/stage/tts/long', text: 'Jake wins.' });
    io.loads[0]!.resolve(playable);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(c.started).toBe(1);
    // the operator presses V 1 s into a 20 s line
    io.on = false;
    v.silence();
    expect(c.stopped).toBe(1);
    expect(cancels).toBe(0); // the browser was not speaking
    await vi.advanceTimersByTimeAsync(VOICE_WAIT_MS);
    expect(done).toEqual([
      [voiceKey(BET, 30), 'skip'],
      [voiceKey(BET, 31), 'skip'],
    ]);
    expect(io.spoken).toEqual([]); // no browser fallback after the cut
  });

  it('mid-speech: speechSynthesis.cancel(), and the line ends even if the browser never says so', async () => {
    const io = fakeIo();
    let cancels = 0;
    io.impl.cancelSpeech = () => cancels++;
    io.impl.speak = (l) =>
      new Promise<void>(() => {
        io.spoken.push(l.text); // an utterance whose onend never fires
      });
    const { v, done } = voiceOf(io);
    v.expect(line(32, 'A long browser line.'));
    await vi.advanceTimersByTimeAsync(VOICE_WAIT_MS + 500);
    expect(io.spoken).toEqual(['A long browser line.']);
    expect(done).toEqual([]);
    io.on = false; // M
    v.silence();
    expect(cancels).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toEqual([[voiceKey(BET, 32), 'skip']]);
    // back on: the next line is heard as usual
    io.on = true;
    io.impl.speak = async (l) => void io.spoken.push(l.text);
    v.expect(line(33, 'Next.'));
    await vi.advanceTimersByTimeAsync(VOICE_WAIT_MS);
    expect(io.spoken.at(-1)).toBe('Next.');
    expect(done.at(-1)).toEqual([voiceKey(BET, 33), 'speech']);
  });

  it('nothing playing: silence() does nothing (a line still waiting for its clip is skipped later)', async () => {
    const io = fakeIo();
    let cancels = 0;
    io.impl.cancelSpeech = () => cancels++;
    const { v, done } = voiceOf(io);
    v.silence();
    v.expect(line(34));
    io.on = false;
    v.silence();
    expect(cancels).toBe(0);
    await vi.advanceTimersByTimeAsync(VOICE_WAIT_MS);
    expect(done).toEqual([[voiceKey(BET, 34), 'skip']]);
  });
});

describe('which events are voiced', () => {
  const START = Date.parse('2026-11-20T15:00:00.000Z');

  it('the preview bet, heard live: the REDO, the ruling and the payout, once each', () => {
    // a preview has no phones in the room: the stage says every line (App passes phoneJudge false)
    const seen = new Set<string>();
    const heard: string[] = [];
    for (let t = 0; t < 56_000; t += 250) {
      const f = previewAt(START, START + t);
      for (const id of Object.keys(f.state.bets))
        for (const l of freshVoiceLines(f.state, id, seen, f.now, { phoneJudge: false })) {
          expect(l.phone).toBeUndefined();
          heard.push(l.text);
        }
    }
    expect(heard).toHaveLength(3);
    expect(heard[0]).toMatch(/^Run it back\. /);
    expect(heard[1]).toMatch(/^Jake wins\. /);
    expect(heard[2]).toMatch(/^Paid\. Jake takes \$/);
  });

  it("live, a bet the voice judge hosts (its judge.line transcript): the ruling and payout are the phone's", () => {
    // the preview bet's judge talks in Beat 2 (judge.line), as A's phone does live
    const seen = new Set<string>();
    const lines: Array<{ text: string; phone?: true }> = [];
    for (let t = 0; t < 56_000; t += 250) {
      const f = previewAt(START, START + t);
      for (const id of Object.keys(f.state.bets))
        lines.push(...freshVoiceLines(f.state, id, seen, f.now));
    }
    expect(lines.map((l) => [l.text.split('.')[0], l.phone])).toEqual([
      ['Run it back', true],
      ['Jake wins', true],
      ['Paid', true],
    ]);
  });

  it('a bet with no judge.line (no voice judge: typed terms, cp1-drive): the stage says its ruling', () => {
    const f = previewAt(START, START, 'ruling');
    const id = f.state.focusBetId!;
    const noJudge = {
      ...f.state,
      history: {
        ...f.state.history,
        [id]: f.state.history[id]!.filter((e) => e.type !== 'judge.line'),
      },
    };
    const ruling = noJudge.history[id]!.filter((e) => e.type === 'ruling.issued').at(-1)!;
    const at = Date.parse(ruling.ts);
    const [l] = freshVoiceLines(noJudge, id, new Set(), at).filter(
      (x) => x.key === voiceKey(id, ruling.seq),
    );
    expect(l).toMatchObject({ voice: 'judge', text: expect.stringMatching(/^Jake wins\. /) });
    expect(l!.phone).toBeUndefined();
    const [p] = freshVoiceLines(f.state, id, new Set(), at).filter(
      (x) => x.key === voiceKey(id, ruling.seq),
    );
    expect(p!.phone).toBe(true);
  });

  it('a stage that connects late (the seq-0 replay) says nothing, now or later', () => {
    const f = previewAt(START, START, 'paid');
    const seen = new Set<string>();
    expect(freshVoiceLines(f.state, f.state.focusBetId!, seen, f.now + 60_000)).toEqual([]);
    expect(seen.size).toBeGreaterThan(0);
    expect(freshVoiceLines(f.state, f.state.focusBetId!, seen, f.now)).toEqual([]);
  });

  it('stage.voice frames land in the ticker once each, keyed by bet and seq', () => {
    const frame = {
      op: 'stage.voice',
      bet_id: BET,
      seq: 9,
      type: 'ruling.issued',
      voice: 'judge',
      text: 'Jake wins.',
      clip_id: CLIP,
      audio_url: `/v1/stage/tts/${CLIP}`,
    };
    let s: TickerState = applyFrame(initialTicker, { kind: 'frame', raw: frame, receivedAt: 1 });
    s = applyFrame(s, { kind: 'frame', raw: frame, receivedAt: 2 });
    expect(s.voiceClips).toEqual([
      {
        key: voiceKey(BET, 9),
        bet_id: BET,
        seq: 9,
        url: `/v1/stage/tts/${CLIP}`,
        text: 'Jake wins.',
        voice: 'judge',
      },
    ]);
    // a stage.cue may say where its ElevenLabs clip is
    s = applyFrame(s, {
      kind: 'frame',
      raw: { op: 'stage.cue', bet_id: BET, kind: 'gavel', audio_url: '/v1/stage/sfx/gavel' },
      receivedAt: 3,
    });
    expect(s.lastCue).toEqual({ bet_id: BET, kind: 'gavel', audio_url: '/v1/stage/sfx/gavel' });
  });
});

describe('the browser voice adapter', () => {
  it('speaks with a distinct English voice and pitch per speaker; resolves on end', async () => {
    const said: Array<{ text: string; voice: unknown; pitch: number }> = [];
    class U {
      voice: unknown = null;
      pitch = 1;
      rate = 1;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(readonly text: string) {}
    }
    const voices = [
      { lang: 'fr-FR', name: 'Amelie' },
      { lang: 'en-US', name: 'Alex' },
      { lang: 'en-GB', name: 'Daniel' },
    ];
    const speak = browserSpeech({
      SpeechSynthesisUtterance: U,
      speechSynthesis: {
        getVoices: () => voices,
        speak: (u: U) => {
          said.push({ text: u.text, voice: u.voice, pitch: u.pitch });
          setTimeout(() => u.onend?.(), 0);
        },
      },
    })!;
    await speak({ voice: 'judge', text: 'Jake wins.' });
    await speak({ voice: 'seat_1', text: 'Judge 1.' });
    expect(said).toEqual([
      { text: 'Jake wins.', voice: voices[1], pitch: expect.any(Number) },
      { text: 'Judge 1.', voice: voices[2], pitch: expect.any(Number) },
    ]);
    expect(said[0]!.pitch).not.toBe(said[1]!.pitch);
    expect(browserSpeech({})).toBeNull();
  });

  it('cancelSpeech calls speechSynthesis.cancel(); a browser without it is left alone', () => {
    let cancels = 0;
    cancelSpeech({ speechSynthesis: { cancel: () => cancels++ } });
    expect(cancels).toBe(1);
    expect(() => cancelSpeech({})).not.toThrow();
    expect(() =>
      cancelSpeech({
        speechSynthesis: {
          cancel: () => {
            throw new Error('nope');
          },
        },
      }),
    ).not.toThrow();
  });
});

describe('StageAudio plays decoded clips', () => {
  /** A context that decodes anything and counts buffer sources started. */
  function ctx() {
    const started: unknown[] = [];
    const stopped: unknown[] = [];
    const c = {
      state: 'running',
      currentTime: 0,
      sampleRate: 8000,
      destination: {},
      resume: async () => undefined,
      decodeAudioData: async (b: ArrayBuffer) => ({ duration: 0.01, bytes: b.byteLength }),
      createBufferSource: () => {
        const src = {
          buffer: null as unknown,
          onended: null as (() => void) | null,
          connect() {},
          start() {
            started.push(src.buffer);
            // a clip with a duration plays until stop(); the others end at once
            if (!(src.buffer as { long?: boolean } | null)?.long)
              setTimeout(() => src.onended?.(), 0);
          },
          stop() {
            stopped.push(src.buffer);
            src.onended?.();
          },
        };
        return src;
      },
      createOscillator: () => ({}),
      createGain: () => ({}),
      createBiquadFilter: () => ({}),
      createBuffer: () => ({}),
    };
    return { c, started, stopped };
  }

  it('a TTS clip decodes and plays to its end; muted or locked it does not', async () => {
    const { c, started } = ctx();
    const a = new StageAudio(() => c as never);
    expect(await a.decode(new ArrayBuffer(4))).toBeNull(); // no context before the unlock
    a.unlock();
    const buf = await a.decode(new ArrayBuffer(4));
    expect(buf).not.toBeNull();
    await a.playBuffer(buf!);
    expect(started).toHaveLength(1);
    a.muted = true;
    expect(a.playBuffer(buf!)).toBeNull();
  });

  it("startBuffer's stop() stops the source node (M / V mid-line) and resolves done", async () => {
    const { c, started, stopped } = ctx();
    const a = new StageAudio(() => c as never);
    a.unlock();
    const buf = { duration: 20, long: true } as unknown as AudioBuffer;
    const h = a.startBuffer(buf)!;
    expect(started).toEqual([buf]);
    let ended = false;
    void h.done.then(() => (ended = true));
    await Promise.resolve();
    expect(ended).toBe(false); // still playing
    h.stop();
    await Promise.resolve();
    expect(stopped).toEqual([buf]);
    expect(ended).toBe(true);
    h.stop(); // twice is harmless
    a.muted = true;
    expect(a.startBuffer(buf)).toBeNull();
  });

  it('generated cue clips replace the synthesized gavel / buzzer / cheer once decoded', async () => {
    const { c, started } = ctx();
    const a = new StageAudio(() => c as never);
    a.setGenerated('gavel', new ArrayBuffer(8)); // before the unlock: decoded at the unlock
    expect(a.generatedReady).toBe(0);
    a.unlock();
    await Promise.resolve();
    await Promise.resolve();
    expect(a.generatedReady).toBe(1);
    expect(a.play('gavel')).toBe(true);
    expect(started).toHaveLength(1); // the clip, not the synth (the fake synth graph is empty)
    expect(GENERATED_FOR.redo).toBe('buzzer');
    expect(GENERATED_FOR.paid).toBe('cheer');
    expect(GENERATED_FOR.lock).toBeUndefined();
  });
});
