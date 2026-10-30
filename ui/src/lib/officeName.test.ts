/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';

import { setLang } from '@/i18n';

import { buildMenus } from './menu';
import { chatName, chatTitle, officeName, officeTitle } from './officeName';

afterEach(() => setLang('ko'));

// 오피스 화면 제목(OMAI-1121 §3-5): 회사명은 설정한 값(/api/me company_name), 팀은 보는 사람의 Keycloak 부서
describe('오피스 이름', () => {
  it('회사명과 부서가 있으면 「<회사> > <부서> 오피스」', () => {
    expect(officeName({ company_name: 'ACME', department: '마케팅팀' })).toBe('ACME > 마케팅팀 오피스');
  });

  it('회사명이 없으면 「<부서> 오피스」, 부서가 없으면 「오피스」', () => {
    expect(officeName({ company_name: '', department: '마케팅팀' })).toBe('마케팅팀 오피스');
    expect(officeName({ company_name: 'ACME', department: '' })).toBe('오피스');
    expect(officeName({ company_name: '  ', department: '   ' })).toBe('오피스');
    expect(officeName(undefined)).toBe('오피스');
  });

  it('영어 화면', () => {
    setLang('en');
    expect(officeName({ company_name: 'ACME', department: 'Sales' })).toBe('ACME > Sales office');
    expect(officeName({ company_name: '', department: '' })).toBe('Office');
  });

  it('채팅 화면 제목도 같은 규칙이다: 「<회사> > <부서> 채팅」·「<부서> 채팅」·「채팅」', () => {
    expect(chatName({ company_name: 'ACME', department: '마케팅팀' })).toBe('ACME > 마케팅팀 채팅');
    expect(chatName({ company_name: '', department: '마케팅팀' })).toBe('마케팅팀 채팅');
    expect(chatName({ company_name: 'ACME', department: '' })).toBe('채팅');
    expect(chatName(undefined)).toBe('채팅');
    setLang('en');
    expect(chatName({ company_name: 'ACME', department: 'Sales' })).toBe('ACME > Sales chat');
    expect(chatName(null)).toBe('Chat');
  });

  it('좌측 메뉴의 채팅 항목도 「채팅」 그대로다', () => {
    expect(buildMenus({}).find((g) => g.id === 'talk')!.items.find((i) => i.id === 'chat')!.label).toBe('채팅');
  });

  it('좌측 메뉴의 오피스 항목은 「오피스」 그대로다', () => {
    expect(buildMenus({}).find((g) => g.id === 'talk')!.items.find((i) => i.id === 'office')!.label).toBe('오피스');
  });
});

// 제목을 「맥락(회사)」과 「이름」으로 나눠 화면이 다르게 꾸민다. 글자 제목(officeName·chatName)은 이 둘을 「 > 」로 이은 것과 같다
describe('제목 나누기(회사 맥락 + 이름)', () => {
  it('회사명과 부서가 있으면 회사는 맥락, 「<부서> 오피스」는 이름', () => {
    expect(officeTitle({ company_name: 'ACME', department: '마케팅팀' })).toEqual({ context: 'ACME', title: '마케팅팀 오피스' });
    expect(chatTitle({ company_name: 'ACME', department: '마케팅팀' })).toEqual({ context: 'ACME', title: '마케팅팀 채팅' });
  });
  it('회사명이 없으면 맥락 없이 이름만, 부서가 없으면 회사가 있어도 이름만(옛 규칙)', () => {
    expect(officeTitle({ company_name: '', department: '마케팅팀' })).toEqual({ title: '마케팅팀 오피스' });
    expect(officeTitle({ company_name: 'ACME', department: '' })).toEqual({ title: '오피스' });
    expect(chatTitle(undefined)).toEqual({ title: '채팅' });
  });
  it('글자 제목은 맥락과 이름을 「 > 」로 이은 것과 같다', () => {
    const me = { company_name: 'ACME', department: 'Sales' };
    setLang('en');
    const o = officeTitle(me);
    expect(officeName(me)).toBe(`${o.context} > ${o.title}`);
  });
});

