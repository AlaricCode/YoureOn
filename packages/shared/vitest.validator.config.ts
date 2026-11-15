import { defineConfig } from 'vitest/config';

// `npm run test:validator` (scripts/test-validator.sh starts and stops solana-test-validator):
// the local Agave suite under test/validator (ESCROW §9.1). Never part of `npm test`.
export default defineConfig({
  test: {
    include: ['test/validator/**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
