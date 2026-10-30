/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 채팅 「/」 2단계(스펙 2026-10-27-002) — Hermes 가 시작한 턴의 회색 줄, 목표·반복 줄, Hermes 에 넘긴 예약, 줄인 기록, 대화 목록 표시.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { setLang } from '@/i18n';
import { applyEvent, newSession } from '@/lib/chat';
import { applyCommand } from '@/lib/chatStore';
import { filterItems } from '@/lib/composerSuggest';
import type { CommandRow, SkillList } from '@/lib/useSkillSuggest';

import { CommandCard } from './CommandCard';
import { CommandRows, controlLines } from './CommandRows';
import { planSlash, slashItems } from './skillSuggest';

const base = { onQueue: () => {}, onCheck: () => {}, onDismiss: () => {} };

describe('Hermes 가 시작한 턴(§4-3·R8)', () => {
  it('까닭별 회색 줄을 사용자 말풍선 자리에 두고 답하는 중으로 바꾼다', () => {
    setLang('ko');
    const S = newSession({ session_id: 's', profile: 'p' });
    applyEvent(S, { type: 'aas.turn.auto', payload: { reason: 'loop' } });
    expect(S.items.at(-1)).toMatchObject({ kind: 'divider', code: 'auto', text: '반복 작업 차례' });
    expect(S.busy).toBe(true);
    applyEvent(S, { type: 'aas.turn.auto', payload: { reason: 'whatever' } });
    expect(S.items.at(-1)?.text).toBe('AI 에이전트가 스스로 시작한 답');
  });

  it('줄인 기록(compacted)은 이미 그린 화면을 바꾸지 않고, 새로 연 화면은 그린다(R10)', () => {
    const S = newSession({ session_id: 's', profile: 'p' });
    applyEvent(S, { type: 'aas.user', payload: { text: '첫 질문', turn: 1 } });
    applyEvent(S, { type: 'aas.history', payload: { compacted: true, messages: [{ role: 'user', text: '다른 것' }] } });
    expect(S.items.map((i) => i.text)).toEqual(['첫 질문']);
    const fresh = newSession({ session_id: 's', profile: 'p' });
    applyEvent(fresh, { type: 'aas.history', payload: { compacted: true, messages: [{ role: 'user', text: '첫 질문' }] } });
    expect(fresh.items[0]).toMatchObject({ kind: 'user', text: '첫 질문' });
  });

  it('aas.control 은 목표·반복·쉼 상태를 담는다', () => {
    const S = newSession({ session_id: 's', profile: 'p' });
    applyEvent(S, { type: 'aas.control', payload: { goal: { status: 'active', turns_used: 3, max_turns: 20 }, loop: null, resting: true } });
    expect(S.control).toEqual({ goal: { status: 'active', turns_used: 3, max_turns: 20 }, loop: null, heartbeat: null, resting: true });
  });
});

describe('목표·반복 줄(§4-3·R12·OV4)', () => {
  it('진행·멈춤만 줄이 되고 끝난 목표는 줄이 없다', () => {
    setLang('ko');
    expect(controlLines({ goal: { status: 'done', turns_used: 3, max_turns: 20 } })).toEqual([]);
    expect(controlLines({ goal: { status: 'active', turns_used: 3, max_turns: 20 }, loop: { status: 'paused' } }).map((l) => l.text)).toEqual([
      '목표 진행 중 · 3/20턴',
      '반복 멈춤',
    ]);
    expect(controlLines({ loop: { status: 'active' } })[0].text).toBe('반복 · 곧 다음 차례');
  });

  it('주인·관리자에게만 단추가 있고, 단추는 goal·loop 명령을 보낸다', async () => {
    setLang('ko');
    const onControl = vi.fn();
    const control = { goal: { status: 'active', turns_used: 1, max_turns: 20 }, loop: { status: 'paused' } };
    const { rerender } = render(<CommandRows {...base} control={control} canControl={false} onControl={onControl} />);
    expect(screen.getByTestId('control-goal').textContent).toContain('목표 진행 중');
    expect(screen.queryByRole('button', { name: '멈춤' })).toBeNull();
    rerender(<CommandRows {...base} control={control} canControl onControl={onControl} />);
    await userEvent.click(screen.getByRole('button', { name: '멈춤' }));
    await userEvent.click(screen.getByRole('button', { name: '다시' }));
    await userEvent.click(screen.getByRole('button', { name: '그만' }));
    expect(onControl.mock.calls).toEqual([
      ['goal', 'pause'],
      ['loop', 'resume'],
      ['loop', 'stop'],
    ]);
  });

  it('멈춤 뒤 쉬는 중이면 진행 중인 줄에 알린다', () => {
    setLang('ko');
    render(<CommandRows {...base} control={{ loop: { status: 'active' }, resting: true }} />);
    expect(screen.getByTestId('control-loop').textContent).toContain('멈춤 뒤 쉬는 중');
  });

  it('예약 줄이 있으면 목표 줄은 뒤로 미룬다(회색 줄은 한 번에 하나)', () => {
    render(<CommandRows {...base} queue={[{ id: 'q1', text: 'a' }]} control={{ goal: { status: 'active' } }} />);
    expect(screen.queryByTestId('control-goal')).toBeNull();
  });
});

