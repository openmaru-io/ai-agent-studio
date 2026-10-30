/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { t } from '@/i18n';

// 흐름·설명 화면이 연결의 근거를 보이는 말. 옛 화면(삭제됨. 커밋 3e3319d 의 aas/web/js/flow.js)과 같다.
// 문장은 부를 때 만든다(언어를 바꾸면 바뀌어야 한다).
export const CONF_IDS = ['config', 'code', 'doc', 'mention', 'observed'];
export const KIND_IDS = ['cron', 'skill', 'script', 'mcp', 'host', 'cred', 'lib'];
export const REL_IDS = ['runs', 'calls', 'uses', 'imports', 'refers'];

/** 연결 근거의 [짧은 이름, 설명]. 모르는 값이면 undefined. */
export const confLabel = (c: string): [string, string] | undefined =>
  CONF_IDS.includes(c) ? [t(`flows.conf.${c}`), t(`flows.conf.${c}.hint`)] : undefined;
/** 노드 종류의 이름. 모르는 값이면 그대로 돌려준다. */
export const kindLabel = (k: string): string => (KIND_IDS.includes(k) ? t(`flows.kind.${k}`) : k);
/** 노드 종류를 나타내는 동그라미 안의 글자 */
export const kindMark = (k: string): string => (KIND_IDS.includes(k) ? t(`flows.mark.${k}`) : '');
/** 연결의 관계 이름. 모르는 값이면 빈 문자열. */
export const relLabel = (k: string): string => (REL_IDS.includes(k) ? t(`flows.rel.${k}`) : '');
