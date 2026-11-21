/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLang } from '@/i18n';

import { applyEvent, elapsedText, groupItems, guardBlockReason, newSession, pending, Session } from './chat';
import { isLlmBlocked, LLM_BLOCK_MARK } from './llmBlock';
import { noteServerDate } from './serverClock';

const sess = (): Session => newSession({ session_id: 's1', profile: 'ma', title: '', running: false });
const ev = (type: string, payload: Record<string, unknown> = {}) => ({ type, payload });

afterEach(() => setLang('ko'));

describe('applyEvent', () => {
  it('지난 대화(history)를 항목으로 풀고 첫 사용자 글을 제목으로, 끝에 구분선을 둔다', () => {
    const S = sess();
    applyEvent(
      S,
      ev('aas.history', {
        messages: [
          { role: 'user', text: '안녕\n두 번째 줄', timestamp: 100 },
          { role: 'assistant', text: '네', timestamp: 101 },
          { role: 'tool', name: 'search', context: 'q', timestamp: 102 },
        ],
      })
    );
    expect(S.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool', 'divider']);
    expect(S.title).toBe('안녕');
    expect(S.items[0].t).toBe(100000);
    expect(S.items[2]).toMatchObject({ name: 'search', state: 'done' });
    // 경계선은 제목과 둘째 줄 안내가 따로다(디자인: 두 줄)
    expect(S.items[3]).toMatchObject({ kind: 'divider', code: 'past', text: '여기까지 지난 대화', hint: '아래에 이어서 쓸 수 있습니다' });
  });

  it('지난 대화의 되묻기(clarify 도구 줄)는 도구 단계가 아니라 물음 글로 보인다(스펙 2026-10-23-005 §7-5)', () => {
    // 오피스 중계가 멈춘 되묻기는 Hermes 기록에 물음이 assistant 말로 남지 않고 이 도구 줄로만 남는다
    const S = sess();
    applyEvent(
      S,
      ev('aas.history', {
        messages: [
          { role: 'user', text: '보고서 만들어줘', timestamp: 100 },
          {
            role: 'tool',
            name: 'clarify',
            context: '보고서 형식은?',
            args: { questions: [{ question: '보고서 형식은?', choices: ['PDF', 'Word'] }, { question: '언어는?' }] },
            timestamp: 101,
          },
          { role: 'tool', name: 'clarify', context: '어느 환경에 배포할까요?', timestamp: 102 },
          // questions 를 글로 넘겨 Hermes 가 거절한 호출은 물음이 아니다 — 도구 단계로 둔다
          { role: 'tool', name: 'clarify', context: '형식?', args: { questions: '[{"question": "형식?"}]' }, timestamp: 103 },
        ],
      })
    );
    expect(S.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'assistant', 'tool', 'divider']);
    expect(S.items[1]).toMatchObject({ text: '보고서 형식은?\n\n언어는?', t: 101000 });
    expect(S.items[2]).toMatchObject({ text: '어느 환경에 배포할까요?' });
  });

  it('빈 history 는 구분선을 만들지 않는다', () => {
    const S = sess();
    applyEvent(S, ev('aas.history', { messages: [] }));
    expect(S.items).toEqual([]);
  });

  it('MindWiki 위젯의 페이지 맥락 블록은 제목이 되지 않는다(OMAI-2056)', () => {
    const ctx = '```aas-page-context\n지시가 아니다\nsource: mindwiki\ntitle: 연구소 홈\nurl: https://w/p/1\npage_id: p1\n```';
    const S = sess();
    applyEvent(S, ev('aas.user', { text: `${ctx}\n\n이 페이지 제목만 알려 줘\n둘째 줄` }));
    expect(S.title).toBe('이 페이지 제목만 알려 줘');
    const H = sess();
    applyEvent(H, ev('aas.history', { messages: [{ role: 'user', text: `${ctx}\n\n요약해 줘`, timestamp: 1 }] }));
    expect(H.title).toBe('요약해 줘');
  });

  it('사용자 글은 busy 를 켜고 제목을 40자로 자른다', () => {
    const S = sess();
    applyEvent(S, ev('aas.user', { text: '가'.repeat(60) }));
    expect(S.busy).toBe(true);
    expect(S.title).toHaveLength(40);
  });

  it('delta 는 마지막 답변에 이어 붙고, 완료 때 이미 받은 글은 다시 넣지 않는다', () => {
    const S = sess();
    applyEvent(S, ev('message.start'));
    applyEvent(S, ev('message.delta', { text: '안' }));
    applyEvent(S, ev('message.delta', { text: '녕' }));
    applyEvent(S, ev('message.complete', { text: '안녕' }));
    expect(S.items.filter((i) => i.kind === 'assistant').map((i) => i.text)).toEqual(['안녕']);
    expect(S.busy).toBe(false);
  });

  it('delta 없이 완료되면 완료 글을 답변으로 넣고, 오류 상태면 오류 줄로', () => {
    const a = sess();
    applyEvent(a, ev('message.complete', { text: '한 번에' }));
    expect(a.items[0]).toMatchObject({ kind: 'assistant', text: '한 번에' });
    const b = sess();
    applyEvent(b, ev('message.complete', { status: 'error', text: '실패' }));
    expect(b.items[0]).toMatchObject({ kind: 'error', text: '실패' });
    const c = sess();
    applyEvent(c, ev('message.complete', { status: 'error' }));
    expect(c.items[0].text).toBe('오류');
  });

  it('완료되면 돌던 도구를 마친 것으로 바꾼다', () => {
    const S = sess();
    applyEvent(S, ev('tool.start', { tool_id: 't1', name: 'web' }));
    applyEvent(S, ev('message.complete', { text: 'x' }));
    expect(S.items[0].state).toBe('done');
  });

  it('상태·생각 줄은 하나를 갱신하고, 추론은 이어 붙는다', () => {
    const S = sess();
    applyEvent(S, ev('thinking.delta', { text: ' 생각 1 ' }));
    applyEvent(S, ev('status.update', { text: '검색 중' }));
    expect(S.items.filter((i) => i.kind === 'status')).toHaveLength(1);
    expect(S.items[0].text).toBe('검색 중');
    applyEvent(S, ev('reasoning.delta', { text: '가' }));
    applyEvent(S, ev('reasoning.delta', { text: '나' }));
    expect(S.items.find((i) => i.kind === 'reason')?.text).toBe('가나');
    applyEvent(S, ev('status.update', { text: '' }));
    expect(S.items).toHaveLength(2);
  });

  it('Hermes 의 장식 문구(얼굴 문자 + 동사...)는 버리고, 기다림 안내(⏳·⚠·↻)는 단계 줄에 둔다', () => {
    const S = sess();
    expect(applyEvent(S, ev('thinking.delta', { text: '(⊙_⊙) reflecting...' }))).toBe(false);
    applyEvent(S, ev('thinking.delta', { text: '( •_•)>⌐■-■ 생각 중...' }));
    expect(S.items).toHaveLength(0);
    applyEvent(S, ev('thinking.delta', { text: '⏳ waiting on qwen — no response for 30s' }));
    expect(S.items).toMatchObject([{ kind: 'status', text: '⏳ waiting on qwen — no response for 30s' }]);
    applyEvent(S, ev('thinking.delta', { text: '⚠ no output from provider for 60s — reconnecting...' }));
    applyEvent(S, ev('thinking.delta', { text: '↻ model returned reasoning with no final answer' }));
    expect(S.items).toMatchObject([{ kind: 'status', text: '↻ model returned reasoning with no final answer' }]);
  });

  it('도구: 시작 → 진행(맥락 갱신) → 완료(소요 시간) / 실패', () => {
    const S = sess();
    applyEvent(S, ev('tool.start', { tool_id: 'a', name: 'web', context: 'q1' }));
    applyEvent(S, ev('tool.progress', { tool_id: 'a', text: 'q2' }));
    expect(S.items[0]).toMatchObject({ state: 'running', context: 'q2' });
    S.items[0].t0 = Date.now() - 1500;
    applyEvent(S, ev('tool.complete', { tool_id: 'a' }));
    expect(S.items[0].state).toBe('done');
    expect(S.items[0].ms).toBeGreaterThanOrEqual(1500);
    applyEvent(S, ev('tool.start', { tool_id: 'b' }));
    applyEvent(S, ev('tool.complete', { tool_id: 'b', error: 'x' }));
    expect(S.items[1]).toMatchObject({ state: 'failed', name: 'tool' });
  });

  // OMAI-1868: 다시 받은 이벤트(catchUp)는 한꺼번에 들어와 화면 시각으로 재면 0초가 됐다. 서버 시각(aas_at)으로 잰다
  it('도구 소요 시간은 서버가 붙인 aas_at 으로 잰다(다시 받기에서도 실제 시간)', () => {
    const S = sess();
    applyEvent(S, ev('tool.start', { tool_id: 'a', name: 'web', aas_at: 1000.25 }));
    applyEvent(S, ev('tool.complete', { tool_id: 'a', aas_at: 1003.5 }));
    expect(S.items[0].ms).toBe(3250);
  });

  // OMAI-1868: 다시 이어진 대화는 기록으로 도구 줄을 다시 만들어 이미 잰 시간이 사라졌다
  it('기록으로 합칠 때 이미 잰 도구 소요 시간을 옮긴다', () => {
    const S = sess();
    applyEvent(S, ev('aas.user', { text: '질문', turn: 1 }));
    applyEvent(S, ev('tool.start', { tool_id: 'a', name: 'tool_call', aas_at: 10 }));
    applyEvent(S, ev('tool.complete', { tool_id: 'a', aas_at: 12.5 }));
    applyEvent(S, ev('tool.start', { tool_id: 'b', name: 'tool_call', aas_at: 13 }));
    applyEvent(S, ev('tool.complete', { tool_id: 'b', aas_at: 20 }));
    S.merging = true;
    applyEvent(
      S,
      ev('aas.history', {
        messages: [
          { role: 'user', text: '질문', timestamp: 1 },
          { role: 'tool', name: 'tool_call', context: 'x', timestamp: 2 },
          { role: 'tool', name: 'tool_call', context: 'y', timestamp: 2 },
          { role: 'assistant', text: '답', timestamp: 3 },
        ],
      })
    );
    const tools = S.items.filter((x) => x.kind === 'tool');
    expect(tools.map((x) => [x.context, x.ms])).toEqual([
      ['x', 2500],
      ['y', 7000],
    ]);
  });

  it('안전장치(hardline·거절 규칙)가 막은 도구는 막힘과 이유를 남긴다(스펙 2026-10-24-004)', () => {
    const S = sess();
    const hard = { output: '', exit_code: -1, status: 'blocked',
      error: 'BLOCKED (hardline): recursive delete of Hermes data (/opt/data/profiles/x). This command is on the unconditional blocklist and cannot be executed via the agent.' };
    applyEvent(S, ev('tool.start', { tool_id: 'a', name: 'terminal' }));
    applyEvent(S, ev('tool.complete', { tool_id: 'a', result: hard }));
    expect(S.items[0]).toMatchObject({ state: 'failed', guard: 'recursive delete of Hermes data (/opt/data/profiles/x)' });
    applyEvent(S, ev('tool.start', { tool_id: 'b', name: 'terminal' }));
    applyEvent(S, ev('tool.complete', { tool_id: 'b', result: JSON.stringify(hard) }));   // 문자열 결과도
    expect(S.items[1].guard).toBe('recursive delete of Hermes data (/opt/data/profiles/x)');
  });

  it('다시 연 대화의 기록에서도 막힌 도구 줄에 이유를 남긴다(스펙 2026-10-24-004 6절)', () => {
    const S = sess();
    applyEvent(S, ev('aas.history', { messages: [
      { role: 'user', text: 'q', timestamp: 100 },
      { role: 'tool', name: 'terminal', context: 'rm -rf /opt/data', guard: 'recursive delete of Hermes data (/opt/data)', timestamp: 101 },
      { role: 'tool', name: 'terminal', context: 'ls', timestamp: 102 },
      { role: 'assistant', text: '실행되지 않았습니다', timestamp: 103 },
    ] }));
    const tools = S.items.filter((x) => x.kind === 'tool');
    expect(tools.map((x) => [x.state, x.guard])).toEqual([['failed', 'recursive delete of Hermes data (/opt/data)'], ['done', undefined]]);
  });

  it('사용자 거부·위험 판정 거절·보통 실패는 안전장치 표시가 아니다', () => {
    expect(guardBlockReason({ status: 'blocked', error: "BLOCKED: this command matches the user-defined deny rule 'git push --force*' (approvals.deny in config.yaml)." }))
      .toBe('git push --force*');
    expect(guardBlockReason({ status: 'blocked', error: 'BLOCKED: User denied this potentially dangerous command' })).toBe('');
    expect(guardBlockReason({ status: 'error', error: 'BLOCKED (hardline): x' })).toBe('');      // blocked 상태만
    expect(guardBlockReason({ output: 'BLOCKED (hardline): x', exit_code: 0 })).toBe('');       // 명령 출력 속 글자
    expect(guardBlockReason('not json')).toBe('');
    expect(guardBlockReason(undefined)).toBe('');
  });

  it('승인 요청은 대기 항목이 되고 답하면 사라진다', () => {
    const S = sess();
    applyEvent(S, ev('approval.request', { request_id: 'r1', command: 'rm x' }));
    expect(pending(S)).toHaveLength(1);
    applyEvent(S, ev('aas.approval.answered', { choice: 'once' }));
    expect(pending(S)).toHaveLength(0);
    expect(S.items[0].answered).toBe('once');
  });

  it('되묻기는 질문마다 항목을 만들고, 답은 request_id 와 질문 id 로 맞춘다', () => {
    const S = sess();
    applyEvent(
      S,
      ev('clarify.request', {
        request_id: 'q',
        questions: [
          { qid: 'a', question: '하나?', choices: ['x'] },
          { qid: 'b', question: '둘?', multi_select: true },
        ],
      })
    );
    expect(pending(S)).toHaveLength(2);
    applyEvent(S, ev('aas.clarify.answered', { request_id: 'q', question_id: 'b', answer: ['m', 'n'] }));
    expect(S.items[1].answered).toBe('m, n');
    expect(S.items[1].multi).toBe(true);
    expect(pending(S)).toHaveLength(1);
  });

  it('단일 질문 형식도 받는다', () => {
    const S = sess();
    applyEvent(S, ev('clarify.request', { request_id: 'q', question: '계속?', choices: ['예', '아니오'] }));
    expect(S.items[0]).toMatchObject({ kind: 'clarify', question: '계속?', request_id: 'q' });
  });

  it('error 이벤트와 연결 끊김은 busy 를 끄고, 끊김은 대화를 닫는다', () => {
    const S = sess();
    S.busy = true;
    applyEvent(S, ev('error', { message: '서버 오류' }));
    expect(S.busy).toBe(false);
    expect(S.items[0]).toMatchObject({ kind: 'error', text: '서버 오류' });
    applyEvent(S, ev('aas.disconnected', { text: '끊김' }));
    expect(S.closed).toBe(true);
  });

  it('서버의 끊김 코드(hub_disconnected)는 서버 문장이 아니라 화면 언어의 문장으로 보인다', () => {
    setLang('en');
    const S = sess();
    applyEvent(S, ev('aas.disconnected', { code: 'hub_disconnected', text: 'Hermes API 서버 연결이 끊겼습니다.' }));
    expect(S.items[0]).toMatchObject({ kind: 'error', text: 'Lost the connection to the Hermes API server. Select Reopen to open the latest chat again.', reopen: true });
    setLang('ko');
    const K = sess();
    applyEvent(K, ev('aas.disconnected', { code: 'hub_disconnected', text: 'x' }));
    expect(K.items[0]).toMatchObject({ text: 'Hermes API 서버 연결이 끊겼습니다. 「다시 열기」를 누르면 가장 최근 대화를 다시 엽니다.' });
  });

  it('모르는 이벤트는 무시하고 false 를 돌려준다. 새 항목에는 시각이 붙는다', () => {
    const S = sess();
    expect(applyEvent(S, ev('zzz'))).toBe(false);
    expect(applyEvent(S, ev('message.complete', { text: 'a' }))).toBe(true);
    expect(S.items[0].t).toBeGreaterThan(0);
  });
});

