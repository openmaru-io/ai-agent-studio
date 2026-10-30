/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// 일꾼은 기본 4개. 코어 수(16)만큼 띄우면 다른 세션·빌드와 겹친 컴퓨터(부하 평균 64)에서 시간 초과가 무작위로 났고,
// 4개는 시간 제한을 늘리지 않고도 전체가 통과하며 걸린 시간도 비슷했다(2026-10-22, 스펙 2026-10-21-015). VITEST_WORKERS 로 바꾼다(예: 8, 50%)
const workers = process.env.VITEST_WORKERS || '4';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    maxWorkers: workers.endsWith('%') ? workers : Number(workers),
  },
  resolve: { alias: { '@': '/src' } },
});
