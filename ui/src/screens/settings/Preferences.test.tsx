/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetReadAloud } from '@/components/chat/readAloudPlayer';
import { setLang } from '@/i18n';
import { setStoredTimeZone, TZ_KEY } from '@/lib/prefs';
import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { Preferences } from './Preferences';

afterEach(() => {
  vi.unstubAllGlobals();
  setStoredTimeZone('');
  setLang('ko');
  localStorage.removeItem('aas.grid.rowsPerPage');
  localStorage.removeItem('aas-theme');
  localStorage.removeItem('aas.office.ambient.track');
  localStorage.removeItem('aas.office.ambient');
  localStorage.removeItem('aas.tts.voice');
});

describe('설정 › 일반(스펙 2026-10-14-013)', () => {
  it('「테마」 제목 아래 카드는 제목 글자 자리에서 시작한다(들여 쓰기)', async () => {
    stubApi({});
    mountScreen(<Preferences />, '/preferences');
    const head = await screen.findByRole('heading', { level: 3, name: '테마' });
    const body = head.closest('section')!.querySelector('.aas-section-body') as HTMLElement;
    expect(getComputedStyle(body).paddingLeft).toBe('22px');
  });

  it('언어·테이블의 행 수·날짜 표시용 시간대 행과 테마 카드를 보이고, 이 브라우저에만 저장된다고 알린다', async () => {
    stubApi({});
    mountScreen(<Preferences />, '/preferences');
    for (const name of ['언어', '테이블의 행 수', '날짜 표시용 시간대']) expect(await screen.findByText(name, { selector: 'td' })).toBeInTheDocument();
    expect(screen.getByText(/이 브라우저에만 저장됩니다/)).toBeInTheDocument();
    expect(within(screen.getByRole('radiogroup', { name: '테마' })).getAllByRole('radio')).toHaveLength(2);
  });

  it('행 수를 고르면 표가 쓰는 값(aas.grid.rowsPerPage)에 저장한다', async () => {
    const user = userEvent.setup();
    stubApi({});
    mountScreen(<Preferences />, '/preferences');
    await user.click(await screen.findByRole('combobox', { name: '테이블의 행 수' }));
    await user.click(screen.getByRole('option', { name: '50' }));
    expect(localStorage.getItem('aas.grid.rowsPerPage')).toBe('50');
  });

  it('시간대를 고르면 aas-tz 에 저장하고 지금 시각 안내가 그 시간대로 바뀐다', async () => {
    const user = userEvent.setup();
    stubApi({});
    mountScreen(<Preferences />, '/preferences');
    const box = await screen.findByRole('combobox', { name: '날짜 표시용 시간대' });
    await user.clear(box);
    await user.type(box, 'Asia/Seoul');
    await user.click(await screen.findByRole('option', { name: /^\(UTC\+9\) Asia\/Seoul$/ }));
    expect(localStorage.getItem(TZ_KEY)).toBe('Asia/Seoul');
    expect(screen.getByText(/^지금 시각: \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)).toBeInTheDocument();
  });

  it('테마 카드를 누르면 그 테마로 바뀌고 기억한다', async () => {
    const user = userEvent.setup();
    stubApi({});
    mountScreen(<Preferences />, '/preferences');
    const light = await screen.findByTestId('theme-light');
    await user.click(light);
    expect(light).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('theme-dark')).toHaveAttribute('aria-checked', 'false');
    expect(localStorage.getItem('aas-theme')).toBe('light');
  });

  it('오피스 배경음악 줄에서 곡을 고르면 곡만 저장하고 배경음을 켜지 않는다(스펙 2026-10-21-014 D5)', async () => {
    const user = userEvent.setup();
    stubApi({});
    mountScreen(<Preferences />, '/preferences');
    const box = await screen.findByRole('combobox', { name: '오피스 배경음악' });
    expect(box).toHaveTextContent('Menu Music');
    expect(screen.getByText(/오피스 하단의 ♫ 버튼으로도 바꿀 수 있습니다/)).toBeInTheDocument();
    await user.click(box);
    // 선택지는 곡 다섯 개뿐이고(묶음 제목이 선택지가 되지 않는다) 분위기는 둘째 줄에 붙는다
    expect(screen.getAllByRole('option')).toHaveLength(5);
    expect(screen.getByRole('option', { name: /Goldberg/ })).toHaveTextContent('클래식 · J. S. Bach, Kimiko Ishizaka · CC0');
    await user.click(screen.getByRole('option', { name: /Forest Ambience/ }));
    expect(localStorage.getItem('aas.office.ambient.track')).toBe('forest-ambience');
    expect(localStorage.getItem('aas.office.ambient')).toBeNull();
    expect(box).toHaveTextContent('Forest Ambience');
  });
});