describe('groupItems', () => {
  it('진행 단계(상태·도구·추론)는 한 묶음으로, 나머지는 그대로', () => {
    const S = sess();
    applyEvent(S, ev('aas.user', { text: 'q' }));
    applyEvent(S, ev('status.update', { text: '생각' }));
    applyEvent(S, ev('tool.start', { tool_id: 'a', name: 'web' }));
    applyEvent(S, ev('tool.complete', { tool_id: 'a' }));
    applyEvent(S, ev('message.complete', { text: '답' }));
    const g = groupItems(S);
    expect(g.map((x) => (x.type === 'item' ? x.item.kind : x.type))).toEqual(['day', 'user', 'steps', 'assistant']);
    const steps = g[2];
    expect(steps.type === 'steps' && steps.items).toHaveLength(2);
  });

  it('날짜가 바뀌면 날짜 줄을 끼우고 연속한 같은 말투는 이어 붙임 표시를 한다', () => {
    const S = sess();
    S.items = [
      { kind: 'user', text: 'a', t: new Date(2026, 9, 9, 10).getTime() },
      { kind: 'user', text: 'b', t: new Date(2026, 9, 9, 10, 1).getTime() },
      { kind: 'assistant', text: 'c', t: new Date(2026, 9, 10, 9).getTime() },
    ];
    const g = groupItems(S);
    expect(g.map((x) => x.type)).toEqual(['day', 'item', 'item', 'day', 'item']);
    const second = g[2];
    expect(second.type === 'item' && second.cont).toBe(true);
    const third = g[4];
    expect(third.type === 'item' && third.cont).toBe(false);
  });
});

