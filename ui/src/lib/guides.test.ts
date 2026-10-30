/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 가이드가 화면과 어긋나지 않는지 본다(OMAI-1274 스펙 §4-7). 화면이 바뀌어 가이드가 가리키는 주소·탭·칸이 사라지면 여기서 실패한다.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { dictionaries } from '@/i18n';

import { atTarget, guideById, GUIDES, guidesForView, matchesQuery, MINE, PANE_GUIDES, resolveTarget, routeDrawerId, sameDrawer, targetHref } from './guides';
import { guideVars } from './guideText';
import { viewById, viewVisible } from './views';

const SRC = join(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return ['i18n', 'test'].includes(name) ? [] : sources(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [readFileSync(p, 'utf-8')] : [];
  });
}
const ALL = sources(SRC).join('\n');

/** 프로파일 상세의 탭 id(screens/profiles/Detail.tsx 의 panes()) */
function paneIds(): string[] {
  const text = readFileSync(join(SRC, 'screens/profiles/Detail.tsx'), 'utf-8');
  const block = text.slice(text.indexOf('const panes = ('), text.indexOf('];', text.indexOf('const panes = (')));
  return [...block.matchAll(/\['(\w+)',/g)].map((m) => m[1]);
}

/** 서버가 내려 주는 프로파일 탭 권한 키(aas/web/server.py 의 caps) */
const CAP_KEYS = ['soul', 'config', 'skills', 'tools', 'mcp', 'cron', 'env', 'channels', 'model', 'rename', 'delete'];

describe('가이드 정합성(스펙 §4-7)', () => {
  const steps = GUIDES.flatMap((g) => g.steps.map((s) => ({ g, s })));

  it('가이드 id 는 겹치지 않고 단계가 하나 이상이다', () => {
    expect(new Set(GUIDES.map((g) => g.id)).size).toBe(GUIDES.length);
    for (const g of GUIDES) expect(g.steps.length, g.id).toBeGreaterThan(0);
  });

  it('1. 모든 단계의 화면이 화면 목록에 있다', () => {
    for (const { g, s } of steps) if (s.to) expect(viewById(s.to.view), `${g.id}.${s.id}`).toBeDefined();
    for (const g of GUIDES) for (const v of g.views) expect(viewById(v), `${g.id} views ${v}`).toBeDefined();
  });

  it('2. pane 값은 프로파일 상세의 탭이다', () => {
    const panes = paneIds();
    expect(panes).toContain('soul');
    for (const { g, s } of steps) if (s.to?.params?.pane) expect(panes, `${g.id}.${s.id}`).toContain(s.to.params.pane);
  });

  it('3. 모든 강조 대상(data-guide)이 화면 코드에 있다', () => {
    // data-guide 를 단 줄에서만 찾는다(가이드 목록 자신의 문자열과 맞지 않게)
    const lines = ALL.split('\n').filter((l) => (l.includes('data-guide=') && !l.includes('data-guide="${')) || /\bguide(=|: )['"{]/.test(l));
    // 탭 줄처럼 템플릿으로 붙인 것: data-guide={`profiles.tab.${id}`} → 앞부분과 탭 id
    const prefixes = lines.flatMap((l) => [...l.matchAll(/data-guide=\{`([^`$]*)\$\{/g)].map((m) => m[1]));
    for (const { g, s } of steps) {
      if (!s.spot) continue;
      const templated = prefixes.some((p) => s.spot!.startsWith(p) && (p !== 'profiles.tab.' || paneIds().includes(s.spot!.slice(p.length))));
      const found = templated || lines.some((l) => l.includes(`"${s.spot}"`) || l.includes(`'${s.spot}'`));
      expect(found, `${g.id}.${s.id} → ${s.spot}`).toBe(true);
    }
  });

  it('3-1. 단계가 주소로 넘기는 값(agent·panel·tab·new·inbox·name·pane)은 화면 코드가 읽는다 — 읽지 않으면 화면이 열리지 않고 설명만 남는다', () => {
    const read = (k: string) => new RegExp(`(get|useOpenParam|useRouteDrawerValue)\\(\\s*'${k}'`).test(ALL) || ALL.includes(`'${k}'`);
    for (const { g, s } of steps) for (const k of Object.keys(s.to?.params ?? {})) expect(read(k), `${g.id}.${s.id} → ?${k}`).toBe(true);
    for (const k of ['new', 'inbox']) expect(new RegExp(`get\\('${k}'\\)`).test(ALL), `주소 ?${k}= 를 읽는 코드`).toBe(true);
  });

  it('3-2. 모든 가이드의 단계는 화면(to)을 열고 강조할 자리(spot)를 가진다 — 설명만 하는 단계가 없다(사용자·관리자 같은 기준)', () => {
    const bare = steps.filter(({ s }) => !s.to || !s.spot).map(({ g, s }) => `${g.id}.${s.id}`);
    expect(bare).toEqual([]);
  });

  it('4. 사용자 가이드는 일반 사용자(주인)가 볼 수 있는 화면만 가리킨다', () => {
    const user = { admin: false, owner: true };
    for (const { g, s } of steps) {
      if (g.audience !== 'user' || !s.to) continue;
      expect(viewVisible(s.to.view, user), `${g.id}.${s.id}`).toBe(true);
    }
  });

  it('5. 모든 가이드·단계의 제목과 설명이 한국어·영어 사전에 있다', () => {
    for (const lang of ['ko', 'en'] as const) {
      const d = dictionaries[lang];
      for (const g of GUIDES) {
        expect(d[`guides.${g.id}.title`], `${lang} ${g.id}.title`).toBeTruthy();
        expect(d[`guides.${g.id}.sub`], `${lang} ${g.id}.sub`).toBeTruthy();
        // 상세 화면의 「무엇에 쓰나요」·「언제 필요한가요」
        expect(d[`guides.${g.id}.what`], `${lang} ${g.id}.what`).toBeTruthy();
        expect(d[`guides.${g.id}.when`], `${lang} ${g.id}.when`).toBeTruthy();
        for (const s of g.steps) {
          expect(d[`guides.${g.id}.${s.id}.title`], `${lang} ${g.id}.${s.id}.title`).toBeTruthy();
          expect(d[`guides.${g.id}.${s.id}.body`], `${lang} ${g.id}.${s.id}.body`).toBeTruthy();
        }
      }
    }
  });

  it('5-1. 문장의 {자리}는 모두 채울 수 있는 이름이다', () => {
    const names = new Set(Object.keys(guideVars()));
    for (const lang of ['ko', 'en'] as const)
      for (const [k, v] of Object.entries(dictionaries[lang]))
        if (/^guides\.(user|admin)\./.test(k)) for (const m of v.matchAll(/\{(\w+)\}/g)) expect(names, `${lang} ${k}`).toContain(m[1]);
  });

  it('5-2. 메뉴 경로 「{g_묶음} › {v_화면}」 의 묶음은 그 화면이 실제로 놓인 묶음이다(OMAI-1313: 묶음을 바꿔도 도움말 경로가 어긋나지 않게)', () => {
    for (const lang of ['ko', 'en'] as const)
      for (const [k, v] of Object.entries(dictionaries[lang]))
        if (k.startsWith('guides.'))
          for (const m of v.matchAll(/\{g_(\w+)\} › \{v_(\w+)\}/g)) expect(viewById(m[2].replace(/_/g, '-'))?.groupId, `${lang} ${k}`).toBe(m[1]);
  });

  it('6. GuideHint 가 가리키는 가이드가 있다(프로파일 탭 줄의 표 포함)', () => {
    const ids = new Set(GUIDES.map((g) => g.id));
    for (const m of ALL.matchAll(/<GuideHint[^>]*guide="([^"]+)"/g)) expect(ids, m[1]).toContain(m[1]);
    const panes = paneIds();
    for (const [p, v] of Object.entries(PANE_GUIDES)) {
      expect(panes, p).toContain(p);
      expect(ids, v.user).toContain(v.user);
      expect(guideById(v.user)?.audience, v.user).toBe('user');
      if (v.admin) expect(guideById(v.admin)?.audience, v.admin).toBe('admin');
    }
  });

  it('7. cap 은 서버 caps 의 키이고, cap 을 쓰는 단계는 프로파일 화면을 가리킨다', () => {
    for (const { g, s } of steps) {
      if (!s.cap) continue;
      expect(CAP_KEYS, `${g.id}.${s.id}`).toContain(s.cap);
      expect(s.to?.view, `${g.id}.${s.id}`).toBe('profiles');
    }
  });

  it('「다른 곳의 프로파일 가져오기」 사용자 가이드가 PC 가져오기와 다른 에이전트 가져오기를 함께 안내한다(스펙 agent-dashboard-self-kill-recovery §3-6)', () => {
    const g = guideById('user.import-profile');
    expect(g?.audience).toBe('user');
    expect(g?.steps.map((s) => s.id)).toEqual(['pc-open', 'pc-upload', 'pc-replace', 'agent-open', 'agent-pick']);
    const ko = dictionaries.ko;
    // 단추 이름은 화면 사전 키를 끼워 넣는다(화면 문구가 바뀌면 가이드도 따라 바뀐다)
    expect(ko['guides.user.import-profile.pc-open.body']).toContain('{pcImport}');
    expect(ko['guides.user.import-profile.agent-pick.body']).toContain('{importLabel}');
    expect(guideVars().pcImport).toBe(ko['profiles.pcImport.action']);
    expect(guideVars().importLabel).toBe(ko['profiles.importLabel']);
  });

  it('요청 안내만 하는 가이드는 한 단계이고, 관리자에게 요청을 보내는 자리를 강조한다', () => {
    for (const g of GUIDES) {
      if (!g.requestOnly) continue;
      expect(g.steps, g.id).toHaveLength(1);
      expect(g.steps[0].spot, g.id).toBeTruthy();
    }
  });
});

describe('대상 주소', () => {
  const soul = { view: 'profiles', params: { name: MINE, pane: 'soul' } };

  it("'$mine' 을 내 주 에이전트로 바꾸고, 이름이 없으면 null", () => {
    expect(resolveTarget(soul, 'ma')).toEqual({ view: 'profiles', params: { name: 'ma', pane: 'soul' } });
    expect(resolveTarget(soul, null)).toBeNull();
    expect(resolveTarget({ view: 'agents' }, null)).toEqual({ view: 'agents' });
  });

  it('주소는 개요 탭을 적지 않는다', () => {
    expect(targetHref({ view: 'profiles', params: { name: 'ma', pane: 'overview' } })).toBe('/profiles?name=ma');
    expect(targetHref({ view: 'profiles', params: { name: 'ma', pane: 'soul' } })).toBe('/profiles?name=ma&pane=soul');
    expect(targetHref({ view: 'agents' })).toBe('/agents');
  });

  it('지금 주소가 대상과 같은지: 대상에 없는 검색 값은 보지 않고, pane 이 없으면 개요다', () => {
    const t = { view: 'profiles', params: { name: 'ma', pane: 'soul' } };
    expect(atTarget('/profiles', '?name=ma&pane=soul&tab=x', t)).toBe(true);
    expect(atTarget('/profiles', '?name=ma', t)).toBe(false);
    expect(atTarget('/profiles', '?name=ma', { view: 'profiles', params: { name: 'ma' } })).toBe(true);
    expect(atTarget('/profiles', '?name=ma&pane=soul', { view: 'profiles', params: { name: 'ma' } })).toBe(false);
    expect(atTarget('/agents', '', { view: 'agents' })).toBe(true);
    expect(atTarget('/', '', { view: 'dashboard' })).toBe(true);
  });

  it('같은 프로파일 서랍의 다른 탭인지', () => {
    expect(sameDrawer('/profiles', '?name=ma&pane=soul', { view: 'profiles', params: { name: 'ma' } })).toBe(true);
    expect(sameDrawer('/profiles', '?name=ops', { view: 'profiles', params: { name: 'ma' } })).toBe(false);
    expect(sameDrawer('/agents', '', { view: 'profiles', params: { name: 'ma' } })).toBe(false);
  });

  it('대상이 여는 주소 서랍: 프로파일은 route:name, 목록 서랍(open)은 route:open(스펙 2026-10-28-014 외부 검토 L3)', () => {
    expect(routeDrawerId({ view: 'profiles', params: { name: 'ma', pane: 'soul' } })).toBe('route:name');
    expect(routeDrawerId({ view: 'skills', params: { tab: 'all', open: 'ma:report' } })).toBe('route:open');
    expect(routeDrawerId({ view: 'agents' })).toBeNull();
    expect(routeDrawerId(null)).toBeNull();
  });

  it('지금 화면의 가이드는 보는 사람이 쓸 수 있는 것만', () => {
    expect(guidesForView('profiles', false).every((g) => g.audience === 'user')).toBe(true);
    expect(guidesForView('profiles', true).some((g) => g.audience === 'admin')).toBe(true);
  });

  it('검색은 대소문자와 띄어쓰기를 무시한다', () => {
    expect(matchesQuery('AI 에이전트와 첫 대화하기', '첫대화')).toBe(true);
    expect(matchesQuery('Change the MODEL', 'the model')).toBe(true);
    expect(matchesQuery('에이전트', '모델')).toBe(false);
  });
});
