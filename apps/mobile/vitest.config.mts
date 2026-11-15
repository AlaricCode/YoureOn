import { defineConfig } from 'vitest/config';

// Node-only unit tests for pure app logic (src/**). Native modules are injected behind interfaces
// (see src/wallet/platform.ts), so nothing here loads React Native.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
