import tseslint from 'typescript-eslint';

export default tseslint.config(
  // pages/board/ui is the prototype's desk, ported as it is (D173): not ours to restyle.
  { ignores: ['dist/', 'node_modules/', 'pages/board/ui/'] },
  ...tseslint.configs.recommended,
  // Core never imports a plugin's folder (plugins/<name>/); the registries
  // (server/src/plugins/index.ts, and admin/src/pluginSetup.ts for the panel) are the only places
  // that do, and a plugin may import core.
  {
    files: ['server/**/*.ts', 'pages/**/*.js', 'admin/src/**/*.{ts,tsx}'],
    ignores: ['server/src/plugins/index.ts', 'admin/src/pluginSetup.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['**/plugins/*/**'], message: 'Core never imports a plugin: register it in server/src/plugins/index.ts.' }] },
      ],
    },
  },
);
