import { defineConfig } from 'vitest/config';

// `npm run test:escrow`: the TS client suite (ESCROW §9.1) on npm litesvm against the built
// escrow.so. Skips with a message when the .so is absent, unless ESCROW_SO_REQUIRED=1 (CI escrow job).
export default defineConfig({
  test: {
    include: ['test/escrow/**/*.test.ts'],
    globalSetup: ['./test/escrow/global-setup.ts'],
    testTimeout: 30_000,
  },
});
