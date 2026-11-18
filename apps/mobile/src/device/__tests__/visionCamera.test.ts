import { describe, expect, it } from 'vitest';

import { cameraPresence } from '../visionCamera';

const factory = (cams: { front?: object; back?: object }) =>
  Promise.resolve({ getDefaultCamera: (p: 'front' | 'back') => cams[p] });

describe('cameraPresence', () => {
  it('a phone has a camera on the side asked for', async () => {
    await expect(cameraPresence(factory({ front: {}, back: {} }), 'front')).resolves.toBe(
      'present',
    );
    await expect(cameraPresence(factory({ front: {}, back: {} }), 'back')).resolves.toBe('present');
  });

  it('the simulator has none (so <Camera> is never mounted there)', async () => {
    await expect(cameraPresence(factory({}), 'front')).resolves.toBe('none');
  });

  it('only the side asked for counts', async () => {
    await expect(cameraPresence(factory({ back: {} }), 'front')).resolves.toBe('none');
  });

  it('a factory that fails to load counts as no camera', async () => {
    await expect(cameraPresence(Promise.reject(new Error('nitro')), 'back')).resolves.toBe('none');
  });
});