// 저절로 다시 연 대화의 기록 합치기(스펙 2026-10-20-030 RD1·RD2)
describe('applyEvent: 다시 연 대화의 기록 합치기', () => {
  it('마지막 사람 말 뒤의 답만 기록으로 바꾸고 파일 칩·안내는 남긴다. 구분선은 넣지 않는다', () => {
    const S = sess();
    applyEvent(S, ev('aas.user', { text: '첫 말' }));
    applyEvent(S, ev('message.complete', { text: '첫 답' }));
    applyEvent(S, ev('aas.user', { text: '둘째 말' }));
    applyEvent(S, ev('message.delta', { text: '반쯤' }));
    applyEvent(S, ev('aas.notice', { code: 'cwd_unchanged' }));
    S.merging = true;
    applyEvent(S, ev('aas.history', { messages: [
      { role: 'user', text: '첫 말' }, { role: 'assistant', text: '첫 답' },
      { role: 'user', text: '둘째 말' }, { role: 'tool', name: 'terminal' }, { role: 'assistant', text: '끝난 답' },
    ] }));
    expect(S.items.map((i) => [i.kind, i.text ?? i.name ?? i.code])).toEqual([
      ['user', '첫 말'], ['assistant', '첫 답'], ['user', '둘째 말'], ['tool', 'terminal'], ['assistant', '끝난 답'], ['notice', 'cwd_unchanged'],
    ]);
    expect(S.merging).toBe(false);
  });

  it('화면에 남은 되묻기 줄이 있으면 기록의 같은 물음 글을 더하지 않는다(스펙 2026-10-23-005 §7-5)', () => {
    const S = sess();
    applyEvent(S, ev('aas.user', { text: '보고서' }));
    applyEvent(S, ev('clarify.request', { request_id: 'q', question: '형식?', choices: ['PDF'] }));
    applyEvent(S, ev('aas.clarify.answered', { request_id: 'q', answer: 'PDF' }));
    S.merging = true;
    applyEvent(S, ev('aas.history', { messages: [
      { role: 'user', text: '보고서' }, { role: 'tool', name: 'clarify', args: { questions: [{ question: '형식?' }] } },
      { role: 'assistant', text: 'PDF 로 만들었습니다' },
    ] }));
    expect(S.items.map((i) => [i.kind, i.text ?? i.question])).toEqual([
      ['user', '보고서'], ['assistant', 'PDF 로 만들었습니다'], ['clarify', '형식?'],
    ]);
  });

  it('답하는 중에 다른 서버로 다시 열려 앞 조각을 놓치면 끝날 때 전체 답으로 바꾼다(T11)', () => {
    // OKE 에서 파드를 지운 뒤 1~838 이 빠지고 「8」·839~2000 만 남았다 — Hermes 는 다시 연 뒤의 조각만 새 연결로 보낸다
    const S = sess();
    applyEvent(S, ev('aas.user', { text: '1부터 9까지' }));
    applyEvent(S, ev('message.delta', { text: '1\n2\n3\n' }));
    S.merging = true;
    applyEvent(S, ev('aas.history', { messages: [{ role: 'user', text: '1부터 9까지' }] }));
    applyEvent(S, ev('message.delta', { text: '7\n8\n9' }));
    applyEvent(S, ev('message.complete', { text: '1\n2\n3\n4\n5\n6\n7\n8\n9' }));
    expect(S.items.map((i) => [i.kind, i.text])).toEqual([['user', '1부터 9까지'], ['assistant', '1\n2\n3\n4\n5\n6\n7\n8\n9']]);
  });

  it('Hermes 가 최종 글을 바꿨으면(response_transformed) 받은 조각 대신 끝 글로 바꾼다(OMAI-1863)', () => {
    // Hermes 패치 tool-result-verbatim 이 도구가 완성한 답(SQL·표·차트)을 모델 글 앞에 붙인다. 모델 글은 끝 공백까지 달라 접미 비교가 맞지 않았다
    const S = sess();
    applyEvent(S, ev('aas.user', { text: '2025년 시도별 공급세대수' }));
    applyEvent(S, ev('message.delta', { text: '조회가 완료되었습니다. ' }));
    applyEvent(S, ev('message.complete', { text: '## SQL\n...\n\n조회가 완료되었습니다.', response_transformed: true }));
    expect(S.items.map((i) => [i.kind, i.text])).toEqual([
      ['user', '2025년 시도별 공급세대수'], ['assistant', '## SQL\n...\n\n조회가 완료되었습니다.'],
    ]);
  });

  it('조각을 다 받았으면 끝 글이 달라도 받은 글을 그대로 둔다', () => {
    const S = sess();
    applyEvent(S, ev('aas.user', { text: '안녕' }));
    applyEvent(S, ev('message.delta', { text: '안녕하세요 ' }));
    applyEvent(S, ev('message.complete', { text: '안녕하세요' }));
    expect(S.items.map((i) => i.text)).toEqual(['안녕', '안녕하세요 ']);
  });

  it('기록에서 마지막 사람 말을 찾지 못하면 목록을 기록으로 바꾼다', () => {
    const S = sess();
    applyEvent(S, ev('aas.user', { text: '다른 대화의 말' }));
    S.merging = true;
    applyEvent(S, ev('aas.history', { messages: [{ role: 'user', text: '서버 기록' }] }));
    expect(S.items.map((i) => i.text)).toEqual(['서버 기록']);
  });

  it('session.title 의 저장 대화 id 를 기억하고, 포기 줄은 404 면 「새 대화」, 아니면 「다시 열기」', () => {
    const S = sess();
    applyEvent(S, ev('session.title', { session_id: 'st-9', title: 'x' }));
    expect(S.storedId).toBe('st-9');
    expect(S.items).toHaveLength(0);
    applyEvent(S, ev('aas.reconnect.failed', { code: 'not_found' }));
    expect(S.items.at(-1)).toMatchObject({ kind: 'error', newChat: true, text: '이 대화를 찾을 수 없습니다. 새 대화를 시작하세요.' });
    applyEvent(S, ev('aas.reconnect.failed', { code: 'expired' }));
    expect(S.items.at(-1)).toMatchObject({ kind: 'error', reopen: true, text: '이 대화를 다시 열지 못했습니다.' });
  });
});

