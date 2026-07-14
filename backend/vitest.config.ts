import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Apenas os testes unitários novos. Os arquivos legados em tests/*.test.ts são
    // scripts standalone (chamam process.exit) e NÃO devem ser coletados pelo vitest.
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
