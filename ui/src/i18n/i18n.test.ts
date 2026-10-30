/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';

import { dictionaries, getLang, setLang, t } from '@/i18n';

const HANGUL = /[가-힣]/;
/** 영어 사전 값에 한글이 있어도 되는 키(언어 이름을 그 언어로 적는 것처럼 번역하면 뜻이 사라지는 것) */
const HANGUL_ALLOWED_IN_EN = new Set(['lang.ko']);

afterEach(() => setLang('ko'));

describe('t', () => {
  it('기본 언어는 한국어이고 setLang 으로 바꾸면 영어가 나온다', () => {
    expect(getLang()).toBe('ko');
    const key = Object.keys(dictionaries.en).find((k) => !/\{|_one$|_other$/.test(k))!;
    expect(t(key)).toBe(dictionaries.ko[key]);
    setLang('en');
    expect(getLang()).toBe('en');
    expect(t(key)).toBe(dictionaries.en[key]);
    expect(localStorage.getItem('aas-lang')).toBe('en');
  });

  it('없는 키는 키를 그대로 돌려주고 영어에 없는 키는 한국어로 나온다', () => {
    expect(t('없는.키')).toBe('없는.키');
  });

  it('{이름} 을 채우고, 값이 없으면 자리표시를 그대로 둔다', () => {
    dictionaries.ko['test.fill'] = '{n}개 중 {m}개';
    try {
      expect(t('test.fill', { n: 3, m: 1 })).toBe('3개 중 1개');
      expect(t('test.fill', { n: 3 })).toBe('3개 중 {m}개');
    } finally {
      delete dictionaries.ko['test.fill'];
    }
  });

  it('count 를 넘기면 키_one·키_other 를 고른다', () => {
    dictionaries.en['test.jobs_one'] = '{count} job';
    dictionaries.en['test.jobs_other'] = '{count} jobs';
    dictionaries.ko['test.jobs_other'] = '작업 {count}개';
    try {
      setLang('en');
      expect(t('test.jobs', { count: 1 })).toBe('1 job');
      expect(t('test.jobs', { count: 2 })).toBe('2 jobs');
      setLang('ko');
      expect(t('test.jobs', { count: 1 })).toBe('작업 1개');
    } finally {
      delete dictionaries.en['test.jobs_one'];
      delete dictionaries.en['test.jobs_other'];
      delete dictionaries.ko['test.jobs_other'];
    }
  });

  it('html lang 속성이 따라 바뀐다', () => {
    setLang('en');
    expect(document.documentElement.lang).toBe('en');
    setLang('ko');
    expect(document.documentElement.lang).toBe('ko');
  });

  it('고른 언어를 쿠키 aas-lang 에도 써서 서버가 그리는 로그인 화면이 따른다', () => {
    setLang('en');
    expect(document.cookie).toContain('aas-lang=en');
    setLang('ko');
    expect(document.cookie).toContain('aas-lang=ko');
  });
});

describe('사전', () => {
  const ko = dictionaries.ko;
  const en = dictionaries.en;
  const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it('한국어와 영어의 키가 같다(한국어는 단수형 `_one` 을 생략해도 된다)', () => {
    const koKeys = Object.keys(ko).sort();
    const enKeys = Object.keys(en).sort();
    expect(koKeys.filter((k) => !(k in en))).toEqual([]);
    // 영어의 `키_one` 은 한국어에 `키_other` 가 있으면 없어도 된다
    const oneOnlyInEn = (k: string) => k.endsWith('_one') && `${k.slice(0, -4)}_other` in ko;
    expect(enKeys.filter((k) => !(k in ko) && !oneOnlyInEn(k))).toEqual([]);
  });

  it('값이 비어 있지 않다', () => {
    expect(Object.entries(ko).filter(([, v]) => !v.trim()).map(([k]) => k)).toEqual([]);
    expect(Object.entries(en).filter(([, v]) => !v.trim()).map(([k]) => k)).toEqual([]);
  });

  it('두 언어의 {자리표시} 가 같다', () => {
    const bad = Object.keys(ko).filter((k) => k in en && holes(ko[k]).join() !== holes(en[k]).join());
    expect(bad).toEqual([]);
  });

  it('영어 값에는 한글이 없다(언어 이름 등 허용한 키만 예외)', () => {
    const bad = Object.entries(en)
      .filter(([k, v]) => HANGUL.test(v) && !HANGUL_ALLOWED_IN_EN.has(k))
      .map(([k]) => k);
    expect(bad).toEqual([]);
  });

  it('한국어 값에는 한글이 하나는 있다(영어를 한국어 칸에 잘못 넣지 않았다)', () => {
    const allowed = new Set(['brand.name', 'flows.mark.cron', 'common.agentProfile']); // 기호로 적는 표시(⏱, 에이전트 › 프로파일)
    const bad = Object.entries(ko)
      .filter(([k, v]) => !HANGUL.test(v) && !allowed.has(k) && !/^[\s\d{}\w.,:;()/%·+\-–—|'"!?&#@~*=<>[\]↗→←]*$/.test(v))
      .map(([k]) => k);
    expect(bad).toEqual([]);
  });
});
