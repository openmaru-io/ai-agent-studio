/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 스트리밍 중 ```mermaid·```echarts 가 열렸지만 아직 닫히지 않았으면 원본(JSON·다이어그램 글)이 그대로 보인다.
// 열린 펜스에 -pending 을 붙이고 닫아 주면 그리는 쪽이 「만드는 중」 자리표시를 보인다(CogentAI 위젯과 같은 방식).
// 일반 언어 코드 블록은 그대로 둔다 — 글이 보여도 뜻이 통한다.
export const DIAGRAM_LANGS = ['mermaid', 'echarts'] as const;

export function closePendingDiagram(text: string): string {
  const lines = text.split('\n');
  let openLang: string | null = null;
  let openAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*```(\w*)\s*$/.exec(lines[i]);
    if (!m) continue;
    if (openLang === null) {
      openLang = m[1] || '';
      openAt = i;
    } else {
      openLang = null;
      openAt = -1;
    }
  }
  if (openLang && (DIAGRAM_LANGS as readonly string[]).includes(openLang)) {
    lines[openAt] = '```' + openLang + '-pending';
    return lines.join('\n') + '\n```';
  }
  return text;
}

// 받는 중 글 끝 줄이 `<tab` 처럼 <table 의 앞부분까지만 왔으면 그 줄을 뺀다. 태그 글자가 잠깐 보였다가 표로 바뀌지 않게
// (스펙 2026-10-27-005 리뷰 R6). 받은 뒤 글이 실제로 이렇게 끝나도 빠진다(받아들인 위험).
export function hidePartialTable(text: string): string {
  const cut = text.lastIndexOf('\n');
  return cut >= 0 && /^\s*<(t(a(b(le?)?)?)?)?$/i.test(text.slice(cut + 1)) ? text.slice(0, cut) : text;
}
