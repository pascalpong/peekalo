import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/.expo/**', '**/.next/**', '**/dist/**', '**/ios/**', '**/android/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs' }, rules: { '@typescript-eslint/no-require-imports': 'off' } },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly', console: 'readonly', URL: 'readonly', fetch: 'readonly',
        Buffer: 'readonly', FormData: 'readonly', Blob: 'readonly', setTimeout: 'readonly', AbortSignal: 'readonly',
      },
    },
  },
);
