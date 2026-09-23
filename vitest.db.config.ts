import { defineConfig } from 'vitest/config';

// Testes de integracao com Postgres real e descartavel (embedded-postgres). Nunca usa producao.
export default defineConfig({
  test: {
    include: ['tests/db/**/*.test.ts'],
    hookTimeout: 180_000,
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
