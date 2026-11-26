import { defineConfig } from 'vitest/config';

// Core tests perform durable fsync-backed transactions; under parallel workspace `pnpm -r test`
// runs on a shared disk, Vitest's 5s default can trip without any hang.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['test/concurrency.test.ts'],
          testTimeout: 20_000,
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          name: 'stress',
          include: ['test/concurrency.test.ts'],
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