describe('설정 › 내 화면 「읽어 주기 목소리」(스펙 2026-10-28-012 DD19)', () => {
  const VOICES = {
    tts: true,
    voices: [
      { id: 'ko-female-calm-a', name: { ko: '차분한 여성', en: 'Calm female' }, gender: 'female' },
      { id: 'ko-male-calm-b', name: { ko: '차분한 남성', en: 'Calm male' }, gender: 'male' },
    ],
  };

  it('tts:true 면 배경음악 다음 줄에 고르기를 두고, 고르지 않았으면 첫 목소리. 고른 값은 이 브라우저에 저장한다', async () => {
    const user = userEvent.setup();
    stubApi({ '/api/tts/voices': VOICES });
    mountScreen(<Preferences />, '/preferences');
    const box = await screen.findByRole('combobox', { name: '읽어 주기 목소리' });
    expect(box).toHaveTextContent('차분한 여성 · 여성');
    const names = screen.getAllByRole('cell').map((c) => c.textContent);
    expect(names.indexOf('읽어 주기 목소리')).toBeGreaterThan(names.indexOf('오피스 배경음악'));
    expect(screen.getByText('답 아래 [읽어 주기]에 쓰입니다')).toBeInTheDocument();
    await user.click(box);
    await user.click(screen.getByRole('option', { name: '차분한 남성 · 남성' }));
    expect(localStorage.getItem('aas.tts.voice')).toBe('ko-male-calm-b');
  });

  it('tts:false 이거나 목록 읽기가 실패하면 줄을 그리지 않는다', async () => {
    stubApi({ '/api/tts/voices': { tts: false, voices: [] } });
    const a = mountScreen(<Preferences />, '/preferences');
    await screen.findByText('언어', { selector: 'td' });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('읽어 주기 목소리')).toBeNull();
    a.unmount();
    stubApi({ '/api/tts/voices': new Response('{}', { status: 500 }) });
    mountScreen(<Preferences />, '/preferences');
    await screen.findByText('언어', { selector: 'td' });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('읽어 주기 목소리')).toBeNull();
  });

  it('[미리 듣기]는 고른 목소리로 /api/tts/preview 를 부른다', async () => {
    const user = userEvent.setup();
    // 시험 환경(jsdom)에는 소리 재생이 없다 — 가짜 <audio>
    resetReadAloud({ makeAudio: () => ({ src: '', onended: null, onerror: null, play: () => Promise.resolve(), pause: () => undefined }), createUrl: () => 'blob:x', revokeUrl: () => undefined });
    localStorage.setItem('aas.tts.voice', 'ko-male-calm-b');
    const fn = stubApi({ '/api/tts/voices': VOICES, '/api/tts/preview': () => new Response(new Blob(['x']), { status: 200 }) });
    mountScreen(<Preferences />, '/preferences');
    await user.click(await screen.findByRole('button', { name: '미리 듣기' }));
    expect(postedTo(fn, '/api/tts/preview')).toEqual([{ voice: 'ko-male-calm-b' }]);
  });
});
