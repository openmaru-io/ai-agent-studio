/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 고정폭 글꼴의 단일 정의. JetBrains Mono(SIL OFL 1.1)를 이미지에 번들한다(src/fonts.css, 폐쇄망). 한글은 Noto Sans KR 로 내려간다.
// 화면에서 'monospace' 를 직접 쓰지 않고 이 값을 쓴다(src/lib/monoFont.test.ts 가 지킨다).
export const MONO_FONT = "'JetBrains Mono', 'Noto Sans KR', ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
