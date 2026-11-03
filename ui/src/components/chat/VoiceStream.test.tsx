/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 스트리밍 받아쓰기(OMAI-1554, 계약 stt-stream-protocol.md, 스펙 2026-10-31-001 D19·D21~D25).
// 웹소켓·AudioWorklet 은 대역(sttDeps)으로 바꾼다. 실제 마이크·엔진은 실화면 확인 몫이다.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeMedia, installFakeMedia, uninstallFakeMedia } from '@/test/fakeMedia';
import { postedTo, stubApi } from '@/test/mountScreen';

import { Composer, ComposerProps } from './Composer';
import { pickVoice, saveVoicePref } from './readAloudPlayer';
import { resetSttDeps, wavFromPcm, wavParts } from './sttStream';
import { resetVoice, voiceRecorder, VoiceTarget } from './VoiceInput';

const VOICE: VoiceTarget = { pod: 'p1', profile: 'main', stt: true, sttStream: true, sttStreamMaxSeconds: 300 };

class FakeSocket {
  sent: (string | ArrayBuffer)[] = [];
  binaryType = '';
  closed = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    sockets.push(this);
  }
  send(d: string | ArrayBuffer) {
    this.sent.push(d);
  }
  close(code?: number) {
    this.closed = code ?? 1000;
  }
  open() {
    act(() => this.onopen?.());
  }
  msg(o: object) {
    act(() => this.onmessage?.({ data: JSON.stringify(o) }));
  }
  drop() {
    act(() => this.onclose?.({ code: 1006 }));
  }
  texts() {
    return this.sent
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d) as Record<string, unknown>);
  }
  binaries() {
    return this.sent.filter((d) => typeof d !== 'string') as ArrayBuffer[];
  }
}
let sockets: FakeSocket[] = [];
let onChunk: ((b: ArrayBuffer) => void) | null = null;
const stopCapture = vi.fn();
/** 100ms 조각 n 개(3,200바이트씩)를 소리 잡기가 보낸 것처럼 */
const pcm = (n: number, fill = 1) =>
  act(() => {
    for (let i = 0; i < n; i++) onChunk?.(new Int16Array(1600).fill(fill).buffer);
  });

function Harness(p: Partial<ComposerProps> & { initial?: string }) {
  const [v, setV] = useState(p.initial ?? '');
  return (
    <Composer
      value={v}
      onChange={setV}
      onSend={() => undefined}
      sendOn="enter"
      canSend={!!v.trim()}
      inputLabel="메시지"
      sendLabel="보내기"
      voice={VOICE}
      {...p}
    />
  );
}
const box = () => screen.getByRole('textbox', { name: '메시지' }) as HTMLTextAreaElement;
const mic = () => screen.getByRole('button', { name: '말로 입력' });
const finishBtn = () => screen.getAllByRole('button', { name: '녹음 끝내기' }).at(-1)!;
const interimLine = () => document.querySelector('[data-voice-interim]') as HTMLElement;
const sock = () => sockets.at(-1)!;

async function startStream() {
  fireEvent.click(mic());
  await screen.findByText(/0:00 \/ 5:00/);
  await waitFor(() => expect(sockets).toHaveLength(1));
  sock().open();
}
async function ready(max = 300) {
  await startStream();
  sock().msg({ type: 'ready', session: 's1', max_seconds: max });
}

let m: FakeMedia;
beforeEach(() => {
  m = installFakeMedia();
  sockets = [];
  onChunk = null;
  stopCapture.mockClear();
  resetSttDeps({
    supported: () => true,
    capture: async (_ctx, _stream, cb) => {
      onChunk = cb;
      return stopCapture;
    },
    socket: (url) => new FakeSocket(url) as unknown as WebSocket,
  });
  try {
    localStorage.clear();
  } catch {
    // 없어도 된다
  }
});
afterEach(() => {
  act(() => resetVoice());
  resetSttDeps();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  uninstallFakeMedia();
});

