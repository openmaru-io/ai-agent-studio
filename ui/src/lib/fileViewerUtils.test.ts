/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 파일 뱃지·뷰어의 순수 함수(스펙 2026-10-20-002): 출처·종류 판정, 글 안 경로 찾기(R6·D14·R14·DD2), CSV, HTML 정리(R5).
import { describe, expect, it } from 'vitest';

import { parseCsv } from './csv';
import { fileSource, iconKind, mimeOf, sharedRoom, viewerKind } from './fileKinds';
import { findPaths, splitPaths, takeLegacyPathLines } from './filePaths';
import { prepareHtml, VIEW_CSP } from './htmlPrep';

describe('fileSource — 서버 안내 문구 기준과 같다(F10)', () => {
  it.each([
    ['workspace/uploads/2026-10-19/a.png', 'upload'],
    ['workspace/uploads/aas-shared/7/2026-10-19/x-a.pdf', 'meeting-in'],
    ['workspace/uploads/aas-shared-out/7/doc/2026-10-19/r.md', 'meeting-out'],
    ['workspace/report/summary.md', 'agent'],
  ])('%s → %s', (path, src) => expect(fileSource(path)).toBe(src));

  it('회의 공유 경로에서 방 번호를 뗀다', () => {
    expect(sharedRoom('workspace/uploads/aas-shared/12/2026-10-19/a.pdf')).toBe('12');
    expect(sharedRoom('workspace/report.md')).toBe('');
  });
});

describe('viewerKind·mimeOf·iconKind', () => {
  it.each([
    ['a.md', 'markdown'],
    ['a.PNG', 'image'],
    ['a.svg', 'svg'],
    ['a.json', 'text'],
    ['Dockerfile', 'text'],
    ['noext', 'text'],
    ['a.html', 'html'],
    ['a.tsv', 'csv'],
    ['a.pdf', 'pdf'],
    ['a.mp3', 'audio'],
    ['a.webm', 'video'],
    // 문서 뷰어 2단계(스펙 2026-10-20-005). 옛 형식(xls·ppt·doc)은 받기만(§7 D6)
    ['a.xlsx', 'xlsx'],
    ['a.pptx', 'pptx'],
    ['a.hwp', 'hwp'],
    ['a.HWPX', 'hwp'],
    ['a.xls', 'other'],
    ['a.ppt', 'other'],
  ])('%s → %s', (name, kind) => expect(viewerKind(name)).toBe(kind));

  it('받기 API 의 octet-stream 을 종류 형식으로 다시 감쌀 값(F1)', () => {
    expect(mimeOf('x.svg')).toBe('image/svg+xml');
    expect(mimeOf('x.pdf')).toBe('application/pdf');
    expect(mimeOf('x.bin')).toBe('application/octet-stream');
  });

  it('아이콘 종류', () => {
    expect(iconKind('a.xlsx')).toBe('table');
    expect(iconKind('a.zip')).toBe('archive');
    expect(iconKind('a.py')).toBe('code');
    expect(iconKind('a.docx')).toBe('doc');
  });
});

const p = (text: string, known?: Set<string>) => findPaths(text, known).map((h) => [text.slice(h.start, h.end), h.path]);

describe('findPaths — 끊는 규칙(R6·D14)', () => {
  it('공백에서 끊고 뒤에 이어지는 말은 이름에 넣지 않는다', () => {
    expect(p('/opt/data/workspace/report.md 에 저장했습니다')).toEqual([['/opt/data/workspace/report.md', 'workspace/report.md']]);
  });
  it('확장자 바로 뒤의 한글 조사와 문장 끝 부호를 뗀다', () => {
    expect(p('/opt/data/workspace/report.md에 저장했습니다')[0][1]).toBe('workspace/report.md');
    expect(p('결과는 /opt/data/workspace/a.csv를 보세요')[0][1]).toBe('workspace/a.csv');
    expect(p('파일: /opt/data/workspace/끝.png.')[0][1]).toBe('workspace/끝.png');
  });
  it('괄호·쉼표·「」 에서 끊는다', () => {
    expect(p('(/opt/data/workspace/a.md), 「/opt/data/workspace/b.md」').map((x) => x[1])).toEqual(['workspace/a.md', 'workspace/b.md']);
  });
  it('「경로: 」로 시작하는 줄은 공백 있는 이름도 줄 끝까지(캡처 사례)', () => {
    const text = '다음 파일을 열어 내용을 알려 줘.\n경로: /opt/data/workspace/uploads/2026-10-19/스크린샷 2026-10-19 10.05.32-2.png';
    expect(p(text)[0][1]).toBe('workspace/uploads/2026-10-19/스크린샷 2026-10-19 10.05.32-2.png');
  });
  it('폴더 경로·작업 폴더 밖은 잡지 않는다', () => {
    expect(p('/opt/data/workspace/ 아래 /opt/data/config.yaml')).toEqual([]);
  });
  it('상대 경로는 서랍 목록에 있을 때만(R14)', () => {
    const known = new Set(['workspace/report/summary.md']);
    expect(p('report/summary.md에 정리했고 report/none.md 는 없다', known)).toEqual([['report/summary.md', 'workspace/report/summary.md']]);
    expect(p('report/summary.md')).toEqual([]);
  });
  it('splitPaths 는 글 조각과 경로를 순서대로', () => {
    const parts = splitPaths('앞 /opt/data/workspace/a.md 뒤');
    expect(parts[0]).toBe('앞 ');
    expect(parts[2]).toBe(' 뒤');
  });
});

describe('takeLegacyPathLines — 옛 「AI」 단추 글(DD2)', () => {
  it('「경로:」 줄을 떼고 경로를 돌려준다', () => {
    const r = takeLegacyPathLines('다음 파일을 열어 내용을 알려 줘.\n경로: /opt/data/workspace/uploads/2026-10-19/스크린샷 1.png');
    expect(r).toEqual({ text: '다음 파일을 열어 내용을 알려 줘.', paths: ['workspace/uploads/2026-10-19/스크린샷 1.png'] });
  });
  it('없으면 그대로', () => expect(takeLegacyPathLines('그냥 글').paths).toEqual([]));
});

describe('parseCsv', () => {
  it('따옴표 안 쉼표·줄 바꿈·"" 를 다룬다', () => {
    expect(parseCsv('a,b\n"x,1","y\n2"\n"q""q",3').rows).toEqual([
      ['a', 'b'],
      ['x,1', 'y\n2'],
      ['q"q', '3'],
    ]);
  });
  it('TSV 와 줄 수 한도', () => {
    const r = parseCsv('a\tb\n1\t2\n3\t4\n', '\t', 2);
    expect(r.rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(r.truncated).toBe(true);
  });
});

describe('prepareHtml — 이동 요소를 지우고 CSP 를 맨 앞에(R5)', () => {
  const out = prepareHtml(
    '<html><head><meta http-equiv="refresh" content="0;url=http://evil"><base href="http://evil/"><link rel="stylesheet" href="http://x/a.css"></head>' +
      '<body onload="x()"><script>alert(1)</script><a href="http://evil">링크</a><form action="http://evil"><input></form><img src="http://x/a.png"><p>본문</p></body></html>'
  );
  it('스크립트·refresh·base·바깥 링크·폼 action·바깥 그림을 지운다', () => {
    expect(out).not.toMatch(/<script|refresh|<base|http:\/\/evil|http:\/\/x|onload/);
    expect(out).toContain('링크');
    expect(out).toContain('본문');
  });
  it('CSP meta 가 head 맨 앞', () => {
    expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('본문'));
    expect(out).toContain(VIEW_CSP);
  });
});