describe('Hermes 에 넘긴 예약(R5)', () => {
  it('넘긴 예약은 지우기 단추 대신 「곧 보냄」', async () => {
    setLang('ko');
    render(<CommandRows {...base} queue={[{ id: 'q1', text: '넘긴 말', hermes: true }, { id: 'q2', text: '남은 말' }]} />);
    await userEvent.click(screen.getByRole('button', { name: '보기' }));
    expect(screen.getByText('곧 보냄')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '예약 취소: 넘긴 말' })).toBeNull();
    expect(screen.getByRole('button', { name: '예약 취소: 남은 말' })).toBeTruthy();
  });
});

describe('review·refine 결과 카드(§4-3)', () => {
  it('뒤에서 돈다는 안내를 붙인다', () => {
    setLang('ko');
    const S = newSession({ session_id: 's', profile: 'p' });
    applyCommand(S, '/review', { ok: true, result: { kind: 'output', command: '/review', text: 'started', background: true } });
    expect(S.items.at(-1)).toMatchObject({ kind: 'command', background: true });
    render(<CommandCard command="/review" text="started" background />);
    expect(screen.getByTestId('command-card').textContent).toContain('뒤에서 돌고 있습니다');
  });
});

describe('「/」 목록(OKE 화면 확인 2026-10-27)', () => {
  it('명령 묶음은 16개를 모두 보이고 스킬 묶음만 10개로 자른다', () => {
    const names = ['help', 'status', 'context', 'usage', 'retry', 'undo', 'compress', 'plan', 'queue', 'steer', 'learn', 'memory', 'review', 'refine', 'goal', 'loop'];
    const row = (n: string): CommandRow => ({ command: `/${n}`, name: n, description: n, hint: '', required: false });
    const data: SkillList = {
      skills: Array.from({ length: 30 }, (_, i) => ({ command: `/k${i}`, name: `k${i}`, description: '', usage: 0 })),
      commands: names.map(row),
      command_names: names.map((n) => `/${n}`),
      commands_blocked: [],
      commands_allowed: true,
    };
    const shown = filterItems(slashItems(data, false) ?? [], '');
    expect(shown.filter((it) => it.value.startsWith('/') && names.includes(it.value.slice(1))).length).toBe(16);
    expect(shown.filter((it) => it.value.startsWith('/k')).length).toBe(10);
  });
});

describe('다시 연 대화의 Hermes 가 시작한 턴(9-5)', () => {
  it('서버가 바꿔 준 auto 줄을 실시간 화면과 같은 회색 줄로 그린다', () => {
    setLang('ko');
    const S = newSession({ session_id: 's', profile: 'p' });
    applyEvent(S, {
      type: 'aas.history',
      payload: { messages: [{ role: 'user', text: '/goal x' }, { role: 'assistant', text: '1' }, { role: 'auto', reason: 'goal' }, { role: 'assistant', text: '2' }] },
    });
    expect(S.items.map((i) => [i.kind, i.text])).toEqual([
      ['user', '/goal x'],
      ['assistant', '1'],
      ['divider', '목표를 이어 하는 중'],
      ['assistant', '2'],
      ['divider', '여기까지 지난 대화'],
    ]);
  });
});

