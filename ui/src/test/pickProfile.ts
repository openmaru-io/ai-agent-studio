/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 표 도구줄의 프로파일 고르기(ProfileScopePicker, MUI Select)를 다루는 시험 도우미 — 스킬 목록·API 키·토큰 시험이 함께 쓴다(스펙 2026-11-18-007 E13).
// MUI 메뉴는 포털에 그려지고 열린 목록의 role="option" 을 눌러야 고른다. 예전 기본 <select> 의 selectOptions 에 해당한다.
import { screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

/** 프로파일 고르기 칸(combobox). 글자 「프로파일:」 이 칸 안에 늘 보인다 */
export const profileBox = () => screen.findByRole('combobox', { name: '프로파일' });

/** 칸에 보이는 고른 값(보이는 이름, 예: 「main · 주 프로파일」) */
export const profileShown = async () => (await profileBox()).textContent ?? '';

/** 메뉴를 열어 보이는 이름이 option 인 항목을 고른다 */
export async function pickProfile(user: UserEvent, option: string | RegExp) {
  await user.click(await profileBox());
  const list = await screen.findByRole('listbox');
  await user.click(within(list).getByRole('option', { name: option }));
}

/** 열린 메뉴의 항목 글자(구분선·머리 글자는 빼고). 읽고 나서 닫는다 */
export async function listProfiles(user: UserEvent): Promise<string[]> {
  await user.click(await profileBox());
  const list = await screen.findByRole('listbox');
  const names = within(list).getAllByRole('option').map((o) => o.textContent ?? '');
  await user.keyboard('{Escape}');
  return names;
}