describe('스트리밍 연결', () => {
  it('stt_stream 이면 MediaRecorder 대신 웹소켓을 열고 start 를 보낸다. ready 전 소리는 쌓았다가 ready 뒤에 보낸다', async () => {
    render(<Harness />);
    await startStream();
    expect(m.recorders).toHaveLength(0);
    expect(sock().url).toBe(`ws://${window.location.host}/api/chat/transcribe/stream?pod=p1&profile=main`);
    expect(sock().binaryType).toBe('arraybuffer');
    expect(sock().texts()[0]).toEqual({ type: 'start', lang: 'ko', sample_rate: 16000 });
    expect(document.querySelector('.MuiCircularProgress-root')).not.toBeNull(); // 연결 중 표시
    pcm(3);
    expect(sock().binaries()).toHaveLength(0);
    sock().msg({ type: 'ready', session: 's1', max_seconds: 120 });
    expect(sock().binaries()).toHaveLength(3);
    expect(sock().binaries()[0].byteLength).toBe(3200);
    expect(await screen.findByText('0:00 / 2:00')).toBeInTheDocument(); // 최대 길이는 서버 ready 를 따른다
    expect(document.querySelector('.MuiCircularProgress-root')).toBeNull();
    pcm(1);
    expect(sock().binaries()).toHaveLength(4);
  });

  it('스트리밍을 지원하지 않는 브라우저면 지금까지의 녹음(MediaRecorder)으로 한다', async () => {
    resetSttDeps({ supported: () => false });
    render(<Harness />);
    fireEvent.click(mic());
    await screen.findByText('0:00 / 1:00');
    expect(m.recorders).toHaveLength(1);
    expect(sockets).toHaveLength(0);
  });

  it('툴팁은 스트리밍 최대 길이를 알린다', async () => {
    render(<Harness />);
    fireEvent.mouseOver(mic());
    expect(await screen.findByRole('tooltip')).toHaveTextContent('최대 5분');
  });
});

describe('중간 글과 확정 구간(D21·D19)', () => {
  it('중간 글은 띠 안 회색 줄(aria-hidden)에만 보이고 입력칸에는 들어가지 않는다', async () => {
    render(<Harness initial="메모" />);
    await ready();
    sock().msg({ type: 'interim', text: '오늘 회의', seq: 1 });
    expect(interimLine()).toHaveTextContent('오늘 회의');
    expect(interimLine()).toHaveAttribute('aria-hidden', 'true');
    expect(box()).toHaveValue('메모');
  });

  it('긴 중간 글은 뒷부분만 앞에 말줄임을 붙여 보인다', async () => {
    render(<Harness />);
    await ready();
    const long = '가나다라마바사아자차카타파하'.repeat(6);
    sock().msg({ type: 'interim', text: long, seq: 1 });
    expect(interimLine().textContent?.startsWith('…')).toBe(true);
    expect(interimLine().textContent?.endsWith(long.slice(-10))).toBe(true);
  });

  it('확정 구간만 입력칸 끝에 공백 하나와 덧붙고 중간 글 줄은 빈다', async () => {
    render(<Harness initial="메모" />);
    await ready();
    sock().msg({ type: 'interim', text: '오늘', seq: 1 });
    sock().msg({ type: 'segment', id: 0, text: '오늘 3시 회의' });
    expect(box()).toHaveValue('메모 오늘 3시 회의');
    expect(interimLine()).toHaveTextContent('');
    sock().msg({ type: 'segment', id: 1, text: '잡아 줘' });
    expect(box()).toHaveValue('메모 오늘 3시 회의 잡아 줘'); // 연달아 와도 앞 구간을 덮지 않는다
  });

  it('사용자가 입력칸을 고치는 중이면 고친 글은 그대로 두고 끝에 덧붙이며 커서도 옮기지 않는다(D19)', async () => {
    render(<Harness initial="첫째 셋째" />);
    await ready();
    sock().msg({ type: 'segment', id: 0, text: '하나' });
    const el = box();
    el.focus();
    fireEvent.change(el, { target: { value: '첫째 둘째 셋째 하나' } }); // 가운데를 고쳤다
    el.setSelectionRange(5, 5);
    sock().msg({ type: 'segment', id: 1, text: '넷' });
    expect(box()).toHaveValue('첫째 둘째 셋째 하나 넷');
    expect(box().selectionStart).toBe(5);
    expect(document.activeElement).toBe(box());
  });

  it('한글 조합 중에 온 확정 구간은 조합이 끝난 뒤 끝에 덧붙인다', async () => {
    render(<Harness initial="가" />);
    await ready();
    fireEvent.compositionStart(box());
    sock().msg({ type: 'segment', id: 0, text: '나' });
    expect(box()).toHaveValue('가');
    fireEvent.compositionEnd(box());
    await waitFor(() => expect(box()).toHaveValue('가 나'));
  });

  it('끝내기를 누르면 end 를 보내고 「마무리하는 중」, done 이면 끝난다', async () => {
    render(<Harness />);
    await ready();
    pcm(2);
    fireEvent.click(finishBtn());
    expect(sock().texts().at(-1)).toEqual({ type: 'end' });
    expect(stopCapture).toHaveBeenCalled();
    expect(m.tracks[0].stop).toHaveBeenCalled();
    expect(await screen.findByText('마무리하는 중…')).toBeInTheDocument();
    sock().msg({ type: 'segment', id: 0, text: '끝' });
    sock().msg({ type: 'final', text: '끝' });
    sock().msg({ type: 'done' });
    expect(box()).toHaveValue('끝');
    expect(voiceRecorder.snap.phase).toBe('idle');
    expect(sock().closed).toBe(1000);
  });

  it('too_long 이면 이미 넣은 구간은 두고 「녹음이 너무 깁니다」를 보인다', async () => {
    render(<Harness />);
    await ready();
    sock().msg({ type: 'segment', id: 0, text: '긴 말' });
    sock().msg({ type: 'error', code: 'too_long', message: 'x' });
    expect(box()).toHaveValue('긴 말');
    expect(await screen.findByText('녹음이 너무 깁니다. 짧게 나눠 말해 주세요')).toBeInTheDocument();
    expect(voiceRecorder.snap.phase).toBe('idle');
  });

  it('스크린리더 알림은 확정 구간에만, 이어 온 구간은 합쳐 한 번 읽는다(D24)', async () => {
    render(<Harness />);
    await ready();
    const before = voiceRecorder.snap.announce.n;
    const texts: string[] = [];
    const off = voiceRecorder.subscribe(() => {
      const a = voiceRecorder.snap.announce;
      if (a.n > before + texts.length) texts.push(a.text);
    });
    sock().msg({ type: 'interim', text: '중간', seq: 1 });
    sock().msg({ type: 'segment', id: 0, text: '하나' });
    sock().msg({ type: 'segment', id: 1, text: '둘' });
    await waitFor(() => expect(texts).toHaveLength(1), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 200));
    off();
    expect(texts).toEqual(['하나 둘']);
  });
});