// 스펙 2026-10-23-005: Hermes 서버 요청의 취소·다시 받기·답 짝 맞추기
describe('승인·되묻기 취소와 짝 맞추기', () => {
  const ask = (S: Session) => {
    applyEvent(S, ev('approval.request', { request_id: 'q-1', srq_id: 'srq-a', command: 'ls' }));
    applyEvent(S, ev('clarify.request', { request_id: 'srq-c', questions: [{ qid: 'q0', question: '형식?' }, { qid: 'q1', question: '언제?' }] }));
  };

  it('취소되면 그 요청의 카드만 닫고 이유를 남긴다', () => {
    const S = sess();
    ask(S);
    applyEvent(S, ev('aas.request.cancelled', { request_id: 'srq-c', method: 'clarify', reason: 'timeout' }));
    expect(pending(S).map((x) => x.kind)).toEqual(['approval']);
    expect(S.items.filter((x) => x.cancelled).map((x) => [x.qid, x.cancelled])).toEqual([
      ['q0', 'timeout'],
      ['q1', 'timeout'],
    ]);
    expect(S.cancelN).toBe(1);
  });

  it('승인 취소는 대기열 번호로 찾는다', () => {
    const S = sess();
    ask(S);
    applyEvent(S, ev('aas.request.cancelled', { request_id: 'q-1', method: 'approval', reason: 'interrupted' }));
    expect(S.items.find((x) => x.kind === 'approval')?.cancelled).toBe('interrupted');
  });

  it('이미 답한 카드는 뒤늦은 resolved 로 바뀌지 않는다(R11)', () => {
    const S = sess();
    ask(S);
    applyEvent(S, ev('aas.approval.answered', { request_id: 'q-1', choice: 'once' }));
    applyEvent(S, ev('aas.request.cancelled', { request_id: 'q-1', method: 'approval', reason: 'resolved' }));
    const it = S.items.find((x) => x.kind === 'approval');
    expect([it?.answered, it?.cancelled]).toEqual(['once', undefined]);
    expect(S.cancelN).toBeUndefined();
  });

  it('승인이 둘이면 답은 대기열 번호가 같은 카드에 붙는다', () => {
    const S = sess();
    applyEvent(S, ev('approval.request', { request_id: 'q-1', command: 'a' }));
    applyEvent(S, ev('approval.request', { request_id: 'q-2', command: 'b' }));
    applyEvent(S, ev('aas.approval.answered', { request_id: 'q-1', choice: 'deny' }));
    expect(S.items.filter((x) => x.kind === 'approval').map((x) => x.answered)).toEqual(['deny', null]);
  });

  // 서버가 다시 시작돼 대화를 다시 열면 열린 요청이 다시 온다(R6). 화면에 이미 있는 요청은 두 번 넣지 않는다(로컬 E2E 2026-10-23 에서 카드가 둘)
  it('같은 요청이 다시 오면 카드를 하나만 둔다', () => {
    const S = sess();
    ask(S);
    ask(S);
    expect(pending(S).map((x) => `${x.kind}:${x.qid ?? ''}`)).toEqual(['approval:', 'clarify:q0', 'clarify:q1']);
  });

  it('다시 받은 묶음은 이미 잠긴 답을 답한 것으로 둔다(R6)', () => {
    const S = sess();
    applyEvent(
      S,
      ev('clarify.request', {
        request_id: 'srq-r',
        questions: [
          { qid: 'q0', question: '형식?' },
          { qid: 'q1', question: '항목?', multi_select: true },
          { qid: 'q2', question: '언제?' },
        ],
        answers: { q0: 'PDF', q1: '["매출","비용"]' },
      })
    );
    expect(S.items.map((x) => x.answered)).toEqual(['PDF', '매출, 비용', null]);
    expect(pending(S).map((x) => x.qid)).toEqual(['q2']);
  });
});


