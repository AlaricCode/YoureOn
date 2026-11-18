import { describe, expect, it } from 'vitest';

import { hasCameraLens } from '../camera';

const view = (lenses: unknown[] | Error) => ({
  getAvailableLensesAsync: () =>
    lenses instanceof Error ? Promise.reject(lenses) : Promise.resolve(lenses),
});

describe('hasCameraLens', () => {
  it('a phone camera lists its lenses', async () => {
    await expect(
      hasCameraLens(view([{ deviceType: 'AVCaptureDeviceTypeBuiltInWideAngleCamera' }])),
    ).resolves.toBe(true);
  });

  it('no lens on the facing side (the simulator) is no camera', async () => {
    await expect(hasCameraLens(view([]))).resolves.toBe(false);
  });

  it('unknown (no view yet, or the call fails) never claims the camera is missing', async () => {
    await expect(hasCameraLens(null)).resolves.toBe(true);
    await expect(hasCameraLens(undefined)).resolves.toBe(true);
    await expect(hasCameraLens(view(new Error('unavailable')))).resolves.toBe(true);
  });
});
