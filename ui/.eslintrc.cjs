/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

module.exports = {
  root: true,
  env: { browser: true, es2020: true, node: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react/jsx-runtime',
    'plugin:react-hooks/recommended',
    'plugin:jsx-a11y/recommended',
    'prettier',
  ],
  // scene3d(옛 이름 claw3d)는 MIT 원본(Claw3D 0565b78)을 가져온 것이라 우리 규칙(헤더·정렬)을 적용하지 않는다. 고친 곳은 CLAW3D_CHANGES.md 에 적는다.
  ignorePatterns: ['.eslintrc.cjs', 'vite.config.ts', 'vitest.config.ts', 'scripts', 'parity', 'src/features/office/scene3d'],
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
  plugins: ['@typescript-eslint', 'react', 'react-hooks', 'jsx-a11y', 'simple-import-sort', 'unused-imports', 'header'],
  settings: { react: { version: 'detect' } },
  rules: {
    'react/prop-types': 'off',
    'react/display-name': 'off',
    '@typescript-eslint/no-unused-vars': 'off',
    '@typescript-eslint/no-explicit-any': 'warn',
    'simple-import-sort/imports': 'error',
    'simple-import-sort/exports': 'error',
    'unused-imports/no-unused-imports': 'error',
    'unused-imports/no-unused-vars': ['warn', { vars: 'all', varsIgnorePattern: '^_', args: 'after-used', argsIgnorePattern: '^_' }],
    'header/header': ['error', 'block', ['', ' * Copyright 2026 OPENMARU, Inc.', ' * SPDX-License-Identifier: Apache-2.0', ' ']],
  },
};
