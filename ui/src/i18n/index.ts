/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 화면 문구의 번역. 사전은 `ko/<이름>.ts`, `en/<이름>.ts` 한 쌍이 한 묶음이고 키는 `<묶음>.<뜻>` 이다.
// 새 묶음은 두 폴더에 같은 이름의 파일을 만들면 자동으로 읽힌다(등록할 곳이 없다).
// 한국어가 기준이다. 영어에 없는 키는 한국어로 나오고, i18n.test.ts 가 두 사전의 키가 같은지 검사한다.
//
// 값에 `{이름}` 을 쓰면 t('키', { 이름: 값 }) 로 채운다. 개수에 따라 문장이 달라지면 `키_one`·`키_other` 를 두고 count 를 넘긴다.
// 컴포넌트 밖(lib/*.ts)에서도 같은 t 를 쓴다. 언어를 바꾸면 화면 트리를 다시 그리므로(components/I18n.tsx) 모듈 상수에 번역한 문장을
// 얹어 두면 바뀌지 않는다. 문장은 함수가 부를 때 만든다.

export type Lang = 'ko' | 'en';
export const LANGS: Lang[] = ['ko', 'en'];
export const LANG_KEY = 'aas-lang';

type Dict = Record<string, string>;

function collect(mods: Record<string, Dict>): Dict {
  return Object.assign({}, ...Object.values(mods));
}

export const dictionaries: Record<Lang, Dict> = {
  ko: collect(import.meta.glob<Dict>('./ko/*.ts', { eager: true, import: 'default' })),
  en: collect(import.meta.glob<Dict>('./en/*.ts', { eager: true, import: 'default' })),
};

// 서버가 그리는 로그인 화면은 고른 언어를 쿠키(같은 이름)로 받는다. 콘솔에서 바꾼 언어도 로그아웃 뒤 로그인 화면에 이어지게 함께 쓴다(스펙 2026-10-14-001 §13)
const cookieLang = (): string | undefined =>
  typeof document === 'undefined' ? undefined : document.cookie.match(new RegExp(`(?:^|;\\s*)${LANG_KEY}=(ko|en)`))?.[1];

function readLang(): Lang {
  let v: string | null | undefined;
  try {
    v = localStorage.getItem(LANG_KEY);
  } catch {
    /* 저장소를 못 쓰면 쿠키를 본다 */
  }
  return (v ?? cookieLang()) === 'en' ? 'en' : 'ko';
}

let current: Lang = readLang();

export const getLang = (): Lang => current;

/** 언어를 바꾸고 이 브라우저에 기억한다(저장소를 못 쓰면 이번 방문에서만 바뀐다). */
export function setLang(lang: Lang): void {
  current = lang;
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    /* 저장소를 못 쓰면 기억하지 않는다 */
  }
  if (typeof document !== 'undefined') {
    document.cookie = `${LANG_KEY}=${lang};path=/;max-age=31536000;samesite=lax`;
    document.documentElement.lang = lang;
  }
}

if (typeof document !== 'undefined') document.documentElement.lang = current;

export type Vars = Record<string, string | number | undefined>;

function fill(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (vars[name] === undefined ? m : String(vars[name])));
}

/** 키의 문장을 현재 언어로 돌려준다. 없으면 한국어, 그것도 없으면 키를 그대로 돌려준다. */
export function t(key: string, vars?: Vars): string {
  const pick = (d: Dict): string | undefined => {
    if (vars && typeof vars.count === 'number') {
      // 한국어처럼 단수·복수 구분이 없는 언어는 `_other` 하나만 둔다
      const plural = d[`${key}_${vars.count === 1 ? 'one' : 'other'}`] ?? d[`${key}_other`];
      if (plural !== undefined) return plural;
    }
    return d[key];
  };
  return fill(pick(dictionaries[current]) ?? pick(dictionaries.ko) ?? key, vars);
}

/** 키가 사전에 있는가(서버가 보내는 코드로 문장을 찾을 때, 없는 코드는 서버가 보낸 문장을 그대로 쓰려고 확인한다) */
export const hasKey = (key: string): boolean => key in dictionaries[current] || key in dictionaries.ko;

/** 날짜·숫자 표기에 쓰는 로캘 */
export const localeOf = (lang: Lang = current): string => (lang === 'en' ? 'en-US' : 'ko-KR');
