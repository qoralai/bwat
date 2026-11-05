import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/'] },
  ...tseslint.configs.recommended,
  // QOR-4806: core never imports a plugin's folder (src/plugins/<name>/); the registry
  // (src/plugins/index.ts) is the one place that does, and a plugin may import core.
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts'],
    ignores: ['src/plugins/index.ts', 'src/plugins/*/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['**/plugins/*/**'], message: 'Core never imports a plugin: register it in src/plugins/index.ts.' }] },
      ],
    },
  },
);
