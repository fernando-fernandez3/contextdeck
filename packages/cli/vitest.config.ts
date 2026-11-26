import { defineConfig } from 'vitest/config';

// Every CLI test spawns several real `node dist/...` processes (H6 runs seven in sequence).
// Under a loaded runner or --maxWorkers=2 that exceeds vitest's 5 s default without any hang,
// so give spawn-based tests a realistic budget instead of per-test overrides.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
