import { readFileSync } from 'node:fs';
import react from '@eslint-react/eslint-plugin';
import { defineConfig, type OxlintConfig } from 'oxlint';

type RuleSet = NonNullable<OxlintConfig['rules']>;

const { version: reactVersion } = JSON.parse(
  readFileSync(new URL('./node_modules/react/package.json', import.meta.url), 'utf8'),
) as { version: string };
const errors = (names: readonly string[]) =>
  Object.fromEntries(names.map((name) => [name, 'error' as const]));

// Keep the plugin's recommended correctness coverage as it evolves, without
// adopting React Compiler restrictions or naming/API migrations. The native
// hook rules below remain authoritative for hooks and render-time updates.
const excludedReactRules = new Set([
  // Native JSON forms use array slots; stateless geometry has no item IDs.
  'no-array-index-key',
  'exhaustive-deps',
  'rules-of-hooks',
  'error-boundaries',
  'purity',
  'set-state-in-effect',
  'set-state-in-render',
  'static-components',
  'unsupported-syntax',
  'use-memo',
  'use-state',
  'no-context-provider',
  'no-use-context',
  'no-forward-ref',
  'naming-convention-ref-name',
]);
const reactCorrectness = errors(
  Object.keys(react.configs['recommended-typescript'].rules!).filter(
    (rule) => !excludedReactRules.has(rule.replace('@eslint-react/', '')),
  ),
);

// Match the existing recommended correctness checks and explicit rule options.
const baseRules: RuleSet = {
  ...errors([
    'eslint/for-direction',
    'eslint/no-async-promise-executor',
    'eslint/no-case-declarations',
    'eslint/no-compare-neg-zero',
    'eslint/no-control-regex',
    'eslint/no-debugger',
    'eslint/no-delete-var',
    'eslint/no-dupe-else-if',
    'eslint/no-duplicate-case',
    'eslint/no-empty-character-class',
    'eslint/no-empty-static-block',
    'eslint/no-ex-assign',
    'eslint/no-loss-of-precision',
    'eslint/no-nonoctal-decimal-escape',
    'eslint/no-prototype-builtins',
    'eslint/no-regex-spaces',
    'eslint/no-sparse-arrays',
    'eslint/no-unassigned-vars',
    'eslint/no-unsafe-finally',
    'eslint/no-unused-labels',
    'eslint/no-unused-private-class-members',
    'eslint/no-useless-assignment',
    'eslint/no-useless-backreference',
    'eslint/no-useless-catch',
    'eslint/require-yield',
    'eslint/no-var',
    'eslint/prefer-rest-params',
    'eslint/prefer-spread',
    'typescript/ban-ts-comment',
    'eslint/no-array-constructor',
    'typescript/no-duplicate-enum-values',
    'typescript/no-empty-object-type',
    'typescript/no-explicit-any',
    'typescript/no-extra-non-null-assertion',
    'typescript/no-misused-new',
    'typescript/no-namespace',
    'typescript/no-non-null-asserted-optional-chain',
    'typescript/no-require-imports',
    'typescript/no-this-alias',
    'typescript/no-unnecessary-type-constraint',
    'typescript/no-unsafe-declaration-merging',
    'typescript/no-unsafe-function-type',
    'typescript/no-wrapper-object-types',
    'typescript/prefer-as-const',
    'typescript/prefer-namespace-keyword',
    'typescript/triple-slash-reference',
  ]),
  'eslint/no-cond-assign': ['error', 'except-parens'],
  'eslint/no-constant-binary-expression': ['error', { checkRelationalComparisons: false }],
  'eslint/no-constant-condition': ['error', { checkLoops: 'allExceptWhileTrue' }],
  'eslint/no-empty': ['error', { allowEmptyCatch: false }],
  'eslint/no-empty-pattern': ['error', { allowObjectPatternsAsParameters: false }],
  'eslint/no-extra-boolean-cast': ['error', {}],
  'eslint/no-fallthrough': [
    'error',
    { allowEmptyCase: false, reportUnusedFallthroughComment: false },
  ],
  'eslint/no-global-assign': ['error', { exceptions: [] }],
  'eslint/no-invalid-regexp': ['error', {}],
  'eslint/no-irregular-whitespace': [
    'error',
    {
      skipComments: false,
      skipJSXText: false,
      skipRegExps: false,
      skipStrings: true,
      skipTemplates: false,
    },
  ],
  'eslint/no-misleading-character-class': ['error', { allowEscape: false }],
  'eslint/no-self-assign': ['error', { props: true }],
  'eslint/no-shadow-restricted-names': ['error', { reportGlobalThis: true }],
  'eslint/no-unsafe-optional-chaining': ['error', { disallowArithmeticOperators: false }],
  'eslint/no-useless-escape': ['error', { allowRegexCharacters: [] }],
  'eslint/preserve-caught-error': ['error', { requireCatchParameter: false }],
  'eslint/use-isnan': ['error', { enforceForIndexOf: false, enforceForSwitchCase: true }],
  'eslint/valid-typeof': ['error', { requireStringLiterals: false }],
  'eslint/prefer-const': ['error', { destructuring: 'any', ignoreReadBeforeAssign: false }],
  'eslint/no-unused-expressions': [
    'error',
    { allowShortCircuit: false, allowTaggedTemplates: false, allowTernary: false },
  ],
  'eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
};

