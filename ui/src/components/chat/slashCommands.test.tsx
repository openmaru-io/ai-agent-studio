/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 입력창 「/」 Hermes 명령(스펙 2026-10-26-010 §11) — 목록 묶음·보내기 판정·이벤트 반영·명령 답 반영·입력창 단추.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { applyOfficeCommand } from '@/features/office/AgentChat';
import { applyEvent, newSession } from '@/lib/chat';
import { applyCommand } from '@/lib/chatStore';
import { activeToken, applyPickToFront, filterItems } from '@/lib/composerSuggest';
import type { CommandRow, SkillList, SkillSuggest } from '@/lib/useSkillSuggest';

import { Composer, ComposerProps } from './Composer';
import { planSlash, skillSuggestItems, slashCount, slashItems, slashSource } from './skillSuggest';

const cmd = (name: string, extra: Partial<CommandRow> = {}): CommandRow => ({
  command: `/${name}`,
  name,
  description: `${name} 설명`,
  hint: '',
  required: false,
  ...extra,
});
const NAMES = ['help', 'status', 'context', 'usage', 'retry', 'undo', 'compress', 'plan', 'queue', 'steer'].map((n) => `/${n}`);
const DATA: SkillList = {
  skills: [{ command: '/요약', name: '요약', description: '주간 요약', usage: 1 }],
  commands: [cmd('status'), cmd('retry'), cmd('undo', { hint: '[턴 수]' }), cmd('steer', { required: true, while_busy: true, hint: '<할 말>' }), cmd('queue', { required: true, while_busy: true })],
  command_names: NAMES,
  commands_blocked: ['/plan'],
  commands_allowed: true,
};
const sug = (data: SkillList | null, error = false): SkillSuggest => ({ data, error, open: () => {}, retry: () => {} });

describe('slashItems — 두 묶음(DC1·DC6·DC13)', () => {
  it('명령 묶음이 먼저, 스킬 묶음이 다음이다', () => {
    const items = slashItems(DATA)!;
    expect(items.map((i) => i.group)).toEqual(['명령', '명령', '명령', '명령', '명령', '스킬']);
    expect(items[2].hint).toBe('[턴 수]');
    expect(slashCount(items)).toBe('명령 5개 · 스킬 1개');
  });

  it('스킬이 없으면 스킬 묶음 안 상태 줄 — 명령은 그대로 보인다', () => {
    const items = slashItems({ ...DATA, skills: [] })!;
    expect(items.filter((i) => i.group === '명령')).toHaveLength(5);
    expect(items[items.length - 1]).toMatchObject({ group: '스킬', note: true, label: '이 프로파일에 쓸 수 있는 스킬이 없습니다' });
  });

  it('답하는 중이면 /steer·/queue 만, 스킬은 숨긴다', () => {
    expect(slashItems(DATA, true)!.map((i) => i.value)).toEqual(['/steer', '/queue']);
  });

  it('관리하지 않는 사람은 명령 자리에 상태 줄 하나', () => {
    const items = slashItems({ ...DATA, commands: [], commands_allowed: false })!;
    expect(items[0]).toMatchObject({ group: '명령', note: true, label: 'AI 에이전트를 관리하는 사람만 쓸 수 있습니다' });
    expect(items.slice(1).map((i) => i.value)).toEqual(['/요약']);
  });

  it('명령 칸이 없는 응답(회의실)은 지금처럼 스킬만', () => {
    expect(slashItems({ skills: DATA.skills })).toEqual(skillSuggestItems({ skills: DATA.skills }));
  });

  it('글자로 거르면 묶음 순서를 지키고 상태 줄은 숨긴다', () => {
    const items = slashItems({ ...DATA, skills: [] })!;
    expect(filterItems(items, 'st').map((i) => i.value)).toEqual(['/status', '/steer']);
    const mixed = filterItems(slashItems({ ...DATA, skills: [{ command: '/stats', name: 'stats', description: '', usage: 0 }] })!, 'st');
    expect(mixed.map((i) => i.group)).toEqual(['명령', '명령', '스킬']);
  });

  it('묶음 목록은 머리줄을 묶음별로 쓰고 개수 글도 묶음별이다', () => {
    const src = slashSource(sug(DATA), slashItems(DATA));
    expect(src.title).toBe('');
    expect(src.countText(6, slashItems(DATA)!)).toBe('명령 5개 · 스킬 1개');
  });
});

