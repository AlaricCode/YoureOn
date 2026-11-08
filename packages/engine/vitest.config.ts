import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // Consensus code is pure and deterministic; generous timeout for fuzz-style suites.
    testTimeout: 60_000,
  },
});
