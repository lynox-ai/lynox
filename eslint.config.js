import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import svelte from 'eslint-plugin-svelte';

/** One rule set for the engine and the web UI, `.ts` and `<script lang="ts">` alike. */
const RULES = {
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
};

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
    rules: RULES,
  },
  {
    // The web UI has its own tsconfig, which extends `.svelte-kit/tsconfig.json`: the `lint`
    // script runs `svelte-kit sync` first so that file exists.
    files: ['packages/web-ui/src/**/*.ts'],
    ignores: ['packages/web-ui/src/**/*.test.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: `${import.meta.dirname}/packages/web-ui`,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: RULES,
  },
  {
    // In active rework elsewhere; linted once that lands.
    ignores: ['packages/web-ui/src/lib/components/MarkdownRenderer.svelte'],
  },
  // The web UI's components: the plugin's recommended set, then the same rules as above on their
  // scripts. Several classes are `warn`, and `warn` does not fail the lint: those are visible here,
  // not enforced.
  ...svelte.configs.recommended.map((c) => ({ ...c, files: ['packages/web-ui/src/**/*.svelte'] })),
  {
    files: ['packages/web-ui/src/**/*.svelte'],
    languageOptions: {
      parserOptions: {
        parser: tsparser,
        projectService: true,
        extraFileExtensions: ['.svelte'],
        tsconfigRootDir: `${import.meta.dirname}/packages/web-ui`,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...RULES,
      // Measured: no `kit.paths.base` in the web UI's svelte.config, and nothing mounts the UI
      // under a prefix (the engine serves it at the root). `resolve()` would change no link.
      'svelte/no-navigation-without-resolve': 'off',
      // Each `{@html}` carries a disable line naming where its value comes from.
      'svelte/no-at-html-tags': 'error',
      // Visible, not enforced:
      'svelte/require-each-key': 'warn',
      'svelte/prefer-svelte-reactivity': 'warn',
      'svelte/prefer-writable-derived': 'warn',
      // Whether a `svelte-ignore` is needed is the Svelte compiler's call, not this plugin's.
      'svelte/no-unused-svelte-ignore': 'warn',
    },
  },
  {
    // Floating promises are an error in every component except this one, which is still being
    // worked through; a file joins the rule as soon as it is clean, so nothing slides back.
    files: ['packages/web-ui/src/lib/components/ChatView.svelte'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'warn',
    },
  },
  {
    // ⚠ STRICTER THAN THE REPO, FOR ONE FILE. The repo allows `console.warn` everywhere.
    // In the Voxtral voice catalogue every diagnostic must go through the local `report`
    // closure, which pairs the warning with the flag that shortens the cache lifetime: a
    // BARE `console.warn` warns without the flag, so a warned, incomplete catalogue is
    // served for an hour. `report`'s own call carries the one exemption.
    //
    // WHAT IT REACHES: the ordinary member-access shapes — `console.warn(x)`,
    // `console['warn'](x)`, an optional chain, a `.call`, and an alias DECLARATION
    // (`const w = console.warn`, where `console.warn` is itself a MemberExpression).
    // What it does NOT reach: DESTRUCTURING (`const { warn } = console` is an
    // ObjectPattern, not a MemberExpression) and anything routed through `globalThis`
    // or `Reflect`. `process.std*.write` and `process.emitWarning` are a different
    // channel, outside this rule by design, held by spies in the test file.
    //
    // ⚠ No counts here, on purpose. Three different fractions were written in this
    // block and all three were wrong — an unsourced denominator, then one that mixed
    // the two channels, then one whose halves summed to twelve. A count is a sample of
    // what somebody tried, it ages the moment anybody tries another shape, and nothing
    // in the build checks it. The measured list with its dates is the register row,
    // which is where an open set can be kept honest.
    //
    // ⛔ THE HAZARD THIS BLOCK CREATES, both ways. Flat config REPLACES a rule's options
    // instead of merging them, so this block and a repo-wide `no-restricted-syntax`
    // cannot both apply — whichever comes LAST wins. Measured: a repo-wide
    // `TemplateLiteral` rule placed BEFORE this block fires 13× in
    // `src/core/speak/text-prep.ts` and 0× here, so this file is immune to it; the same
    // rule APPENDED AFTER this block makes the console rule above fire 0× and a planted
    // bare `console.warn` green. A config append that looks like a tightening deletes
    // this mechanism in silence.
    //
    // `no-restricted-syntax` rather than `no-console` with an empty `allow`, whose schema
    // requires a non-empty list.
    //
    // Why this is a lint rule and not a test: earlier mechanisms for the same property
    // were built and retired, each defeated by a shape its author had not enumerated.
    // (No count: this comment said seven retired while the source file said six, and
    // neither was checkable against the tree.) That history, the open shapes, and the hazard above are a register row;
    // this comment states the rule's reach and stops there, because every review finding
    // on this block has been a sentence claiming more than it measured.
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