describe('LLM 가드 거절(OMAI-1857 D17·M6)', () => {
  // 가드가 OKE 카나리에서 실제로 낸 문구. 서버 시험(tests/test_workspace_notices.py LlmBlockTest)도 같은 파일을 읽는다
  const FIXTURE = readFileSync(resolve(__dirname, '../../../tests/fixtures/llm_guard_block.txt'), 'utf-8').trim();
  const ev = (type: string, payload: Record<string, unknown>) => ({ type, payload }) as Parameters<typeof applyEvent>[1];

  it('오류 이벤트의 거절은 번역 안내 한 줄로, 연달아 와도 한 줄', () => {
    expect(isLlmBlocked(FIXTURE)).toBe(true);
    const S = sess();
    applyEvent(S, ev('error', { message: FIXTURE }));
    applyEvent(S, ev('message.complete', { status: 'error', text: FIXTURE }));
    const errs = S.items.filter((x) => x.kind === 'error');
    expect(errs).toHaveLength(1);
    expect(errs[0].llmBlocked).toBe(true);
    expect(errs[0].text).not.toContain(LLM_BLOCK_MARK);
  });

  it('모델 답 본문이 구절을 인용해도 바꾸지 않고, 다른 오류는 원문', () => {
    const S = sess();
    applyEvent(S, ev('message.complete', { status: 'complete', text: `가드는 "${LLM_BLOCK_MARK}" 라고 답합니다` }));
    applyEvent(S, ev('error', { message: 'timeout' }));
    expect(S.items.find((x) => x.kind === 'assistant')?.text).toContain(LLM_BLOCK_MARK);
    expect(S.items.find((x) => x.kind === 'error')).toMatchObject({ text: 'timeout' });
    expect(S.items.find((x) => x.kind === 'error')?.llmBlocked).toBeUndefined();
  });
});

// 스펙 2026-11-07-001 ②: 도구 실패 정의(E8)·도구의 LLM 가드 막힘(E2)·턴 단위 안내 한 줄(디자인 1A)
describe('도구 실패와 가드 막힘(2026-11-07-001 E2·E8)', () => {
  const FIXTURE = readFileSync(resolve(__dirname, '../../../tests/fixtures/llm_guard_block.txt'), 'utf-8').trim();
  const run = (S: Session, name: string, result: unknown, id = name) => {
    applyEvent(S, ev('tool.start', { tool_id: id, name }));
    applyEvent(S, ev('tool.complete', { tool_id: id, result }));
    return S.items.filter((x) => x.kind === 'tool').at(-1)!;
  };
  const guidance = (S: Session) =>
    groupItems(S).filter((b) => b.type === 'item' && b.item.kind === 'error' && b.item.llmBlocked).map((b) => (b.type === 'item' ? b.item : null));

  it('TTS 의 success:false 는 실패, 터미널 exit_code 1 은 실패, 성공은 완료', () => {
    const S = sess();
    expect(run(S, 'text_to_speech', JSON.stringify({ success: false, error: 'no key\nmore' }))).toMatchObject({ state: 'failed', failReason: 'no key' });
    expect(run(S, 'terminal', { output: 'x', exit_code: 1 }).state).toBe('failed');
    expect(run(S, 'image_generate', { status: 'error' }).state).toBe('failed');
    expect(run(S, 'terminal', JSON.stringify({ output: 'ok', exit_code: 0 })).state).toBe('done');
    expect(run(S, 'text_to_speech', { success: true, file: 'a.mp3' }).state).toBe('done');
    expect(run(S, 'web_search', 'plain text result').state).toBe('done');
  });

  it('실패 이유는 error 첫 줄 80자', () => {
    const S = sess();
    expect(run(S, 'x', { error: 'e'.repeat(120) }).failReason).toHaveLength(80);
  });

  it('실패한 도구의 error·output 에 구절이 있으면 llmBlocked, 묶음 바깥에 도구용 안내 한 줄', () => {
    const S = sess();
    applyEvent(S, ev('aas.user', { text: '읽어 줘' }));
    expect(run(S, 'text_to_speech', JSON.stringify({ success: false, error: FIXTURE }))).toMatchObject({ state: 'failed', llmBlocked: true });
    expect(run(S, 'terminal', { output: `Traceback...\n${FIXTURE}`, exit_code: 1 }).llmBlocked).toBe(true);
    applyEvent(S, ev('message.complete', { text: '못 했습니다' }));
    const blocks = groupItems(S);
    const at = blocks.findIndex((b) => b.type === 'steps');
    expect(blocks[at + 1]).toMatchObject({ type: 'item', item: { kind: 'error', code: 'tool_blocked', name: 'text_to_speech' } });
    expect(guidance(S)).toHaveLength(1);
    expect(guidance(S)[0]?.text).toBe('text_to_speech 도구가 AAS LiteLLM 을 거치지 않는 설정이라 막혔습니다. 관리자에게 설정 변경을 요청하세요.');
  });

  it('성공한 도구 출력이 구절을 인용해도 안내가 없다(M6 유지)', () => {
    const S = sess();
    applyEvent(S, ev('aas.user', { text: 'cat' }));
    const it2 = run(S, 'terminal', JSON.stringify({ output: `문서: ${FIXTURE}`, exit_code: 0 }));
    expect(it2.state).toBe('done');
    expect(it2.llmBlocked).toBeUndefined();
    expect(guidance(S)).toHaveLength(0);
  });

  it('같은 턴의 채팅 오류 거절과 겹치면 안내는 한 번. 다음 턴은 다시 보인다', () => {
    const S = sess();
    applyEvent(S, ev('aas.user', { text: '1' }));
    run(S, 'text_to_speech', { success: false, error: FIXTURE });
    applyEvent(S, ev('error', { message: FIXTURE }));
    expect(S.items.filter((x) => x.kind === 'error')).toHaveLength(0); // 도구 줄이 이미 안내를 낸다
    expect(guidance(S)).toHaveLength(1);
    applyEvent(S, ev('aas.user', { text: '2' }));
    applyEvent(S, ev('error', { message: FIXTURE }));
    run(S, 'text_to_speech', { success: false, error: FIXTURE }, 'tts2');
    expect(guidance(S)).toHaveLength(2); // 둘째 턴: 채팅 오류 줄 하나만(도구용 안내는 붙지 않는다)
    expect(guidance(S)[1]?.code).toBeUndefined();
  });

  it('안전장치 차단은 guard 로 남고 llmBlocked 가 붙지 않는다(겹침 없음)', () => {
    const S = sess();
    const it2 = run(S, 'terminal', { status: 'blocked', error: 'BLOCKED (hardline): rm -rf. x' });
    expect(it2).toMatchObject({ state: 'failed', guard: 'rm -rf' });
    expect(it2.llmBlocked).toBeUndefined();
  });

  it('지난 대화(history)의 llm_blocked·failed 를 따른다', () => {
    const S = sess();
    applyEvent(
      S,
      ev('aas.history', {
        messages: [
          { role: 'user', text: 'a' },
          { role: 'tool', name: 'text_to_speech', llm_blocked: true },
          { role: 'tool', name: 'image_generate', failed: true },
          { role: 'tool', name: 'web_search' },
        ],
      })
    );
    const tools = S.items.filter((x) => x.kind === 'tool');
    expect(tools.map((x) => [x.state, !!x.llmBlocked])).toEqual([
      ['failed', true],
      ['failed', false],
      ['done', false],
    ]);
    expect(guidance(S)).toHaveLength(1);
  });
});

