import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import react from '@eslint-react/eslint-plugin';
import hooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

// Use correctness checks, not React Compiler adoption or naming migrations.
// React Flow intentionally uses imperative subscriptions; effects also reconcile
// accepted service revisions with drafts. The official hooks rules still apply.
const excludedReactRules = new Set([
  // Native JSON forms edit array slots; stateless messages/geometry have no item IDs.
  // Ordered graph outputs and stash items use their persistent IDs and have regression coverage.
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
const reactCorrectness = Object.fromEntries(
  Object.keys(react.configs['recommended-typescript'].rules)
    .filter((rule) => !excludedReactRules.has(rule.replace('@eslint-react/', '')))
    .map((rule) => [rule, 'error']),
);

export default defineConfig(
  globalIgnores([
    '.tools/**',
    'dist/**',
    'node_modules/**',
    'public/**',
    'service/**',
    'src-tauri/**',
  ]),
  {
    files: ['src/**/*.{ts,tsx}', 'vite.config.ts', 'vitest.config.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      'no-constant-binary-expression': 'error',
      'no-debugger': 'error',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['vite.config.ts', 'vitest.config.ts', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/*.test.{ts,tsx}'],
    extends: [tseslint.configs.recommendedTypeChecked],
    plugins: { 'react-hooks': hooks, '@eslint-react': react },
    settings: { react: { version: 'detect' } },
    rules: {
      ...reactCorrectness,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/set-state-in-render': 'error',
    },
  },
  {
    files: ['src/**/*.test.{ts,tsx}'],
    rules: {
      // Fixtures intentionally exercise invalid external shapes. Type-aware rules
      // run on production code; TypeScript still checks the entire test suite.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  { files: ['eslint.config.js'], extends: [js.configs.recommended] },
  prettier,
);
