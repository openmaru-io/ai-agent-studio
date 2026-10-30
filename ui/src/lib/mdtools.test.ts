/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { block, codeBlock, enter, headings, indent, lineDiff, linePrefix, link, table, wrap } from './mdtools';

const at = (value: string, start: number, end = start) => ({ value, start, end });

describe('wrap', () => {
  it('선택한 글을 감싸고 선택을 안쪽에 둔다', () => {
    expect(wrap(at('가나다', 1, 2), '**')).toEqual({ value: '가**나**다', start: 3, end: 4 });
  });
  it('선택이 없으면 자리 글을 넣고 그것을 선택한다', () => {
    expect(wrap(at('', 0), '`', '`', '코드')).toEqual({ value: '`코드`', start: 1, end: 3 });
  });
  it('이미 감싸져 있으면 다시 눌러 푼다', () => {
    expect(wrap(at('가**나**다', 3, 4), '**')).toEqual({ value: '가나다', start: 1, end: 2 });
  });
});

describe('linePrefix', () => {
  it('선택한 줄 머리에 붙이고, 다시 하면 뗀다', () => {
    const on = linePrefix(at('가\n나', 0, 3), '- ');
    expect(on.value).toBe('- 가\n- 나');
    expect(linePrefix(at(on.value, 0, on.value.length), '- ').value).toBe('가\n나');
  });
  it('다른 머리말은 바꿔 붙인다', () => {
    expect(linePrefix(at('# 제목', 0), '- ').value).toBe('- 제목');
  });
  it('번호 목록은 1. 2. 로 매긴다', () => {
    expect(linePrefix(at('가\n나', 0, 3), '', true).value).toBe('1. 가\n2. 나');
  });
  it('빈 줄은 건너뛴다', () => {
    expect(linePrefix(at('가\n\n나', 0, 4), '> ').value).toBe('> 가\n\n> 나');
  });
});

describe('block, link, table, codeBlock', () => {
  it('block 은 앞뒤에 빈 줄을 둔다', () => {
    expect(block(at('가나', 1), '---').value).toBe('가\n\n---\n\n나');
    expect(block(at('', 0), '---').value).toBe('---\n\n');
  });
  it('link 는 선택을 링크 문구로 쓰고 주소 자리를 선택한다', () => {
    expect(link(at('문서', 0, 2))).toEqual({ value: '[문서](https://)', start: 5, end: 13 });
    expect(link(at('', 0)).value).toBe('[링크 문구](https://)');
  });
  it('table 은 머리줄과 구분줄과 빈 줄을 만든다', () => {
    expect(table(at('', 0)).value).toContain('| 항목 | 내용 |\n| --- | --- |');
  });
  it('codeBlock 은 선택한 글을 울타리로 감싼다', () => {
    expect(codeBlock(at('x = 1', 0, 5)).value).toBe('```\nx = 1\n```\n\n');
    expect(codeBlock(at('', 0)).value).toContain('```\n코드\n```');
  });
});

describe('enter', () => {
  it('목록 줄에서 다음 항목을 잇는다', () => {
    expect(enter(at('- 가', 3))).toEqual({ value: '- 가\n- ', start: 6, end: 6 });
  });
  it('번호는 하나 올리고 체크는 비운다', () => {
    expect(enter(at('1. 가', 4))?.value).toBe('1. 가\n2. ');
    expect(enter(at('- [x] 일', 8))?.value).toBe('- [x] 일\n- [ ] ');
  });
  it('들여쓰기를 이어 간다', () => {
    expect(enter(at('  - 가', 5))?.value).toBe('  - 가\n  - ');
  });
  it('빈 항목에서는 목록을 끝낸다', () => {
    expect(enter(at('- 가\n- ', 7))).toEqual({ value: '- 가\n', start: 4, end: 4 });
  });
  it('목록이 아니거나 선택이 있으면 null', () => {
    expect(enter(at('그냥 글', 3))).toBeNull();
    expect(enter(at('- 가나', 3, 5))).toBeNull();
  });
});

describe('indent', () => {
  it('한 줄이면 두 칸 들여쓰고 커서를 옮긴다', () => {
    expect(indent(at('가', 1))).toEqual({ value: '  가', start: 3, end: 3 });
  });
  it('여러 줄이면 모두 들여쓰고 선택을 유지한다', () => {
    expect(indent(at('가\n나', 0, 3))).toEqual({ value: '  가\n  나', start: 0, end: 7 });
  });
  it('내어쓰기는 앞 두 칸이나 탭을 뗀다', () => {
    expect(indent(at('  가\n\t나', 0, 6), true).value).toBe('가\n나');
    expect(indent(at('가', 0), true).value).toBe('가');
  });
});

describe('headings', () => {
  it('1~4단계 제목만 모으고 코드 울타리 안은 건너뛴다', () => {
    const text = '# A\n본문\n```\n# 코드 주석\n```\n### B\n##### 다섯째';
    expect(headings(text)).toEqual([
      { level: 1, text: 'A', line: 0 },
      { level: 3, text: 'B', line: 5 },
    ]);
  });
});

describe('lineDiff', () => {
  it('같으면 same', () => {
    expect(lineDiff('a\nb', 'a\nb')).toEqual({ lines: [], added: 0, removed: 0, same: true });
  });
  it('바뀐 줄만 +/- 로 내고 앞뒤 두 줄을 맥락으로 둔다', () => {
    const a = ['1', '2', '3', '4', '5', '6', '7'].join('\n');
    const b = ['1', '2', '3', 'X', '5', '6', '7'].join('\n');
    const d = lineDiff(a, b);
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    expect(d.same).toBe(false);
    expect(d.lines).toEqual(['@@ 2번째 줄부터 @@', ' 2', ' 3', '-4', '+X', ' 5', ' 6']);
  });
  it('먼 두 변경 사이는 줄임표로 접는다', () => {
    const a = Array.from({ length: 20 }, (_, i) => String(i)).join('\n');
    const b = a.replace('\n1\n', '\nA\n').replace('\n18\n', '\nB\n');
    expect(lineDiff(a, b).lines).toContain('@@ … @@');
  });
  it('추가만, 삭제만 센다', () => {
    expect(lineDiff('a', 'a\nb')).toMatchObject({ added: 1, removed: 0 });
    expect(lineDiff('a\nb', 'a')).toMatchObject({ added: 0, removed: 1 });
  });
});
