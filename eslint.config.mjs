import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  eslint.configs.recommended,
  tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    // Explicit `project` array rather than `projectService.allowDefaultProject`
    // (the sibling package's approach): tsconfig.json excludes tests/ by
    // design, and this package's test directory is large enough that
    // enumerating every file individually hits typescript-eslint's built-in
    // safety cap on the "default project" fallback (>8 files). Pointing
    // tests/**/*.ts at tsconfig.tests.json directly - which already
    // `include`s them - resolves every file through a real project instead
    // of that fallback, with no cap.
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.tests.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Zero-runtime-dependency guard: src/ may only import Node builtins,
    // relative modules, and Playwright TYPES (erased at compile time - see
    // src/reporter.ts). A bare runtime import here would contradict this
    // package's README and package.json, both of which claim zero runtime
    // dependencies. This is best-effort static linting; the authoritative
    // check reads the BUILT dist/**/*.js in tests/zero-deps.spec.ts, since
    // that is the only place a real runtime import cannot hide.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "ImportDeclaration[importKind!='type']:not([source.value=/^(\\.|node:)/])",
          message:
            'src/ must not import a runtime package - this package has zero runtime dependencies. Use a node: builtin, a relative import, or `import type` (erased at compile time).',
        },
        {
          selector:
            "ExportNamedDeclaration[exportKind!='type'][source.value]:not([source.value=/^(\\.|node:)/])",
          message:
            'src/ must not re-export from a runtime package - this package has zero runtime dependencies.',
        },
      ],
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'playwright-report/', 'test-results/'],
  }
);
