/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 내 정보 서랍의 비밀번호 입력 검사(스펙 2026-10-14-017 §6). 서버도 같은 규칙으로 다시 거른다.
export const PASSWORD_MIN = 8;

export type PasswordField = 'current' | 'new' | 'confirm';

/** 칸마다 지금 보여 줄 문제(번역 키). 비어 있는 칸은 문제로 치지 않는다(아직 입력 전). */
export function passwordProblems(current: string, next: string, confirm: string): Partial<Record<PasswordField, string>> {
  const out: Partial<Record<PasswordField, string>> = {};
  if (next && next.length < PASSWORD_MIN) out.new = 'account.tooShort';
  else if (next && current && next === current) out.new = 'account.same';
  if (confirm && next && confirm !== next) out.confirm = 'account.mismatch';
  return out;
}

/** 세 칸이 모두 차고 문제가 없을 때만 참. */
export const canSubmit = (current: string, next: string, confirm: string): boolean =>
  !!current && !!next && !!confirm && Object.keys(passwordProblems(current, next, confirm)).length === 0;
