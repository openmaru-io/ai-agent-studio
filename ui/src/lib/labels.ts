/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 출처·채널 이름. 옛 화면(삭제됨. 커밋 3e3319d 의 aas/web/js/store.js)과 같다.
// 이름은 번역 사전(labels.*)에 있고 읽는 때에 현재 언어로 나온다(게터). 제품 이름(CLI, API)은 번역하지 않아도 사전에 둔다.
import { t } from '@/i18n';

/** 키마다 사전 키를 두고, 읽을 때 번역해 돌려주는 객체. Object.entries 로 돌려도 번역된 값이 나온다. */
function labels(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, dictKey] of Object.entries(map))
    Object.defineProperty(out, k, { enumerable: true, get: () => t(dictKey) });
  return out;
}

export const SRC: Record<string, string> = labels({
  aas: 'labels.src.aas',
  buzz: 'labels.src.buzz',
  telegram: 'labels.src.telegram',
  slack: 'labels.src.slack',
  mattermost: 'labels.src.mattermost',
  cli: 'labels.src.cli',
  cron: 'labels.src.cron',
  api_server: 'labels.src.api',
  tui: 'labels.src.tui',
});

export const CH: Record<string, string> = labels({
  telegram: 'labels.ch.telegram',
  buzz: 'labels.ch.buzz',
  slack: 'labels.ch.slack',
  discord: 'labels.ch.discord',
  mattermost: 'labels.ch.mattermost',
  api_server: 'labels.ch.apiServer',
  whatsapp: 'labels.ch.whatsapp',
  email: 'labels.ch.email',
});
