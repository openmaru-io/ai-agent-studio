/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 변경 기록의 종류와 한 일. 서버가 안정적인 코드(kind)와 한국어 문장(group, what)을 함께 보내므로, 화면은 코드로 문장을 찾아
// 현재 언어로 보인다. 사전에 없는 코드는 서버가 보낸 문장을 그대로 보인다.
import { hasKey, t } from '@/i18n';

export type ChangeGroup = 'cron' | 'profile' | 'secret' | 'skill' | 'office' | 'market' | 'access' | 'settings' | 'work';

interface Row {
  kind?: string;
  group: string;
  what: string;
  /** 「일 시키기」를 같은 사람·대상·날짜로 묶은 건수(서버 changes.rows, 스펙 2026-10-22-001 DD7) */
  count?: number;
}

/** kind 의 앞부분으로 묶음을 정한다(서버 aas/ops/changes.py LABELS 의 묶음과 같다). */
export function changeGroupOf(kind = ''): ChangeGroup | undefined {
  if (kind.startsWith('cron_')) return 'cron';
  if (kind.startsWith('profile_env_') || kind.startsWith('profile_credential_')) return 'secret';   // 인증 파일(2026-10-22-004 R12)
  if (kind.startsWith('profile_')) return 'profile';
  if (kind.startsWith('skill_')) return 'skill';
  if (['chat_send', 'office_command', 'pc_import_start', 'pc_export'].includes(kind)) return 'work';   // 「일 시키기」 — office_ 접두사보다 먼저 가른다
  if (kind.startsWith('office_')) return 'office';
  if (kind.startsWith('market_')) return 'market';
  // 공지 올리기·내리기(notice_save·notice_remove)도 서버 LABELS 에서 「설정」 묶음이다(스펙 2026-10-24-007)
  if (kind.startsWith('settings_') || kind.startsWith('notice_')) return 'settings';
  // user_create·user_delete 등 사용자 관리 기록(2026-10-14-011)도 접속 묶음이다
  if (kind.startsWith('user_') || kind === 'login' || kind === 'login_failed' || kind === 'session_revoke') return 'access';
  return undefined;
}

export const isAccess = (r: Row): boolean => changeGroupOf(r.kind) === 'access';

/** 묶음 이름(현재 언어) */
export function changeGroupLabel(r: Row): string {
  const id = changeGroupOf(r.kind);
  return id && hasKey(`changes.group.${id}`) ? t(`changes.group.${id}`) : r.group;
}

/** 한 일(현재 언어). 묶은 줄은 「채팅 n회」처럼 건수로 말한다(DD7) */
export const changeWhat = (r: Row): string =>
  r.count && r.kind && hasKey(`changes.count.${r.kind}`)
    ? t(`changes.count.${r.kind}`, { n: r.count })
    : r.kind && hasKey(`changes.kind.${r.kind}`)
    ? t(`changes.kind.${r.kind}`)
    : r.what;
