import { defineConfig } from 'vitest/config';

// Server tests drive real HTTP servers, multipart streams and crash-recovery txn files on disk.
// The H2 multipart crash-recovery test passes in ~0.6 s alone but crossed vitest's 5 s default
// once under a loaded --maxWorkers=2 run (council r4), so give I/O-bound tests a realistic budget.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
