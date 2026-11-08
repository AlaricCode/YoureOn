import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    // Tests never spend: make sure an ambient ALLOW_SPEND cannot leak in.
    env: { ALLOW_SPEND: '' },
  },
});
