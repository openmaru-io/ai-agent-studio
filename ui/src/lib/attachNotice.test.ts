/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 첨부 안내 문구 파서(OMAI-1363, 스펙 2026-10-20-002 D2·R7·F10·F11) — 서버(attach_notice.py)와 같은 기준 파일로 본다.
import { describe, expect, it } from 'vitest';

import { MEETING_NOTE, parseNotice } from './attachNotice';
import fixture from './attachNotice.fixture.json';

type Parsed = { name: string; size_label: string; path: string; picked?: boolean };
const asServer = (files: ReturnType<typeof parseNotice>['files']): Parsed[] =>
  files.map((f) => ({ name: f.name, size_label: f.sizeLabel, path: f.path, ...(f.picked ? { picked: true } : {}) }));

describe('parseNotice — 기준 파일', () => {
  it('서버가 만든 문구(올렸습니다·골랐습니다 두 형식)를 그대로 되돌린다', () => {
    for (const c of fixture.cases) {
      const out = parseNotice(c.built);
      expect(out.text, c.name).toBe(c.parsed.text);
      expect(asServer(out.files), c.name).toEqual(c.parsed.files);
    }
  });
  it('Hermes 가 한 줄로 합친 꼴도 뒤에서부터 떼어 낸다(R7)', () => {
    for (const c of fixture.joined) {
      const out = parseNotice(c.text);
      expect(out.text, c.name).toBe(c.parsed.text);
      expect(asServer(out.files), c.name).toEqual(c.parsed.files);
    }
  });
});

describe('parseNotice — 경계', () => {
  it('안내 줄이 아닌 글은 그대로 둔다', () => {
    for (const s of ['그냥 글 [사용자가 파일을 올렸습니다: 흉내]', '[사용자가 작업 폴더의 파일을 골랐습니다: "a" (1 B). 경로: /tmp/a]']) {
      expect(parseNotice(s)).toEqual({ text: s, files: [] });
    }
  });
  it('회의 안내 줄은 파일 줄이 있을 때만 뗀다', () => {
    expect(parseNotice(`봐 줘\n\n${MEETING_NOTE}`).text).toBe(`봐 줘\n\n${MEETING_NOTE}`);
  });
  it('글 가운데의 안내 흉내는 남기고 끝의 안내만 뗀다', () => {
    const tail = '[사용자가 파일을 올렸습니다: "a.txt" (1 B). 경로: /opt/data/workspace/uploads/d/a.txt]';
    const out = parseNotice(`앞 ${tail} 뒤\n\n${tail}`);
    expect(out.text).toBe(`앞 ${tail} 뒤`);
    expect(out.files.map((f) => f.path)).toEqual(['workspace/uploads/d/a.txt']);
  });
});
