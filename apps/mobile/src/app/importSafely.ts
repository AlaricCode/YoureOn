// Dynamic import() that fails like a promise, not like a crash.
//
// Metro compiles `import('./X')` to its asyncRequire, which requires the module SYNCHRONOUSLY
// inside the call (metro-runtime asyncRequire -> require.importAll). When the module throws while
// it initialises (a native module missing from the build: e.g. the MLKit face detector, left out
// of simulator builds; a native SDK whose import-time setup throws), metro-runtime's
// guardedLoadModule catches the error and hands it to ErrorUtils.reportFatalError, because no
// other module is loading at that moment. In a Release build that is RCTFatal: the app aborts.
// The import() promise even resolves (to an empty module), so neither React.lazy + an error
// boundary nor a try/catch around `await import()` ever sees the failure.
//
// importSafely swaps the global error handler for the duration of that synchronous call and
// turns a fatal reported inside it into a rejection of the returned promise, so the caller's
// boundary or catch handles it. Non-fatal reports pass through to the previous handler.
// Scope: Release bundles and Metro dev without bundle splitting (the require runs in the call).
// Pure TS (ErrorUtils is injected): tested in node.

export type GlobalErrorHandler = (error: unknown, isFatal?: boolean) => void;

export interface ErrorUtilsLike {
  getGlobalHandler(): GlobalErrorHandler;
  setGlobalHandler(handler: GlobalErrorHandler): void;
}

const globalErrorUtils = (): ErrorUtilsLike | undefined =>
  (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;

/** A module that initialised with a fatal error (the original error is the `cause`). */
export class ModuleLoadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ModuleLoadError';
  }
}

export function importSafely<T>(
  load: () => Promise<T>,
  errorUtils: ErrorUtilsLike | undefined = globalErrorUtils(),
): Promise<T> {
  if (!errorUtils) return load();
  const previous = errorUtils.getGlobalHandler();
  const fatals: unknown[] = [];
  errorUtils.setGlobalHandler((error, isFatal) => {
    if (isFatal) fatals.push(error);
    else previous(error, isFatal);
  });
  let pending: Promise<T>;
  try {
    pending = load();
  } catch (e) {
    pending = Promise.reject(e);
  } finally {
    errorUtils.setGlobalHandler(previous);
  }
  if (fatals.length > 0) {
    // The module object it resolves to is empty; never hand it out.
    pending.catch(() => undefined);
    return Promise.reject(new ModuleLoadError(fatals[0]));
  }
  return pending;
}
