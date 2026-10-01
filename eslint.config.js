import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      // Type safety
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', {
        prefer: 'type-imports',
        disallowTypeAnnotations: false,
      }],

      // Dead code
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],

      // Quality
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
      'no-eval': 'error',
    },
  },
  {
    // ⚠ STRICTER THAN THE REPO, FOR ONE FILE, and the reason is a measured fail-open.
    // The repo allows `console.warn` everywhere. In the Voxtral voice catalogue every
    // diagnostic must go through the local `report` closure, which pairs the warning
    // with the flag that shortens the cache lifetime — a BARE `console.warn` warns
    // without the flag, so a warned, incomplete catalogue is served for an hour.
    //
    // Measured on 2026-10-01: a fifth diagnostic written as `console.warn(...)` on a
    // branch the happy-path test does not reach was invisible to the test spies, to
    // `no-console` (which allows `warn`), and to `tsc` — green on all three. A source
    // scanner in the test file held this property and was retired after five versions
    // each produced fail-opens or false reds; this rule is the mechanism that already
    // exists doing the same job statically.
    //
    // `no-restricted-syntax` rather than `no-console` with an empty `allow`: the
    // latter's schema requires a non-empty list, and this selector additionally
    // catches `console['warn']` and an ALIAS declaration (`const w = console.warn`),
    // which an enumeration of method names does not.
    files: ['src/core/speak/mistral-voxtral-tts.ts'],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: "MemberExpression[object.name='console']",
        message:
          'In this file every diagnostic goes through the `report` closure, which sets the ' +
          'doubtful flag and warns in one statement. A bare console call warns without the ' +
          'flag and a warned catalogue is then cached for an hour. Call `report` instead — ' +
          'or, if this really is a new sanctioned channel, add an explicit ' +
          'eslint-disable-next-line here so a reviewer sees it.',
      }],
    },
  },
];
