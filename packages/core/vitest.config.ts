import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['test/concurrency.test.ts'],
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