describe('3단계 명령(스펙 2026-10-27-004)', () => {
  const data = (extra: Partial<SkillList> = {}): SkillList => ({
    skills: [],
    commands: [
      { command: '/queue', name: 'queue', description: '', hint: '', required: true, while_busy: true },
      { command: '/btw', name: 'btw', description: '', hint: '', required: true, while_busy: true },
    ],
    command_names: ['/queue', '/btw', '/version', '/init', '/goal', '/title'],
    commands_blocked: [],
    commands_allowed: true,
    command_aliases: { '/q': 'queue' },
    owner_only: ['/goal', '/title'],
    ...extra,
  });
  const sug = (d: SkillList) => ({ data: d, error: false, open: () => {}, retry: () => {} });

  it('넣지 않은 Hermes 명령은 막고, 별칭은 정식 이름으로, 주인 전용은 그 까닭을 보인다', () => {
    setLang('ko');
    expect(planSlash('/version', sug(data()), [], false)).toMatchObject({ block: true, note: '이 화면에서는 /version 를 쓸 수 없습니다' });
    expect(planSlash('/q 다음 말', sug(data()), [], true)).toMatchObject({ command: { name: 'queue', arg: '다음 말' } });
    expect(planSlash('/goal 끝내기', sug(data()), [], false)).toMatchObject({ block: true, note: '이 명령은 AI 에이전트의 주인·관리자만 쓸 수 있습니다' });
    expect(planSlash('/btw 지금 몇 시', sug(data()), [], true)).toMatchObject({ command: { name: 'btw', arg: '지금 몇 시' } }); // 답하는 중에도
  });

  it('곁 질문 답은 결과 카드, 실패는 실패 문구, 기다림·끊김은 입력창 위 줄', () => {
    setLang('ko');
    const S = newSession({ session_id: 's', profile: 'p' });
    applyEvent(S, { type: 'aas.btw_wait', payload: { count: 2 } });
    expect(S.btwWait).toBe(2);
    applyEvent(S, { type: 'aas.btw', payload: { question: '몇 시', text: '3시' } });
    expect(S.items.at(-1)).toMatchObject({ kind: 'command', command: '/btw 몇 시', text: '3시' });
    applyEvent(S, { type: 'aas.btw', payload: { question: '몇 시', text: 'error: boom', failed: true } });
    expect(S.items.at(-1)).toMatchObject({ failed: true, text: '곁 질문에 답하지 못했습니다\nboom' });
    applyEvent(S, { type: 'aas.btw_wait', payload: { count: 0, lost: 1 } });
    expect(S.flash?.text).toBe('곁 질문 1개의 답을 받지 못했습니다 · 연결이 끊겼습니다');
    applyEvent(S, { type: 'aas.title', payload: { title: '배포 정리' } });
    expect(S.title).toBe('배포 정리');
    render(<CommandRows {...base} btwWait={2} />);
    expect(screen.getByTestId('command-row').textContent).toBe('곁 질문 2개 · 답을 기다리는 중');
  });

  it('heartbeat 줄과 단추(멈춤·지우기)', async () => {
    setLang('ko');
    expect(controlLines({ heartbeat: { status: 'active', interval_seconds: 300 } })[0].text).toBe('정기 확인 · 5분마다');
    expect(controlLines({ heartbeat: { status: 'paused' } })[0].text).toBe('정기 확인 멈춤');
    const onControl = vi.fn();
    render(<CommandRows {...base} control={{ heartbeat: { status: 'active', interval_seconds: 3600 } }} canControl onControl={onControl} />);
    expect(screen.getByTestId('control-heartbeat').textContent).toContain('1시간마다');
    await userEvent.click(screen.getByRole('button', { name: '멈춤' }));
    await userEvent.click(screen.getByRole('button', { name: '지우기' }));
    expect(onControl.mock.calls).toEqual([
      ['heartbeat', 'pause'],
      ['heartbeat', 'clear'],
    ]);
  });
});