describe('2차 인식(스펙 2026-11-01-001 D12~D20·D27)', () => {
  const sendBtn = () => screen.getByRole('button', { name: '보내기' });
  /** 녹음을 끝내고 final(pending) 까지 받는다 */
  async function finishWith(segments: string[], pending = 1) {
    segments.forEach((text, id) => sock().msg({ type: 'segment', id, text }));
    fireEvent.click(finishBtn());
    sock().msg({ type: 'final', text: segments.join(' '), pending });
  }

  it('final.pending 이면 「다듬는 중…」이고 보내기가 풀린다. refined 로 이번 녹음 글을 통째로 바꾸고 done 뒤 되돌리기를 보인다', async () => {
    render(<Harness initial="메모" />);
    await ready();
    await finishWith(['오전 열 시에', '봄관 삼 층']);
    expect(screen.getByText('다듬는 중…')).toBeInTheDocument();
    expect(voiceRecorder.snap.phase).toBe('refining');
    expect(sendBtn()).not.toBeDisabled(); // D14
    const before = voiceRecorder.snap.announce.n;
    sock().msg({ type: 'refined', text: ' 오전 10시에 본관 3층 ' });
    sock().msg({ type: 'done' });
    await waitFor(() => expect(box()).toHaveValue('메모 오전 10시에 본관 3층')); // 앞의 「메모」는 그대로, 앞뒤 공백은 자른다(D21)
    expect(await screen.findByText('받아쓴 글을 다듬었습니다')).toBeInTheDocument();
    expect(voiceRecorder.snap.announce.text).toBe('받아쓴 글을 다듬었습니다. 확인하고 Enter 로 보내세요'); // D18
    expect(voiceRecorder.snap.announce.n).toBe(before + 1);
    fireEvent.click(screen.getByRole('button', { name: '되돌리기' })); // D19
    expect(box()).toHaveValue('메모 오전 열 시에 봄관 삼 층');
    expect(screen.queryByText('받아쓴 글을 다듬었습니다')).toBeNull();
  });

  it('pending 이 0 이면 지금과 같다 — 다듬는 중 없이 done 으로 끝난다(D1)', async () => {
    render(<Harness />);
    await ready();
    await finishWith(['하나'], 0);
    expect(voiceRecorder.snap.phase).toBe('transcribing');
    expect(screen.queryByText('다듬는 중…')).toBeNull();
    sock().msg({ type: 'done' });
    expect(voiceRecorder.snap.phase).toBe('idle');
  });

  it('녹음 중 이번 녹음 글을 고쳤으면 바꾸지 않고 알리지도 않는다(D27·D13)', async () => {
    render(<Harness />);
    await ready();
    sock().msg({ type: 'segment', id: 0, text: '하나 둘' });
    fireEvent.change(box(), { target: { value: '하나 셋' } });
    await finishWith([]);
    sock().msg({ type: 'final', text: '하나 둘', pending: 1 });
    sock().msg({ type: 'refined', text: '하나 둘.' });
    sock().msg({ type: 'done' });
    await new Promise((r) => setTimeout(r, 50));
    expect(box()).toHaveValue('하나 셋');
    expect(screen.queryByText('받아쓴 글을 다듬었습니다')).toBeNull();
  });

  it('녹음 중 이번 녹음 글 뒤에 글을 쳤다가 다음 구간이 붙었으면 이어지지 않아 바꾸지 않는다', async () => {
    render(<Harness />);
    await ready();
    sock().msg({ type: 'segment', id: 0, text: '하나' });
    fireEvent.change(box(), { target: { value: '하나 내 글' } });
    await finishWith([]);
    sock().msg({ type: 'segment', id: 1, text: '둘' });
    sock().msg({ type: 'final', text: '하나 둘', pending: 1 });
    sock().msg({ type: 'refined', text: '하나, 둘.' });
    sock().msg({ type: 'done' });
    await new Promise((r) => setTimeout(r, 50));
    expect(box()).toHaveValue('하나 내 글 둘');
  });

  it('녹음 글 앞에 글을 쳐 자리가 밀려도 같은 글이 하나뿐이면 바꾼다. 뒤에 붙여 친 글은 별개 글이다(D17)', async () => {
    render(<Harness />);
    await ready();
    await finishWith(['오늘 회의']);
    fireEvent.change(box(), { target: { value: '참고: 오늘 회의 끝' } });
    sock().msg({ type: 'refined', text: '오늘 회의.' });
    sock().msg({ type: 'done' });
    await waitFor(() => expect(box()).toHaveValue('참고: 오늘 회의. 끝'), { timeout: 2500 }); // 방금 쳤으면 1초 들고 있다(D16)
  });

  it('한글 조합 중에 온 refined 는 조합이 끝난 뒤 바꾼다(D16)', async () => {
    render(<Harness />);
    await ready();
    await finishWith(['가나']);
    fireEvent.compositionStart(box());
    sock().msg({ type: 'refined', text: '가나다' });
    sock().msg({ type: 'done' });
    await new Promise((r) => setTimeout(r, 250));
    expect(box()).toHaveValue('가나');
    fireEvent.compositionEnd(box());
    await waitFor(() => expect(box()).toHaveValue('가나다'));
  });

  it('다듬는 중에 보내면 연결을 닫고 늦게 온 refined 는 버린다(D14)', async () => {
    render(<Harness />);
    await ready();
    await finishWith(['보낼 글']);
    const s = sock();
    fireEvent.click(sendBtn());
    expect(s.closed).toBe(1000);
    expect(voiceRecorder.snap.phase).toBe('idle');
    s.msg({ type: 'refined', text: '보낼 글.' });
    expect(box()).toHaveValue('보낼 글');
    expect(screen.queryByText('다듬는 중…')).toBeNull();
  });

  it('다듬는 중 오류·끊김이면 글은 두고 조용히 끝난다(D13)', async () => {
    const fn = stubApi({ '/api/chat/transcribe': { transcript: '일괄 글' } });
    render(<Harness />);
    await ready();
    await finishWith(['하나']);
    sock().msg({ type: 'error', code: 'engine', message: 'x' });
    expect(voiceRecorder.snap.phase).toBe('idle');
    expect(box()).toHaveValue('하나');
    expect(postedTo(fn, '/api/chat/transcribe')).toHaveLength(0); // 다시 받아쓰지 않는다(D22 아님)

    sockets = [];
    await ready();
    await finishWith(['둘']);
    sock().drop();
    expect(voiceRecorder.snap.phase).toBe('idle');
    expect(box()).toHaveValue('하나 둘');
  });
});

