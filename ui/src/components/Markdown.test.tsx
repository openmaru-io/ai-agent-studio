/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AppProviders } from './AppProviders';
import { Markdown } from './Markdown';
import hwpforgeMerged from './markdown/__fixtures__/hwpforge-merged.md?raw';
import kordocMerged from './markdown/__fixtures__/kordoc-merged.md?raw';
import ocrForm from './markdown/__fixtures__/ocr-form.md?raw';

const show = (text: string) =>
  render(
    <AppProviders>
      <Markdown text={text} />
    </AppProviders>
  );

describe('Markdown', () => {
  it('제목 1~4단계와 문단·줄바꿈', () => {
    show('# 큰\n\n#### 작은\n\n첫 줄\n둘째 줄');
    expect(screen.getByRole('heading', { level: 1, name: '큰' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 4, name: '작은' })).toBeInTheDocument();
    const p = screen.getByText(/첫 줄/).closest('p');
    expect(p).not.toBeNull();
    expect(p?.querySelector('br')).not.toBeNull();
  });

  it('굵게·기울임·코드·링크·맨 주소를 그린다', () => {
    show('**굵게** *기울임* `코드` [문서](https://a.io/x) https://b.io/y.');
    expect(screen.getByText('굵게').tagName).toBe('STRONG');
    expect(screen.getByText('기울임').tagName).toBe('EM');
    expect(screen.getByText('코드').tagName).toBe('CODE');
    const link = screen.getByRole('link', { name: '문서' });
    expect(link).toHaveAttribute('href', 'https://a.io/x');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('link', { name: 'https://b.io/y' })).toBeInTheDocument(); // 끝의 마침표는 주소가 아니다
  });

  it('스크립트 태그와 javascript: 링크는 실행되지 않고 글자로 남는다', () => {
    const { container } = show('<script>alert(1)</script> [x](javascript:alert(1)) <img src=x onerror=alert(1)>');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('순서 있는/없는 목록과 이어진 들여쓰기 줄', () => {
    show('- 가\n- 나\n  이어짐\n\n1. 하나\n2) 둘');
    const lists = screen.getAllByRole('list');
    expect(lists[0].tagName).toBe('UL');
    expect(
      within(lists[0])
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    ).toEqual(['가', '나\n이어짐']); // 한 줄 바꿈을 그대로 둔다(remark-breaks, OMAI-1115)
    expect(lists[1].tagName).toBe('OL');
  });

  it('표와 인용과 구분선', () => {
    show('| 이름 | 값 |\n| --- | ---: |\n| a | 1 |\n\n> 인용 글\n\n---');
    const table = screen.getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((c) => c.textContent)
    ).toEqual(['이름', '값']);
    expect(within(table).getByText('1')).toBeInTheDocument();
    expect(screen.getByText('인용 글').closest('blockquote')).not.toBeNull();
    expect(screen.getByRole('separator')).toBeInTheDocument();
  });

  it('코드 블록은 그대로 보이고 닫히지 않아도 그린다. 복사 버튼은 클립보드에 쓴다', async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    show('```\nline1\n  line2\n```\n\n```py\nopen = 1');
    expect(screen.getByText(/line1/).closest('pre')).not.toBeNull();
    const pres = [...document.querySelectorAll('pre')];
    expect(pres.some((p) => p.textContent?.includes('open = 1'))).toBe(true); // 코드 강조가 글자를 span 으로 나눈다
    await user.click(screen.getAllByRole('button', { name: '코드 복사' })[0]);
    expect(write).toHaveBeenCalledWith('line1\n  line2');
  });

  it('GFM: 취소선·체크박스, 물결 하나는 글자로 둔다', () => {
    show('~~지움~~ ~하나~\n\n- [x] 끝남\n- [ ] 남음');
    expect(screen.getByText('지움').tagName).toBe('DEL');
    expect(screen.getByText(/~하나~/)).toBeInTheDocument();
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.map((b) => (b as HTMLInputElement).checked)).toEqual([true, false]);
  });

  it('언어가 적힌 코드 블록은 강조하고, HTML 은 해석하지 않고 글자로 둔다', () => {
    const { container } = show('```js\nconst a = 1;\n```\n\n<b>굵게 아님</b><img src=x onerror=alert(1)>');
    expect(container.querySelector('code.language-js .hljs-keyword')?.textContent).toBe('const');
    expect(container.querySelector('b, img')).toBeNull();
    expect(screen.getByText(/<b>굵게 아님<\/b>/)).toBeInTheDocument();
  });

  it('닫히지 않은 다이어그램·차트 블록은 원본 대신 그리는 중이라고 보인다', () => {
    show('앞 글\n\n```mermaid\ngraph TD; A-->B');
    expect(screen.getByText('다이어그램을 그리는 중…')).toBeInTheDocument();
    expect(screen.queryByText(/A-->B/)).toBeNull();
  });

  it('dense 일 때만 머리 글을 서랍 머리 크기(13px)로 줄인다(스펙 2026-10-18-002 D20)', () => {
    const { unmount } = render(
      <AppProviders>
        <Markdown text={'### 목표\n끝'} dense />
      </AppProviders>
    );
    expect(getComputedStyle(screen.getByRole('heading', { name: '목표' })).fontSize).toBe('13px');
    unmount();
    show('### 목표\n끝');
    expect(getComputedStyle(screen.getByRole('heading', { name: '목표' })).fontSize).not.toBe('13px');
  });

  it('빈 글이면 아무것도 그리지 않는다', () => {
    const { container } = show('');
    expect(container.querySelector('.md')?.children.length ?? 0).toBe(0);
  });
});

