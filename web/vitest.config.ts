import { defineConfig } from 'vitest/config';

// No react plugin: esbuild compiles JSX the way admin/tsconfig.json says (react-jsx), the
// plugins' setup cards (plugins/*/admin) included, which sit under web/tsconfig.json. Admin
// tests opt into jsdom with a `// @vitest-environment jsdom` docblock.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['test/**/*.test.ts', 'admin/src/**/*.test.{ts,tsx}', 'plugins/*/admin/**/*.test.{ts,tsx}'],
    // A page any test's server renders with an inline script fails that test (test/inline-script.ts).
    setupFiles: ['test/html-checks.ts'],
    // The board tests load whole pages in jsdom, which polls on its own timers.
    testTimeout: 20_000,
  },
});
