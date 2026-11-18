import { describe, expect, it, vi } from 'vitest';

import {
  importSafely,
  ModuleLoadError,
  type ErrorUtilsLike,
  type GlobalErrorHandler,
} from '../importSafely';

/** RN's error-guard polyfill: one global handler, reportFatalError calls it synchronously. */
function fakeErrorUtils() {
  const original = vi.fn<GlobalErrorHandler>();
  let handler: GlobalErrorHandler = original;
  const utils: ErrorUtilsLike & {
    reportFatalError(e: unknown): void;
    reportError(e: unknown): void;
  } = {
    getGlobalHandler: () => handler,
    setGlobalHandler: (h) => {
      handler = h;
    },
    reportFatalError: (e) => handler(e, true),
    reportError: (e) => handler(e, false),
  };
  return { utils, original, current: () => handler };
}

/** What Metro's asyncRequire does when the module throws while it initialises. */
const metroImportOfBrokenModule =
  (eu: { reportFatalError(e: unknown): void }, error: unknown) => (): Promise<object> => {
    eu.reportFatalError(error); // guardedLoadModule's catch
    return Promise.resolve({ default: undefined }); // importAll of a module with no exports
  };

describe('importSafely', () => {
  it('resolves the module when it loads', async () => {
    const { utils, original, current } = fakeErrorUtils();
    const mod = { default: 'Panel' };
    await expect(importSafely(() => Promise.resolve(mod), utils)).resolves.toBe(mod);
    expect(current()).toBe(original);
    expect(original).not.toHaveBeenCalled();
  });

  it('turns a fatal reported while the module initialises into a rejection', async () => {
    const { utils, original, current } = fakeErrorUtils();
    const boom = new Error('HybridObject "FaceDetectorFactory" has not been registered');
    const p = importSafely(metroImportOfBrokenModule(utils, boom), utils);
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ModuleLoadError);
    expect((err as ModuleLoadError).cause).toBe(boom);
    expect((err as ModuleLoadError).message).toContain('FaceDetectorFactory');
    // The app's real fatal handler never saw it, and is back in place.
    expect(original).not.toHaveBeenCalled();
    expect(current()).toBe(original);
  });

  it('passes non-fatal reports through to the previous handler', async () => {
    const { utils, original } = fakeErrorUtils();
    const warning = new Error('soft');
    const mod = { default: 1 };
    await expect(
      importSafely(() => {
        utils.reportError(warning);
        return Promise.resolve(mod);
      }, utils),
    ).resolves.toBe(mod);
    expect(original).toHaveBeenCalledWith(warning, false);
  });

  it('only covers the synchronous require: later fatals reach the app handler', async () => {
    const { utils, original } = fakeErrorUtils();
    await importSafely(() => Promise.resolve({}), utils);
    const later = new Error('later');
    utils.reportFatalError(later);
    expect(original).toHaveBeenCalledWith(later, true);
  });

  it('rejects (and restores the handler) when the loader throws synchronously', async () => {
    const { utils, original, current } = fakeErrorUtils();
    const thrown = new Error('sync');
    await expect(
      importSafely(() => {
        throw thrown;
      }, utils),
    ).rejects.toBe(thrown);
    expect(current()).toBe(original);
  });

  it('keeps an ordinary rejection as is', async () => {
    const { utils } = fakeErrorUtils();
    const e = new Error('network');
    await expect(importSafely(() => Promise.reject(e), utils)).rejects.toBe(e);
  });

  it('just loads when there is no ErrorUtils (node, tests)', async () => {
    await expect(importSafely(() => Promise.resolve(7), undefined)).resolves.toBe(7);
  });

  it('wraps a non-Error fatal', async () => {
    const { utils } = fakeErrorUtils();
    await expect(
      importSafely(metroImportOfBrokenModule(utils, 'plain string'), utils),
    ).rejects.toThrow('plain string');
  });
});
