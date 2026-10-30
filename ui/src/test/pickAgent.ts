/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 에이전트 자동완성(AgentPicker, OMAI-1225)에서 항목을 고르는 시험 도우미. 예전 NativeSelect 의 selectOptions 에 해당한다.
import { screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

export async function pickAgent(user: UserEvent, box: HTMLElement, option: string | RegExp) {
  await user.click(box);
  await user.click(await screen.findByRole('option', { name: option }));
}

/** 열린 목록의 항목 글자(예전 select 의 option 목록). 읽고 나서 닫는다. */
export async function listAgents(user: UserEvent, box: HTMLElement): Promise<string[]> {
  await user.click(box);
  const list = await screen.findByRole('listbox'); // 같은 화면의 기본 select 항목(예: 버전)과 섞이지 않게 열린 목록만 본다
  const names = within(list).getAllByRole('option').map((o) => o.textContent ?? '');
  await user.keyboard('{Escape}');
  return names;
}