// 스펙 2026-11-07-001 ①③: 메모리 초과 원인 줄·끝난 대화·지우는 중
describe('다시 연 대화의 원인 줄(2026-11-07-001 ①③)', () => {
  const OOM = { code: 'oom_restart', finished_at: '2026-11-07T01:02:03Z', limit_memory: '4Gi' };

  it('oom_restart 는 한 번만 넣고 앞선 hub_disconnected 오류 줄을 회색 줄로 바꾼다', () => {
    const S = sess();
    applyEvent(S, ev('aas.user', { text: 'a' }));
    applyEvent(S, ev('aas.disconnected', { code: 'hub_disconnected', text: 'x' }));
    applyEvent(S, ev('aas.notice', OOM));
    applyEvent(S, ev('aas.notice', OOM));
    expect(S.items.filter((x) => x.code === 'oom_restart')).toHaveLength(1);
    expect(S.items.find((x) => x.code === 'oom_restart')?.oom).toEqual({ finished_at: OOM.finished_at, limit_memory: '4Gi' });
    expect(S.items.some((x) => x.kind === 'error')).toBe(false);
    expect(S.items.find((x) => x.code === 'reconnected')).toMatchObject({ kind: 'notice' });
  });

  it('다시 열기 실패에 oom 이 있으면 원인 줄이 실패 줄 위에', () => {
    const S = sess();
    applyEvent(S, ev('aas.reconnect.failed', { code: 'expired', oom: { finished_at: OOM.finished_at, limit_memory: '' } }));
    expect(S.items.map((x) => x.code ?? x.kind)).toEqual(['oom_restart', 'error']);
    expect(S.items[1]).toMatchObject({ text: '이 대화를 다시 열지 못했습니다.', reopen: true });
  });

  it('profile_deleted·profile_not_found 는 끝난 대화(줄 하나), profile_deleting 은 회색 줄', () => {
    const S = sess();
    applyEvent(S, ev('aas.disconnected', { code: 'profile_deleted', text: 'x' }));
    applyEvent(S, ev('aas.reconnect.failed', { code: 'profile_not_found' }));
    expect(S.ended).toBe(true);
    expect(S.closed).toBe(true);
    expect(S.items.map((x) => x.code)).toEqual(['profile_ended']);
    const D = sess();
    applyEvent(D, ev('aas.reconnect.failed', { code: 'profile_deleting' }));
    expect(D.ended).toBeUndefined();
    expect(D.items.map((x) => [x.kind, x.code])).toEqual([['notice', 'profile_deleting']]);
  });
});

