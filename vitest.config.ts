import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['extensions/**/test.ts', 'extensions/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
  },
});