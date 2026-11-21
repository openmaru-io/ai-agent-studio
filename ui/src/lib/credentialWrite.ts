/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 비밀값(.env) 쓰기 조건과 값 검사. 자격 증명 화면(Inventory)과 스킬 화면의 「값 넣기」 창이 함께 쓴다(스펙 2026-11-18-004).
// 쓰기는 프로파일 화면의 비밀값과 같은 경로(env_set → Hermes /api/env)다.
import { useQuery } from '@tanstack/react-query';

import { get } from '@/lib/api';
import { useIsAdmin, useMe } from '@/lib/data';
import type { ProfileRow } from '@/screens/profiles/types';

/** 서버 profiles.ENV_KEY 와 같다. SKILL.md 는 소문자 이름도 받지만 저장 경로는 이 규칙만 받는다 */
export const ENV_KEY = /^[A-Z][A-Z0-9_]{1,63}$/;

/** 서버가 받는 값의 상한(aas/web/server.py env_set). 화면은 UTF-16 길이로 대략 맞추고 최종 판정은 서버다 */
export const SECRET_MAX = 4000;

/**
 * 값을 넣을 수 있는 사람인가: 관리자 또는 이 POD 의 주인·팀 관리자(OMAI-1196, 스펙 2026-10-15-011 D3·2026-10-22-001), 그리고 암호화된 연결.
 * `secure` 가 undefined 면 아직 모름 — 쓰기를 닫는다. 주인이 넣을 수 없는 이름(모델 키·동작 설정)은 서버가 거절한다.
 */
export function useCanWriteSecrets() {
  const me = useMe();
  const admin = useIsAdmin();
  const may = admin || !!me.data?.owner || !!me.data?.team_manager;
  return { admin, may, secure: me.data?.secure };
}

/**
 * 자격 증명 화면용: 위 조건에 프로파일 목록(프로파일 고르기·숨긴 루트 판정)을 더한다.
 * 프로파일 고르기의 처음 값이 목록을 기다린다 — 안 기다리면 주소의 프로파일을 없는 이름으로 본다
 */
export function useCredentialWrite(enabled: boolean) {
  const { admin, may, secure } = useCanWriteSecrets();
  const list = useQuery<{ profiles: ProfileRow[] }>({
    queryKey: ['profiles'],
    queryFn: () => get('/api/profiles'),
    enabled: enabled && may,
  });
  const profiles = list.data?.profiles;
  const listed = !(enabled && may) || list.isFetched;
  // 목록을 못 받았으면 화면이 「다시 시도」를 보인다 — 실패가 「프로파일이 하나뿐」인 정상 상태처럼 보이지 않게(스펙 2026-11-18-007 F4)
  const failed = enabled && may && list.isError;
  return { admin, may, secure, profiles, listed, failed, retry: () => void list.refetch(), ready: enabled && may && secure === true && !!profiles };
}
export type CredentialWrite = ReturnType<typeof useCredentialWrite>;

/** 숨긴 루트(main 대상 POD)는 관리자에게도 읽기 전용이다(스펙 2026-10-14-003 리뷰 D8). 주인·팀 관리자의 목록에는 그 줄이 아예 없다 */
export const rootHidden = (profiles?: ProfileRow[]) => !!profiles?.find((p) => p.is_default)?.hidden_root;

/**
 * 보낼 값으로 다듬는다: 앞뒤 공백·줄바꿈만 지운다(토큰을 붙여 넣으면 끝에 줄바꿈이 따라온다).
 * 가운데 줄바꿈·NUL, 빈 값, 상한 초과는 오류 이유를 돌려준다. `Bearer ` 떼기는 서버가 한다.
 */
export function cleanSecret(raw: string): { value: string; error?: 'empty' | 'newline' | 'long' } {
  const value = raw.trim();
  if (!value) return { value, error: 'empty' };
  if (/[\r\n\0]/.test(value)) return { value, error: 'newline' };
  if (value.length > SECRET_MAX) return { value, error: 'long' };
  return { value };
}
