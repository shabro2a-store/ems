import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'lib/**/*.test.ts',
      'lib/**/__tests__/**/*.test.ts',
      '../../apps/worker/src/jobs/**/*.test.ts',
    ],
    testTimeout: 30_000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
  resolve: {
    alias: {
      '@': here,
      time: path.resolve(repoRoot, 'packages', 'time', 'src', 'index.ts'),
      notify: path.resolve(repoRoot, 'packages', 'notify', 'src', 'index.ts'),
    },
  },
});