// Type-aware checks and React lifecycle rules apply to production source.
// Test fixtures intentionally describe invalid external shapes and mock promises.
const productionRules: RuleSet = {
  ...reactCorrectness,
  ...errors([
    'typescript/await-thenable',
    'typescript/no-array-delete',
    'typescript/no-base-to-string',
    'typescript/no-duplicate-type-constituents',
    'typescript/no-floating-promises',
    'typescript/no-for-in-array',
    'typescript/no-implied-eval',
    'typescript/no-misused-promises',
    'typescript/no-redundant-type-constituents',
    'typescript/no-unnecessary-type-assertion',
    'typescript/no-unsafe-argument',
    'typescript/no-unsafe-assignment',
    'typescript/no-unsafe-call',
    'typescript/no-unsafe-enum-comparison',
    'typescript/no-unsafe-member-access',
    'typescript/no-unsafe-return',
    'typescript/no-unsafe-unary-minus',
    'typescript/only-throw-error',
    'typescript/prefer-promise-reject-errors',
    'typescript/require-await',
    'typescript/restrict-plus-operands',
    'typescript/restrict-template-expressions',
    'typescript/unbound-method',
    'react/rules-of-hooks',
    'react/exhaustive-deps',
    'react/set-state-in-render',
  ]),
};

export default defineConfig({
  plugins: ['typescript', 'react'],
  jsPlugins: [{ name: '@eslint-react', specifier: '@eslint-react/eslint-plugin' }],
  // Keep the explicit project rules authoritative instead of adding unrelated defaults.
  categories: { correctness: 'off' },
  options: { typeAware: true, maxWarnings: 0, reportUnusedDisableDirectives: 'warn' },
  ignorePatterns: [
    '.tools/**',
    'node_modules/**',
    'dist/**',
    'public/**',
    'service/**',
    'src-tauri/**',
  ],
  settings: {
    react: { version: reactVersion },
    'react-x': { version: reactVersion },
  },
  rules: baseRules,
  overrides: [
    { files: ['src/**/*.{ts,tsx}'], env: { browser: true } },
    {
      files: ['src/**/*.{ts,tsx}'],
      excludeFiles: ['src/**/*.test.{ts,tsx}'],
      rules: productionRules,
    },
    { files: ['src/**/*.test.{ts,tsx}'], rules: { 'typescript/no-explicit-any': 'off' } },
    { files: ['vite.config.ts', 'vitest*.config.ts', 'oxlint.config.ts'], env: { node: true } },
  ],
});
