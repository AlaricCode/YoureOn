/**
 * WS `scene.frame` stream (§12.4): a rolling 50-frame detection buffer per
 * bet, evaluated with `leafSignals` against the last PUT calibration; the
 * result is pushed as WS `scene` to `bet:<id>`. Frames that arrive while one
 * is being processed collapse to the newest (the detector is the bottleneck).
 */
import type { AppContext } from '../context.js';
import type { Detection } from '../providers/types.js';
import { fromBase64 } from '../util/bytes.js';
import type { BetInfo } from './betInfo.js';
import { conditionStates, detectorPrompts, sceneEntityViews, SCENE_BUFFER_FRAMES, sessionFromDetections, type ConditionState, type SceneEntityView } from './scene.js';
import type { LifecycleStores } from './stores.js';

/** Max accepted JPEG size for a scene frame (≤ 640 px long side). */
export const SCENE_FRAME_MAX_BYTES = 2 * 1024 * 1024;

interface BetStream {
  frames: Detection[][];
  busy: boolean;
  next: { jpeg: Uint8Array; info: BetInfo } | null;
}

export interface SceneUpdate {
  entities: SceneEntityView[];
  conditions: ConditionState[];
}

export class SceneStream {
  private readonly streams = new Map<string, BetStream>();

  constructor(
    private readonly ctx: AppContext,
    private readonly s: LifecycleStores,
  ) {}

  /** One detector pass over a single frame (no buffer): POST /scene/detect. */
  async detectOnce(info: BetInfo, jpeg: Uint8Array): Promise<SceneUpdate> {
    const cal = this.s.scenes.get(info.id)?.calibration ?? null;
    const dets = await this.ctx.providers.detector.detect(jpeg, { bet: info.id, entities: detectorPrompts(info.program), calibration: cal });
    return {
      entities: sceneEntityViews(info.program, info.labels, cal, dets),
      conditions: conditionStates(info.program, info.labels, cal, sessionFromDetections(info.program, [dets])),
    };
  }

  /** Accepts a WS frame; processing is serialized per bet, keeping only the newest pending frame. */
  push(info: BetInfo, jpegB64: string): void {
    let jpeg: Uint8Array;
    try {
      jpeg = fromBase64(jpegB64);
    } catch {
      return;
    }
    if (jpeg.length === 0 || jpeg.length > SCENE_FRAME_MAX_BYTES) return;
    const st = this.streams.get(info.id) ?? { frames: [], busy: false, next: null };
    this.streams.set(info.id, st);
    st.next = { jpeg, info };
    if (!st.busy) void this.drain(info.id, st);
  }

  /** Processes queued frames until none is pending (exposed for tests). */
  async drain(betId: string, st = this.streams.get(betId)): Promise<void> {
    if (!st || st.busy) return;
    st.busy = true;
    try {
      while (st.next) {
        const { jpeg, info } = st.next;
        st.next = null;
        const cal = this.s.scenes.get(info.id)?.calibration ?? null;
        let dets: Detection[];
        try {
          dets = await this.ctx.providers.detector.detect(jpeg, { bet: info.id, entities: detectorPrompts(info.program), calibration: cal });
        } catch (e) {
          this.ctx.log.warn({ err: e, bet: info.id }, 'scene detector failed');
          continue;
        }
        st.frames.push(dets);
        if (st.frames.length > SCENE_BUFFER_FRAMES) st.frames.splice(0, st.frames.length - SCENE_BUFFER_FRAMES);
        const conditions = conditionStates(info.program, info.labels, cal, sessionFromDetections(info.program, st.frames));
        this.ctx.hub.publish(`bet:${info.id}`, {
          type: 'scene',
          bet_id: info.id,
          entities: sceneEntityViews(info.program, info.labels, cal, dets),
          conditions,
        });
      }
    } finally {
      st.busy = false;
    }
  }

  /** Frames currently buffered for a bet (tests / diagnostics). */
  bufferLength(betId: string): number {
    return this.streams.get(betId)?.frames.length ?? 0;
  }

  idle(betId: string): boolean {
    const st = this.streams.get(betId);
    return !st || (!st.busy && !st.next);
  }

  /** Drops the buffer (bet started or closed). */
  clear(betId: string): void {
    this.streams.delete(betId);
  }
}
