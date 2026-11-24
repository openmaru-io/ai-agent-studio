/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// MindWiki 자동화 전용 프로파일(스펙 2026-11-21-002 §3-2 3): 기본 mindwiki-auto·mindwiki-auto-web 과 고른 프로파일의 복제본 mwauto-<T>·mwauto-web-<T>.
// 서버 aas/ops/mindwiki_webhook.py 의 is_auto_profile 과 같은 규칙이다. 프로파일 목록은 「MindWiki 자동화」 표시를 붙이고, 채팅 고르기에서는 뺀다.
const CLONE = /^mwauto-(web-)?[a-z0-9][a-z0-9_-]{0,29}$/;

export function isAutoProfile(name: string): boolean {
  return name === 'mindwiki-auto' || name === 'mindwiki-auto-web' || CLONE.test(name);
}
