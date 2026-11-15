import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Applies the Drizzle migrations once when DATABASE_URL is set (DB tests skip otherwise).
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 15_000,
  },
});