describe('응답 시간(스펙 2026-11-06-006)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('질문부터 응답 완료까지를 마지막 답에만 붙인다', () => {
    const S = sess();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    applyEvent(S, ev('aas.user', { text: '질문' }));
    applyEvent(S, ev('message.delta', { text: '확인한다' }));
    applyEvent(S, ev('tool.start', { tool_id: 't1', name: 'query' }));
    applyEvent(S, ev('message.delta', { text: '최종 답' }));
    now.mockReturnValue(1_065_000);
    applyEvent(S, ev('message.complete', { text: '최종 답' }));
    expect(S.items.filter((x) => x.kind === 'assistant').map((x) => x.elapsedMs)).toEqual([undefined, 65000]);
  });

  it('서버 시각(aas_at)이 있으면 그것으로 잰다 — 새로 고쳐 다시 받아도 같은 값', () => {
    const S = sess();
    vi.spyOn(Date, 'now').mockReturnValue(9_999_000);
    applyEvent(S, ev('aas.user', { text: '질문', aas_at: 1000 }));
    applyEvent(S, ev('message.delta', { text: '답' }));
    applyEvent(S, ev('message.complete', { text: '답', aas_at: 1065 }));
    expect(S.items.find((x) => x.kind === 'assistant')?.elapsedMs).toBe(65000);
  });

  it('오류·중지로 끝난 차례와 Hermes 가 스스로 시작한 차례에는 붙이지 않는다', () => {
    const S = sess();
    applyEvent(S, ev('aas.user', { text: '질문', aas_at: 1 }));
    applyEvent(S, ev('message.delta', { text: '답' }));
    applyEvent(S, ev('message.complete', { status: 'error', text: '실패', aas_at: 5 }));
    applyEvent(S, ev('aas.user', { text: '긴 질문', aas_at: 10 }));
    applyEvent(S, ev('message.delta', { text: '1 2 3' }));
    applyEvent(S, ev('message.complete', { status: 'interrupted', text: '1 2 3', aas_at: 15 }));
    applyEvent(S, ev('aas.turn.auto', { reason: 'goal' }));
    applyEvent(S, ev('message.delta', { text: '자동 차례 답' }));
    applyEvent(S, ev('message.complete', { text: '자동 차례 답' }));
    expect(S.items.some((x) => x.elapsedMs !== undefined)).toBe(false);
  });

  it('지난 대화: 질문과 마지막 답의 저장 시각 차이를 마지막 답에만 붙인다', () => {
    const S = sess();
    applyEvent(
      S,
      ev('aas.history', {
        messages: [
          { role: 'user', text: '질문', timestamp: 100 },
          { role: 'assistant', text: '확인한다', timestamp: 106 },
          { role: 'tool', name: 'query', timestamp: 110 },
          { role: 'assistant', text: '최종 답', timestamp: 165 },
          { role: 'user', text: '다음 질문', timestamp: 200 },
          { role: 'assistant', text: '두 번째 답', timestamp: 251 },
        ],
      })
    );
    expect(S.items.filter((x) => x.kind === 'assistant').map((x) => x.elapsedMs)).toEqual([undefined, 65000, 51000]);
  });

  it('지난 대화: 아직 답하는 중인 마지막 차례에는 붙이지 않는다', () => {
    const S = newSession({ session_id: 's1', profile: 'ma', title: '', running: true });
    applyEvent(
      S,
      ev('aas.history', {
        messages: [
          { role: 'user', text: '질문', timestamp: 100 },
          { role: 'assistant', text: '확인한다', timestamp: 106 },
        ],
      })
    );
    expect(S.items.some((x) => x.elapsedMs !== undefined)).toBe(false);
  });

  // 5절: 마우스를 올리면 모델·MCP·그 밖의 도구 시간(R1~R5). 값은 정수 초, 세 줄 합 = 보이는 총 시간
  const parts = (S: Session) => S.items.filter((x) => x.kind === 'assistant').at(-1)?.elapsedParts;
  const tool = (S: Session, id: string, name: string, from: number, to?: number) => {
    applyEvent(S, ev('tool.start', { tool_id: id, name, aas_at: from }));
    if (to !== undefined) applyEvent(S, ev('tool.complete', { tool_id: id, aas_at: to }));
  };

  it('MCP 만 쓴 차례: 모델 = 총 − MCP, 화면 시계와 관계없다', () => {
    const S = sess();
    vi.spyOn(Date, 'now').mockReturnValue(9_999_000);
    applyEvent(S, ev('aas.user', { text: '질문', aas_at: 1000 }));
    tool(S, 'a', 'mcp__db__query', 1002, 1012);
    applyEvent(S, ev('message.delta', { text: '답' }));
    applyEvent(S, ev('message.complete', { text: '답', aas_at: 1051 }));
    expect(parts(S)).toEqual({ model: 41, mcp: 10, other: 0 });
  });

  it('겹쳐 돈 도구는 한 번만 센다(MCP 끼리, MCP 와 그 밖의 도구)', () => {
    const S = sess();
    applyEvent(S, ev('aas.user', { text: '질문', aas_at: 1000 }));
    tool(S, 'a', 'mcp__db__query', 1002, 1012);
    tool(S, 'b', 'mcp__db__chart', 1010, 1011);
    tool(S, 'c', 'terminal', 1008, 1020);
    applyEvent(S, ev('message.delta', { text: '답' }));
    applyEvent(S, ev('message.complete', { text: '답', aas_at: 1051 }));
    expect(parts(S)).toEqual({ model: 33, mcp: 10, other: 8 });
  });

  it('반올림해도 세 줄 합이 보이는 총 시간과 같다(1초 미만 소수는 반올림 오차)', () => {
    const S = sess();
    applyEvent(S, ev('aas.user', { text: '질문', aas_at: 100 }));
    tool(S, 'a', 'mcp__db__query', 100, 100.6);
    tool(S, 'b', 'terminal', 100.7, 101.3);
    applyEvent(S, ev('message.delta', { text: '답' }));
    applyEvent(S, ev('message.complete', { text: '답', aas_at: 101.4 }));
    const it = S.items.find((x) => x.kind === 'assistant')!;
    const p = it.elapsedParts!;
    const whole = (n: number) => (n < 1 ? 0 : n);
    expect(whole(p.model) + whole(p.mcp) + whole(p.other)).toBe(Math.round(it.elapsedMs! / 1000));
    expect(Object.values(p).every((n) => n >= 0)).toBe(true);
  });

  it('총이 1초 미만이면 모델 시간도 0.1초 단위라 합을 넘지 않는다', () => {
    const S = sess();
    applyEvent(S, ev('aas.user', { text: '질문', aas_at: 1000 }));
    applyEvent(S, ev('message.delta', { text: '답' }));
    applyEvent(S, ev('message.complete', { text: '답', aas_at: 1000.8 }));
    expect(parts(S)).toEqual({ model: 0.8, mcp: 0, other: 0 });
  });

  it('다시 연결해 기록으로 바뀐 질문: 저장 시각과 실시간 완료(서버 시각)로 잰다 — PC 시계와 섞지 않는다', () => {
    const S = sess();
    S.merging = true; // 화면에 없던 질문이라 기록으로 통째로 바뀐다
    applyEvent(S, ev('aas.history', { messages: [{ role: 'user', text: '질문', timestamp: 1000 }] }));
    expect(S.items.map((x) => x.kind)).toEqual(['user']);
    vi.spyOn(Date, 'now').mockReturnValue(1_180_000_000); // PC 시계가 크게 어긋나 있다
    applyEvent(S, ev('message.delta', { text: '답' }));
    applyEvent(S, ev('message.complete', { text: '답', aas_at: 1051 }));
    expect(S.items.find((x) => x.kind === 'assistant')?.elapsedMs).toBe(51000);
  });

  it('질문 줄의 시각은 화면 시계다(서버 시각은 응답 시간 재기에만)', () => {
    const S = sess();
    vi.spyOn(Date, 'now').mockReturnValue(5_000_000);
    applyEvent(S, ev('aas.user', { text: '질문', aas_at: 1000 }));
    expect(S.items[0]).toMatchObject({ t: 5_000_000, at0: 1000 });
  });

  it('1초 미만 도구 시간은 0 이 아니라 0.1초 단위로 둔다', () => {
    const S = sess();
    applyEvent(S, ev('aas.user', { text: '질문', aas_at: 1000 }));
    tool(S, 'a', 'mcp__db__query', 1002, 1002.3);
    tool(S, 'b', 'terminal', 1003, 1003.01);
    applyEvent(S, ev('message.delta', { text: '답' }));
    applyEvent(S, ev('message.complete', { text: '답', aas_at: 1068 }));
    expect(parts(S)).toEqual({ model: 68, mcp: 0.3, other: 0.1 });
  });

  it('시간을 모르는 도구가 섞이거나 질문·완료에 서버 시각이 없으면 세부를 만들지 않는다', () => {
    const noEnd = sess();
    applyEvent(noEnd, ev('aas.user', { text: '질문', aas_at: 1000 }));
    tool(noEnd, 'a', 'mcp__db__query', 1002); // 완료 신호 없음
    applyEvent(noEnd, ev('message.delta', { text: '답' }));
    applyEvent(noEnd, ev('message.complete', { text: '답', aas_at: 1051 }));
    expect(parts(noEnd)).toBeUndefined();
    expect(noEnd.items.find((x) => x.kind === 'assistant')?.elapsedMs).toBe(51000);

    const screenClock = sess();
    applyEvent(screenClock, ev('aas.user', { text: '질문', aas_at: 1000 }));
    applyEvent(screenClock, ev('tool.start', { tool_id: 'a', name: 'mcp__db__query', aas_at: 1002 }));
    applyEvent(screenClock, ev('tool.complete', { tool_id: 'a' })); // 옛 서버: 화면 시계로 잰 ms
    applyEvent(screenClock, ev('message.delta', { text: '답' }));
    applyEvent(screenClock, ev('message.complete', { text: '답', aas_at: 1051 }));
    expect(parts(screenClock)).toBeUndefined();

    const oldPod = sess();
    applyEvent(oldPod, ev('aas.user', { text: '질문' })); // 질문·완료에 서버 시각 없음
    tool(oldPod, 'a', 'mcp__db__query', 1002, 1012);
    applyEvent(oldPod, ev('message.delta', { text: '답' }));
    applyEvent(oldPod, ev('message.complete', { text: '답' }));
    expect(parts(oldPod)).toBeUndefined();
  });

  const history = (S: Session, tools: string[], answer = true) => {
    S.merging = true;
    applyEvent(
      S,
      ev('aas.history', {
        messages: [
          { role: 'user', text: '질문', timestamp: 1 },
          ...tools.map((name) => ({ role: 'tool', name, timestamp: 2 })),
          ...(answer ? [{ role: 'assistant', text: '답', timestamp: 3 }] : []),
        ],
      })
    );
  };

  it('끝난 뒤 다시 연결해 기록과 합쳐도 실시간 총·세부 시간이 남는다', () => {
    const S = sess();
    applyEvent(S, ev('aas.user', { text: '질문', aas_at: 1000 }));
    tool(S, 'a', 'mcp__db__query', 1002, 1012);
    applyEvent(S, ev('message.delta', { text: '답' }));
    applyEvent(S, ev('message.complete', { text: '답', aas_at: 1051 }));
    history(S, ['mcp__db__query']);
    const it = S.items.filter((x) => x.kind === 'assistant').at(-1)!;
    expect(it.elapsedMs).toBe(51000); // 기록 저장 시각 차이(2초)가 아니다
    expect(it.elapsedParts).toEqual({ model: 41, mcp: 10, other: 0 });
    expect(S.items.find((x) => x.kind === 'tool')).toMatchObject({ at0: 1002, at1: 1012, ms: 10000 });
  });

  it('끊긴 동안 Hermes 가 시작한 차례가 있어도 실시간 시간은 그 질문의 답에만 붙는다', () => {
    const S = sess();
    applyEvent(S, ev('aas.user', { text: '질문', aas_at: 1000 }));
    applyEvent(S, ev('message.delta', { text: '답' }));
    applyEvent(S, ev('message.complete', { text: '답', aas_at: 1051 }));
    S.merging = true;
    applyEvent(
      S,
      ev('aas.history', {
        messages: [
          { role: 'user', text: '질문', timestamp: 1 },
          { role: 'assistant', text: '답', timestamp: 3 },
          { role: 'auto', reason: 'cron', timestamp: 4 },
          { role: 'assistant', text: '스스로 한 답', timestamp: 9 },
        ],
      })
    );
    const answers = S.items.filter((x) => x.kind === 'assistant');
    expect(answers.map((x) => x.text)).toEqual(['답', '스스로 한 답']);
    expect(answers[0].elapsedMs).toBe(51000);
    expect(answers[1].elapsedMs).not.toBe(51000);
  });

  it('답하는 중 다시 연결해 기록에 그 차례 도구가 없으면 세부를 만들지 않는다', () => {
    const S = sess();
    applyEvent(S, ev('aas.user', { text: '질문', aas_at: 1000 }));
    tool(S, 'a', 'mcp__db__query', 1002, 1012);
    S.busy = true;
    history(S, [], false); // Hermes 는 차례가 끝날 때 기록을 저장한다
    tool(S, 'b', 'mcp__db__chart', 1020, 1022);
    applyEvent(S, ev('message.delta', { text: '답' }));
    applyEvent(S, ev('message.complete', { text: '답', aas_at: 1051 }));
    expect(S.items.find((x) => x.kind === 'assistant')?.elapsedMs).toBe(51000);
    expect(parts(S)).toBeUndefined();
  });

  it('답하는 중 다시 연결해 기록에 같은 도구가 있으면 시각을 옮겨 세부를 만든다', () => {
    const S = sess();
    applyEvent(S, ev('aas.user', { text: '질문', aas_at: 1000 }));
    tool(S, 'a', 'mcp__db__query', 1002, 1012);
    S.busy = true;
    history(S, ['mcp__db__query'], false);
    applyEvent(S, ev('message.delta', { text: '답' }));
    applyEvent(S, ev('message.complete', { text: '답', aas_at: 1051 }));
    expect(parts(S)).toEqual({ model: 41, mcp: 10, other: 0 });
  });

  it('기록만 있는 지난 대화에는 세부가 없다', () => {
    const S = sess();
    history(S, ['mcp__db__query']);
    expect(S.items.find((x) => x.kind === 'assistant')?.elapsedMs).toBe(2000);
    expect(parts(S)).toBeUndefined();
  });

  it('글: 1초 미만은 0.N초, 1분 미만은 초, 그 위는 분·초', () => {
    expect(elapsedText(51_400)).toBe('51초');
    expect(elapsedText(65_000)).toBe('1분 5초');
    expect(elapsedText(300)).toBe('0.3초');
    expect(elapsedText(20)).toBe('0.1초');
    expect(elapsedText(0)).toBe('0초');
    setLang('en');
    expect(elapsedText(65_000)).toBe('1 min 5 s');
  });
});