describe('Markdown 안의 HTML 표(스펙 2026-10-27-005)', () => {
  const rowsOf = (t: Element) => Array.from(t.querySelectorAll(':scope > tbody > tr, :scope > thead > tr, :scope > tr'));
  const merged = (root: ParentNode) => root.querySelectorAll('td[colspan], td[rowspan], th[colspan], th[rowspan]').length;
  const mergedInSource = (src: string) => (src.match(/<t[dh]\b[^>]*\b(colspan|rowspan)=/gi) ?? []).length;

  it('OCR 결과의 병합 칸 표를 표로 그린다(colspan·rowspan·칸 안 줄바꿈)', () => {
    const { container } = show(ocrForm);
    const tables = container.querySelectorAll('table');
    expect(tables).toHaveLength(1);
    const th = tables[0].querySelector('th[colspan="9"][rowspan="3"]');
    expect(th?.textContent).toContain('성명(대표자)');
    expect(th?.querySelector('br')).not.toBeNull();
    expect(container.textContent).not.toContain('<td');
    expect(screen.getByText('정정할')).toBeInTheDocument();
  });

  it('실제 변환 결과(OCR·kordoc·hwpforge)의 표 수와 병합 칸 수가 원문과 같다(리뷰 R8)', () => {
    for (const src of [ocrForm, kordocMerged, hwpforgeMerged]) {
      const { container, unmount } = show(src);
      expect(container.querySelectorAll('table')).toHaveLength(1);
      expect(merged(container)).toBe(mergedInSource(src));
      expect(container.textContent).not.toMatch(/<\/?t[rdh]\b/);
      unmount();
    }
  });

  it('빈 줄로 나뉜 표는 표 하나로, 닫는 태그 없는 표 뒤 제목·목록은 그대로 보인다(리뷰 R1)', () => {
    const { container, unmount } = show('<table>\n<tr><td>a</td></tr>\n\n<tr><td>b</td></tr>\n</table>');
    expect(container.querySelectorAll('table')).toHaveLength(1);
    expect(rowsOf(container.querySelector('table')!)).toHaveLength(2);
    unmount();
    show('<table>\n<tr><td>a</td></tr>\n\n## 다음 제목\n\n- 항목');
    expect(screen.getByRole('heading', { name: '다음 제목' })).toBeInTheDocument();
    expect(screen.getByRole('listitem')).toHaveTextContent('항목');
  });

  it('닫히지 않은 표도 표로 그린다', () => {
    const { container } = show('<table><tr><td>a');
    expect(container.querySelector('table td')?.textContent).toBe('a');
  });

  it('표 안의 스크립트·그림·이벤트·스타일·링크는 남지 않고, 허용 밖 요소는 글만 남는다', () => {
    const { container } = show(
      '<table><tr><td onclick="alert(1)" style="color:red" class="c">a<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">링크</a><b>굵게</b><svg><text>그림글</text></svg></td></tr></table>'
    );
    const td = container.querySelector('td')!;
    expect(td.getAttributeNames()).toEqual([]);
    expect(container.querySelector('script, img, a, b, svg')).toBeNull();
    expect(td.textContent).toBe('a링크굵게');
  });

  it('colspan·rowspan 값은 정수 1~100 만 받는다', () => {
    const { container } = show('<table><tr><td colspan="99999">a</td><td colspan="x" rowspan="0">b</td><td rowspan=" 2 ">c</td></tr></table>');
    const [a, b, c] = Array.from(container.querySelectorAll('td'));
    expect(a.getAttribute('colspan')).toBe('100');
    expect(b.getAttributeNames()).toEqual([]);
    expect(c.getAttribute('rowspan')).toBe('2');
  });

  it('칸 밖 글은 원래 자리에 전체 폭 행으로, 표 뒤 글은 문단으로 보인다(리뷰 R2·R4)', () => {
    const { container } = show('<table>\n<tr><td rowspan="2">a</td><td>b</td></tr>\n<tr><td>c</td></tr>\n정정할\n<tr><td>d</td><td>e</td></tr>\n</table>\n뒤 글 <b>x</b>');
    const rows = rowsOf(container.querySelector('table')!);
    expect(rows.map((r) => r.textContent)).toEqual(['ab', 'c', '정정할', 'de']);
    expect(rows[2].querySelector('td')?.getAttribute('colspan')).toBe('2');
    expect(rows[2].getAttributeNames()).toEqual([]);
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText('뒤 글 x').tagName).toBe('P');
  });

  it('문단 안 인라인 <table> 은 글자로 남는다', () => {
    const { container } = show('글 <table><tr><td>a</td></tr></table> 뒤');
    expect(container.querySelector('table')).toBeNull();
    expect(container.textContent).toContain('<table>');
  });

  it('GFM 표·코드 블록·파일 뱃지와 함께 있어도 서로 깨지지 않는다', () => {
    const files = { render: (path: string) => <span data-testid="badge">{path}</span> };
    const { container } = render(
      <AppProviders>
        <Markdown text={'| h |\n| --- |\n| g |\n\n<table><tr><td>html</td></tr></table>\n\n```\n<table>\n```\n\n/opt/data/workspace/a.md'} files={files} />
      </AppProviders>
    );
    expect(container.querySelectorAll('table')).toHaveLength(2);
    expect(container.querySelector('pre')?.textContent).toContain('<table>');
    expect(screen.getByTestId('badge')).toHaveTextContent('workspace/a.md');
  });

  it('인용·목록 안의 표도 그리고 > 기호나 들여쓰기가 글로 나오지 않는다(외부 검토 F1·F4)', () => {
    const { container, unmount } = show('> <table>\n> <tr><td>a</td></tr>\n>\n> <tr><td>b</td></tr>\n> </table>');
    const quote = container.querySelector('blockquote')!;
    expect(rowsOf(quote.querySelector('table')!)).toHaveLength(2);
    expect(quote.textContent).not.toContain('>');
    unmount();
    const list = show('- 항목\n\n  <table>\n  <tr><td>c</td></tr>\n  </table>');
    expect(list.container.querySelector('li table td')?.textContent).toBe('c');
  });

  it('4칸 들여 쓰고 빈 줄이 있는 표도 표 하나로, 울타리 코드 블록은 코드로 둔다(리뷰 R3)', () => {
    const { container, unmount } = show('<table>\n    <tr><td>a</td></tr>\n\n    <tr><td>b</td></tr>\n</table>');
    expect(container.querySelector('pre')).toBeNull();
    expect(rowsOf(container.querySelector('table')!)).toHaveLength(2);
    unmount();
    const fenced = show('<table>\n<tr><td>a</td></tr>\n\n```\n<tr><td>코드</td></tr>\n```');
    expect(fenced.container.querySelector('pre')?.textContent).toContain('<tr><td>코드</td></tr>');
  });

  it('표 뒤 여러 줄 글은 줄바꿈을 지킨다(리뷰 R5). 주소는 글로 보인다(GFM 자동 링크는 파싱 단계라 이 글에 닿지 않음)', () => {
    const { container } = show('<table><tr><td>a</td></tr></table>\n첫 줄\nhttps://example.com 둘째 줄');
    expect(container.querySelector('p br')).not.toBeNull();
    expect(container.querySelector('p')?.textContent).toContain('https://example.com 둘째 줄');
  });

  it('칸 안 표는 8단계까지만 표로 그린다(리뷰 R7)', () => {
    const nested = '<table><tr><td>'.repeat(9) + '안쪽' + '</td></tr></table>'.repeat(9);
    const { container } = show(nested);
    expect(container.querySelectorAll('table')).toHaveLength(8);
    expect(container.textContent).toContain('안쪽');
  });
});
