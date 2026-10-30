/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// Monaco 편집 칸은 고치기를 누를 때 받는다(묶음 vendor-monaco). 첫 화면에 Monaco 를 싣지 않으려는 것이다.
import { lazy } from 'react';

export const LazyCodeEditor = lazy(() => import('./CodeEditor').then((m) => ({ default: m.CodeEditor })));