describe('planSlash — 보내기 전 판정(DC5·DC6·DC10)', () => {
  const plan = (text: string, data: SkillList | null = DATA, busy = false, error = false) =>
    planSlash(text, sug(data, error), skillSuggestItems(data), busy);

  it('쓸 수 있는 명령은 실행하고 인자를 뗀다', () => {
    expect(plan('/undo 2')).toMatchObject({ command: { name: 'undo', arg: '2' }, note: '· 명령 /undo 를 실행합니다' });
    expect(plan('  /status')).toMatchObject({ command: { name: 'status', arg: '' } });
  });

  it('명령 이름인데 쓸 수 없으면 이유를 보이고 막는다 — 글로 모델에 가지 않는다', () => {
    expect(plan('/plan 정리')).toMatchObject({ warn: true, block: true });
    expect(plan('/compress')).toMatchObject({ warn: true, block: true, note: '이 화면에서는 /compress 를 쓸 수 없습니다' });
    expect(plan('/status', { ...DATA, commands: [], commands_allowed: false })).toMatchObject({
      warn: true,
      block: true,
      note: '이 명령은 AI 에이전트를 관리하는 사람만 쓸 수 있습니다',
    });
  });

  it('필요한 인자가 비면 막는다', () => {
    expect(plan('/steer')).toMatchObject({ block: true, note: '/steer 뒤에 할 말을 쓰세요' });
    expect(plan('/steer ')).toMatchObject({ block: true });
  });

  it('답하는 중에는 /steer·/queue 만', () => {
    expect(plan('/retry', DATA, true)).toMatchObject({ block: true, note: '답이 끝난 뒤에 쓸 수 있습니다' });
    expect(plan('/steer 테스트도', DATA, true)).toMatchObject({ command: { name: 'steer', arg: '테스트도' } });
  });

  it('목록을 읽는 중이면 기다리고, 읽지 못했으면 글로 보낸다', () => {
    expect(plan('/undo', null)).toMatchObject({ block: true, note: '명령 목록을 읽는 중…' });
    const failed = plan('/undo', { skills: [] }, false, true);
    expect(failed.block).toBeFalsy();
    expect(failed.command).toBeUndefined();
    expect(failed.note).toBe('명령 목록을 읽지 못해 글로 보냅니다');
  });

  it('명령이 아니면 스킬, 둘 다 아니면 글', () => {
    expect(plan('/요약 이번 주')).toMatchObject({ skill: '요약' });
    expect(plan('/etc/hosts 봐 줘')).toEqual({});
    expect(plan('그냥 말')).toEqual({});
  });
});

describe('이벤트 반영(lib/chat.ts)', () => {
  it('되감은 기록은 목록을 비우고 다시 그린다 — 「지난 대화」 선 대신 무엇이 일어났는지(DC3)', () => {
    const S = newSession({ session_id: 's', profile: 'p' });
    applyEvent(S, { type: 'aas.user', payload: { text: '첫 질문' } });
    applyEvent(S, { type: 'message.complete', payload: { text: '첫 답' } });
    S.items.push({ kind: 'command', command: '/status', text: 'x' });
    applyEvent(S, { type: 'aas.history', payload: { rewound: 'undo', turns: 2, messages: [{ role: 'user', text: '앞' }] } });
    expect(S.items.map((i) => i.kind)).toEqual(['user', 'divider']);
    expect(S.items[1]).toMatchObject({ code: 'rewound', text: '턴 2개를 되돌렸습니다' });
    applyEvent(S, { type: 'aas.user', payload: { text: '앞', retry: true } });
    expect(S.items[2]).toMatchObject({ kind: 'user', retried: true });
  });

  it('compress 기다림·예약·사라진 예약', () => {
    const S = newSession({ session_id: 's', profile: 'p' });
    applyEvent(S, { type: 'aas.compress', payload: { state: 'start', at: 100 } });
    expect(S.compressing).toBe(100000);
    applyEvent(S, { type: 'aas.compress', payload: { state: 'timeout' } });
    expect([S.compressing, S.compressSlow]).toEqual([0, true]);
    applyEvent(S, { type: 'aas.queue', payload: { items: [{ id: 'q1', text: '다음' }], held: true } });
    expect([S.queue?.length, S.queueHeld]).toEqual([1, true]);
    applyEvent(S, { type: 'aas.history', payload: { messages: [] } }); // 서버가 다시 시작돼 대화를 다시 열었다
    expect([S.queue, S.queueLost]).toEqual([[], 1]);
  });
});

