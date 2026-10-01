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
    // `no-restricted-syntax` rather than `no-console` with an empty `allow`, whose
    // schema requires a non-empty list.
    //
    // ⚠⚠ WHAT IT CATCHES AND WHAT IT DOES NOT, measured one lint run per shape. The
    // first version of this comment said the selector "additionally catches
    // `console['warn']` and an ALIAS declaration", which reads as if the enumeration
    // problem were solved. It is narrowed, not solved — from eleven shapes to five:
    //
    //   RED    console.warn(x) · console['warn'](x) · (console).warn(x)
    //          const w = console.warn; w(x)          ← an alias DECLARATION, because
    //                                                  `console.warn` is itself a
    //                                                  MemberExpression there
    //   GREEN  const { warn } = console; warn(x)     ← an ObjectPattern, not a
    //                                                  MemberExpression
    //          globalThis.console.warn(x) · globalThis['console'].warn(x)
    //          const c = globalThis.console; c.warn(x)
    //          Reflect.get(console, 'warn')(x)
    //
    // The destructured form is the one that stings: the retired scanner was defeated
    // by exactly it, and the module's own comment says so. The spies do not hold it
    // either — the destructured reference IS the `console.warn` spy, and that spy is
    // only asserted silent on the clean path. So for a `console.warn`-shaped bypass
    // this rule is the SOLE mechanism, and five shapes walk through it.
    //
    // Not widened further on purpose: this is the seventh attempt at the property
    // "every diagnostic goes through `report`", and the previous six were each
    // defeated by a shape their author had not thought of. Chasing the fifth, sixth
    // and seventh selector is the same move again. The remaining shapes are filed as
    // a register row, where they can be read as what they are — open.
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
