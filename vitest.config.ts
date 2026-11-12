import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // Integration tests share one database.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
