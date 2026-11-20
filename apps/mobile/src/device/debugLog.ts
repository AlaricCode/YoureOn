// A diagnostic line on the device's console, read from a Mac with
// `devicectl device process launch --console`. It calls the DancePose native module's debugLog by
// name through Expo's module registry, so nothing of that module's JS is imported (the app's
// start must not load it: app/__tests__/bootImports). A no-op where the native function is
// missing (the simulator, an older binary). Never throws.
import { requireOptionalNativeModule } from 'expo';

export function debugLog(message: string): void {
  try {
    requireOptionalNativeModule<{ debugLog?: (m: string) => void }>('DancePose')?.debugLog?.(
      message,
    );
  } catch {
    // diagnostics never break a screen
  }
}