describe('명령 답 반영(11-4)', () => {
  it('채팅: 결과는 카드, 사용법은 회색 카드(입력 유지), 바쁨은 잠깐 줄, 그 밖은 호박색 안내', () => {
    const S = newSession({ session_id: 's', profile: 'p' });
    expect(applyCommand(S, '/status', { ok: true, result: { kind: 'output', command: '/status', text: 'ok' } })).toEqual({ input: 'clear' });
    expect(S.items[0]).toMatchObject({ kind: 'command', command: '/status', text: 'ok' });
    expect(applyCommand(S, '/steer', { ok: false, error: { code: 'usage', text: 'u' } })).toEqual({ input: 'keep' });
    expect(S.items[1]).toMatchObject({ kind: 'command', command: '/steer' });
    expect(applyCommand(S, '/retry', { ok: false, error: { code: 'busy', text: 'b' } })).toEqual({ input: 'keep' });
    expect(S.flash?.text).toBe('b');
    applyCommand(S, '/plan x', { ok: false, error: { code: 'collision', text: 'c' } });
    expect(S.items[2]).toMatchObject({ kind: 'notice', code: 'command', text: 'c' });
    expect(S.items.some((i) => i.kind === 'error')).toBe(false); // 빨간 오류 줄은 쓰지 않는다(DC11)
    expect(applyCommand(S, '/undo', { ok: true, result: { kind: 'prefill', text: '첫 질문' } })).toEqual({ input: 'prefill', draft: '첫 질문' });
    expect(applyCommand(S, '/retry', { ok: true, result: { kind: 'retry_failed', text: 'q' } })).toEqual({ input: 'prefill', draft: 'q' });
    expect(S.retryFailed).toBe(true);
  });

  it('오피스: 되감은 기록으로 바꾸고 retry 는 표시를 단 내 말과 차례를 연다', () => {
    const c = { lines: [{ role: 'user' as const, text: '옛' }], draft: '/retry', turn: null, next: 3, error: '', past: 'done' as const };
    applyOfficeCommand(c, '/retry', {
      ok: true,
      result: { kind: 'turn', turn: 'run_1', text: '첫 질문', retry: true, messages: [{ role: 'assistant', text: '앞 답' }] },
      queue: { items: [], held: false },
    });
    expect(c.lines.map((l) => l.role)).toEqual(['assistant', 'divider', 'user']);
    expect(c.lines[2]).toMatchObject({ text: '첫 질문', retried: true });
    expect([c.turn, c.next, c.draft]).toEqual(['run_1', 0, '']);
  });
});

function Harness(p: Partial<ComposerProps> & { onSend: () => void }) {
  const [v, setV] = useState(p.value ?? '');
  return <Composer value={v} onChange={setV} sendOn="enter" canSend={!!v.trim()} inputLabel="메시지" sendLabel="보내기" stopLabel="멈춤" {...p} />;
}

describe('입력창(DC6·DC1)', () => {
  it('답하는 중 명령이면 [보내기][멈춤] 두 단추이고 Enter 로 보낸다', async () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} busy sendWhileBusy value="/steer 테스트도" onStop={vi.fn()} />);
    expect(screen.getByRole('button', { name: '보내기' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '멈춤' })).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: '메시지' }), '{Enter}');
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('답하는 중 그 밖의 글은 멈춤 단추만', () => {
    render(<Harness onSend={vi.fn()} busy value="그냥" onStop={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '보내기' })).toBeNull();
  });

  it('묶음 머리줄을 그리고 아래 키는 상태 줄을 건너뛴다', async () => {
    const data = { ...DATA, skills: [] };
    const onSend = vi.fn();
    render(<Harness onSend={onSend} suggest={[slashSource(sug(data), slashItems(data))]} />);
    const box = screen.getByRole('textbox', { name: '메시지' });
    await userEvent.type(box, '/');
    expect(screen.getByRole('group', { name: '명령 · 5' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '스킬' })).toBeInTheDocument();
    for (let i = 0; i < 5; i++) await userEvent.keyboard('{ArrowDown}');
    // 다섯 번 내리면 마지막 명령(/queue) 다음 상태 줄을 건너뛰어 처음(/status)으로 돈다
    expect(screen.getByRole('option', { name: /\/status/, selected: true })).toBeInTheDocument();
  });
});

describe('글 중간 「/」(12-7, 사용자 결정 D1 A)', () => {
  it('고르면 맨 앞으로 옮기고 앞뒤 글은 인자가 된다', () => {
    const v = '이 파일을 요약해 줘 /요';
    const tok = activeToken(v, v.length, '/', 'word')!;
    expect(applyPickToFront(v, tok, { value: '/요약', label: '/요약' })).toEqual({ value: '/요약 이 파일을 요약해 줘', caret: '/요약 이 파일을 요약해 줘'.length });
    const w = '@관리자 정리해 줘 /st';
    const t2 = activeToken(w, w.length, '/', 'word')!;
    expect(applyPickToFront(w, t2, { value: '/status', label: '/status' }, '@관리자 '.length).value).toBe('@관리자 /status 정리해 줘');
  });

  it('입력창에서 글 중간 「/」에도 목록이 뜨고, 고르면 맨 앞으로 간다', async () => {
    render(<Harness onSend={vi.fn()} suggest={[slashSource(sug(DATA), slashItems(DATA))]} />);
    const box = screen.getByRole('textbox', { name: '메시지' });
    await userEvent.type(box, '이번 주 정리 /요');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await userEvent.keyboard('{Enter}');
    expect(box).toHaveValue('/요약 이번 주 정리');
  });

  it('글 중간 경로처럼 맞는 것이 없으면 목록이 닫혀 있다', async () => {
    render(<Harness onSend={vi.fn()} suggest={[slashSource(sug(DATA), slashItems(DATA))]} />);
    await userEvent.type(screen.getByRole('textbox', { name: '메시지' }), '설정은 /etc');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
