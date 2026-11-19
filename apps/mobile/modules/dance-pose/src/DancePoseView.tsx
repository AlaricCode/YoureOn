// <DancePoseView>: the typed wrapper around the native judge-cam view (DANCE-OFF.md §6.1).
// Without the native module (an old binary) it renders an empty black box, reports
// `no_camera` once, and its ref handle answers startRound {ok: false} / an empty stopRound /
// captureStill {ok: false}.
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { View } from 'react-native';

import { clampMaxFps, emptyStopResult, toStillResult, toStopRoundResult } from './frame';
import { getNativeDancePoseView, type NativeDancePoseInstance } from './native';
import type { DancePoseHandle, DancePoseViewProps, StartRoundResult, StatusEvent } from './types';

const MISSING_STATUS: StatusEvent = { state: 'no_camera', message: 'pose module missing' };

export const DancePoseView = forwardRef<DancePoseHandle, DancePoseViewProps>(
  function DancePoseView(props, ref) {
    const { style, active, maxFps, onPoses, onStatus } = props;
    const Native = getNativeDancePoseView();
    const inner = useRef<NativeDancePoseInstance | null>(null);
    const onStatusRef = useRef(onStatus);
    onStatusRef.current = onStatus;

    useImperativeHandle(
      ref,
      (): DancePoseHandle => ({
        startRound: async (opts) => {
          const view = inner.current;
          if (!view) return { ok: false, message: 'pose view is not mounted' };
          const result: Partial<StartRoundResult> | null = await view.startRound({
            snapshotAtMs: [...opts.snapshotAtMs],
          });
          const ok = result?.ok === true;
          return typeof result?.message === 'string' ? { ok, message: result.message } : { ok };
        },
        stopRound: async () => {
          const view = inner.current;
          if (!view) return emptyStopResult();
          return toStopRoundResult(await view.stopRound());
        },
        captureStill: async () => {
          const view = inner.current;
          if (!view || typeof view.captureStill !== 'function')
            return { ok: false, message: 'captureStill is not in this build' };
          return toStillResult(await view.captureStill());
        },
      }),
      [],
    );

    const missing = Native === null;
    useEffect(() => {
      if (missing) onStatusRef.current?.({ nativeEvent: MISSING_STATUS });
    }, [missing]);

    if (Native === null) {
      return <View style={[{ backgroundColor: '#000000' }, style]} />;
    }
    return (
      <Native
        ref={inner}
        style={style}
        active={active}
        maxFps={clampMaxFps(maxFps)}
        onPoses={onPoses}
        onStatus={onStatus}
      />
    );
  },
);
