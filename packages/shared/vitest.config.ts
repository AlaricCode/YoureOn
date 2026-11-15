import { configDefaults, defineConfig } from 'vitest/config';

// Default suite (`npm test`, CI ts job): pure TS, no escrow build. The LiteSVM client suite under
// test/escrow needs programs/escrow/target/deploy/escrow.so and runs via `npm run test:escrow`;
// test/validator needs a local solana-test-validator and runs via `npm run test:validator`.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'test/escrow/**', 'test/validator/**'],
  },
});