describe('일괄 경로 폴백', () => {
  it('ready 전에 busy 면 녹음을 이어 가고 끝낸 뒤 PCM 을 WAV 로 일괄 받아쓴다', async () => {
    const fn = stubApi({ '/api/chat/transcribe': { transcript: '일괄 글' } });
    render(<Harness initial="메모" />);
    await startStream();
    pcm(5);
    sock().msg({ type: 'error', code: 'busy', message: 'x' });
    expect(sock().closed).toBe(1000);
    expect(await screen.findByText('실시간 받아쓰기가 많아 녹음을 끝낸 뒤 받아씁니다')).toBeInTheDocument();
    pcm(5);
    fireEvent.click(finishBtn());
    await waitFor(() => expect(box()).toHaveValue('메모 일괄 글'));
    const [body] = postedTo(fn, '/api/chat/transcribe');
    expect(body).toMatchObject({ pod: 'p1', profile: 'main', mime_type: 'audio/wav', seconds: 1 });
    expect(String(body.data_url)).toMatch(/^data:audio\/wav;base64,/);
    expect(atob(String(body.data_url).split(',')[1]).length).toBe(44 + 10 * 3200); // busy 앞뒤 소리 모두
  });

  it('ready 전에 연결이 닫히거나 disabled·bad_audio 여도 일괄 경로로 넘어간다', async () => {
    for (const how of ['close', 'disabled', 'bad_audio'] as const) {
      sockets = [];
      const fn = stubApi({ '/api/chat/transcribe': { transcript: how } });
      const view = render(<Harness />);
      await startStream();
      pcm(2);
      if (how === 'close') sock().drop();
      else sock().msg({ type: 'error', code: how, message: 'x' });
      fireEvent.click(finishBtn());
      await waitFor(() => expect(box()).toHaveValue(how));
      expect(postedTo(fn, '/api/chat/transcribe')[0].mime_type).toBe('audio/wav');
      view.unmount();
      act(() => resetVoice());
    }
  });

  it('로그인이 끝났으면(unauthorized) 일괄로 넘어가지 않고 다시 로그인하라고 한다', async () => {
    const fn = stubApi({ '/api/chat/transcribe': { transcript: 'x' } });
    render(<Harness />);
    await startStream();
    sock().msg({ type: 'error', code: 'unauthorized', message: 'x' });
    expect(await screen.findByText('로그인이 끝났습니다. 다시 로그인하세요')).toBeInTheDocument();
    expect(voiceRecorder.snap.phase).toBe('idle');
    expect(postedTo(fn, '/api/chat/transcribe')).toHaveLength(0);
  });
});