describe('질문 시각(답하는 중 흐르는 시간)', () => {
  beforeEach(() => noteServerDate(new Date().toUTCString()));

  it('지난 이벤트를 따라잡을 때(새로 고침) 답하는 중인 질문은 서버 질문 시각부터 센다', () => {
    const S = sess();
    S.catchUp = 9;
    applyEvent(S, { type: 'aas.user', payload: { text: '앞', aas_at: 100 } });
    applyEvent(S, { type: 'message.complete', payload: { text: '답' } });
    expect(S.sentAt).toBeUndefined();
    applyEvent(S, { type: 'aas.user', payload: { text: '지금', aas_at: 200.5 } });
    expect(S.sentAt).toBe(200_500);
  });

  it('서버 시계가 PC 보다 3분 늦으면 그만큼 옮겨 센다(ds-cop4 실화면)', () => {
    const now = Date.now();
    noteServerDate(new Date(now - 180_000).toUTCString());
    try {
      const S = sess();
      S.catchUp = 9;
      applyEvent(S, { type: 'aas.user', payload: { text: '지금', aas_at: (now - 180_000 - 10_000) / 1000 } });
      const secs = (Date.now() - S.sentAt!) / 1000;
      expect(secs).toBeGreaterThan(8);
      expect(secs).toBeLessThan(12);
    } finally {
      noteServerDate(new Date().toUTCString());
    }
  });

  it('따라잡을 때 끝 이벤트가 빠진 앞 질문이 있으면 마지막 질문 시각으로 센다', () => {
    const S = sess();
    S.catchUp = 9;
    applyEvent(S, { type: 'aas.user', payload: { text: '앞', aas_at: 100 } });
    applyEvent(S, { type: 'aas.user', payload: { text: '지금', aas_at: 200 } });
    expect(S.sentAt).toBe(200_000);
  });

  it('따라잡기가 끝난 뒤 늦게 온 질문도 서버 시각이 있으면 그것부터 센다', () => {
    const S = sess();
    applyEvent(S, { type: 'aas.user', payload: { text: '지금', aas_at: 200 } });
    expect(S.sentAt).toBe(200_000);
  });

  it('실시간 질문에 서버 시각이 없으면 받은 때부터 센다', () => {
    const S = sess();
    const before = Date.now();
    applyEvent(S, { type: 'aas.user', payload: { text: '지금' } });
    expect(S.sentAt).toBeGreaterThanOrEqual(before);
  });

  it('따라잡을 때 서버 시각이 없는 질문(옛 서버)은 세지 않는다', () => {
    const S = sess();
    S.catchUp = 9;
    applyEvent(S, { type: 'aas.user', payload: { text: '지금' } });
    expect(S.sentAt).toBeUndefined();
  });
});
