import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // tests/db/** sobe Postgres real: roda separado (npm run test:db, vitest.db.config.ts).
  test: { include: ['tests/**/*.test.ts'], exclude: ['tests/db/**', 'node_modules/**'] },
});