describe('끊김 재전사(D22)', () => {
  it('ready 뒤 연결이 끊기면 마지막 확정 이후 PCM 만 WAV 로 다시 받아써 끝에 덧붙인다', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => {
      await gate; // 재전사가 도는 동안 띠 문구를 본다
      return new Response(JSON.stringify({ transcript: '나머지' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fn);
    render(<Harness />);
    await ready();
    pcm(4);
    sock().msg({ type: 'segment', id: 0, text: '앞부분' });
    pcm(3);
    sock().drop();
    expect(await screen.findByText('연결이 끊겨 마저 받아쓰는 중…')).toBeInTheDocument();
    expect(stopCapture).toHaveBeenCalled();
    release();
    await waitFor(() => expect(box()).toHaveValue('앞부분 나머지'));
    const [body] = postedTo(fn as unknown as ReturnType<typeof stubApi>, '/api/chat/transcribe');
    expect(atob(String(body.data_url).split(',')[1]).length).toBe(44 + 3 * 3200); // 확정 앞 4조각은 보내지 않는다
  });

  it('engine 오류도 같다. 재전사까지 실패하면 「받아쓰기 실패」와 다시 시도', async () => {
    let fail = true;
    stubApi({
      '/api/chat/transcribe': () =>
        fail ? new Response(JSON.stringify({ error: '' }), { status: 503 }) : { transcript: '다시 받은 글' },
    });
    render(<Harness />);
    await ready();
    pcm(2);
    sock().msg({ type: 'error', code: 'engine', message: 'x' });
    expect(await screen.findByText('받아쓰기 실패')).toBeInTheDocument();
    expect(screen.getByText('받아쓰지 못했습니다. 다시 시도를 눌러 주세요')).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    await waitFor(() => expect(box()).toHaveValue('다시 받은 글'));
  });

  it('확정 이후 소리가 없으면 다시 보내지 않고 끝낸다', async () => {
    const fn = stubApi({ '/api/chat/transcribe': { transcript: 'x' } });
    render(<Harness />);
    await ready();
    sock().msg({ type: 'segment', id: 0, text: '다 했다' });
    sock().drop();
    await waitFor(() => expect(voiceRecorder.snap.phase).toBe('idle'));
    expect(box()).toHaveValue('다 했다');
    expect(postedTo(fn, '/api/chat/transcribe')).toHaveLength(0);
  });
});

describe('WAV 와 조각 나누기', () => {
  it('WAV 머리는 16kHz·16비트·모노 RIFF 이고, 일괄 본문 상한에 들게 40초씩 나눈다', async () => {
    const one = new Int16Array(16000).buffer; // 1초
    const blob = wavFromPcm([one]);
    const bytes = await new Promise<ArrayBuffer>((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as ArrayBuffer);
      r.readAsArrayBuffer(blob);
    });
    const head = new DataView(bytes);
    expect(String.fromCharCode(head.getUint8(0), head.getUint8(1), head.getUint8(2), head.getUint8(3))).toBe('RIFF');
    expect(head.getUint32(24, true)).toBe(16000);
    expect(head.getUint16(34, true)).toBe(16);
    expect(head.getUint32(40, true)).toBe(32000);
    const parts = wavParts(Array.from({ length: 100 }, () => one)); // 100초
    expect(parts.map((p) => p.seconds)).toEqual([40, 40, 20]);
    expect(wavParts([])).toEqual([]);
  });
});

describe('저장된 옛 목소리(D25)', () => {
  it('저장한 목소리 id 가 목록에 없으면 조용히 첫 목소리(Sofia)를 쓴다', () => {
    saveVoicePref('ko-female-calm-a');
    const voices = [
      { id: 'sofia', name: { ko: '소피아', en: 'Sofia' } },
      { id: 'jason', name: { ko: '제이슨', en: 'Jason' } },
    ];
    expect(pickVoice(voices)).toBe('sofia');
    saveVoicePref('jason');
    expect(pickVoice(voices)).toBe('jason');
  });
});

describe('AudioWorklet 다운샘플', () => {
  it('48kHz 소리를 16kHz PCM16 1,600 표본(100ms)씩 보낸다', async () => {
    const posted: ArrayBuffer[] = [];
    let Proc: (new () => { process: (i: Float32Array[][]) => boolean }) | null = null;
    vi.stubGlobal('sampleRate', 48000);
    vi.stubGlobal(
      'AudioWorkletProcessor',
      class {
        port = { postMessage: (b: ArrayBuffer) => posted.push(b) };
      }
    );
    vi.stubGlobal('registerProcessor', (name: string, cls: typeof Proc) => {
      expect(name).toBe('aas-pcm16');
      Proc = cls;
    });
    // @ts-expect-error — 형식 선언이 없는 정적 JS 파일(AudioWorklet 전역에서 돈다)
    await import('./pcm16Worklet.js');
    const p = new Proc!();
    for (let i = 0; i < 38; i++) p.process([[new Float32Array(128).fill(0.5)]]); // 4,864 표본 = 1,621 출력 표본
    expect(posted).toHaveLength(1);
    const out = new Int16Array(posted[0]);
    expect(out.length).toBe(1600);
    expect(out[0]).toBe(Math.round(0.5 * 0x7fff));
  });
});
