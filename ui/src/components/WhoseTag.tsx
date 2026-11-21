/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 프로파일 이름 옆에 붙이는 「누구의」. 사용자마다 주 프로파일이 main 이라 「main」만으로는 누구의 것인지 모른다.
// 모델 화면(스펙 2026-11-17-002)에서 만들고, 스킬 허브 「설치된 곳」(OMAI-2086)도 같이 쓰려고 여기로 옮겼다.
import { Typography } from '@mui/material';

import { t } from '@/i18n';
import { agentLabel, agentProfileLabel } from '@/lib/agentLabel';
import { profileName } from '@/lib/format';

/** 서버가 응답에 붙여 주는 설치본 글자 재료(`_pod_label`). 옛 서버는 보내지 않는다 */
export interface PodLabel {
  pod?: string;
  name?: string;
  owner_name?: string;
}

/** short 는 칸 안 글자(주인 이름, 없으면 에이전트 이름), full 은 「주인 · 에이전트」(머리·풍선말) */
export interface Whose {
  short: string;
  full: string;
}

export const whoseOf = (d?: PodLabel): Whose =>
  d?.pod ? { short: d.owner_name || d.name || '', full: agentLabel({ id: d.pod, name: d.name, owner_name: d.owner_name }) } : { short: '', full: '' };

/** 「주인 · 에이전트 › 프로파일」. 설치본을 모르면(옛 서버) 프로파일 이름만 */
export const whoseProfile = (d: PodLabel | undefined, profile: string): string =>
  d?.pod ? agentProfileLabel({ id: d.pod, name: d.name, owner_name: d.owner_name }, profileName(profile)) : profileName(profile);

export function WhoseTag({ w, title }: { w: Whose; title?: string }) {
  return w.short ? (
    <Typography component="span" variant="caption" color="text.secondary" noWrap title={title ?? t('common.agentOf', { agent: w.full })} sx={{ ml: 1 }}>
      {w.short}
    </Typography>
  ) : null;
}
