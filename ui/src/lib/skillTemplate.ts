/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 「새 스킬」 본문을 보내기 전에 정리한다(2026-10-28-004).
// 틀(skills.bodyTemplate)의 안내 주석과 글자 그대로 같은 주석, 내용이 없는 절(제목 아래가 `-`·`1.` 뿐)을 지운다.
// 안내 문구가 스킬에 남으면 skill_view 가 매번 대화에 싣고, 스킬 연결도가 예시 도구 이름을 연결로 읽는다.
// 사용자가 쓰거나 고친 주석은 남긴다.

const COMMENT = /<!--[\s\S]*?-->/g;
const BLANK_ITEM = /^\s*(?:[-*]|\d+\.)?\s*$/;

export function cleanSkillBody(body: string, template: string): { body: string; empty: boolean } {
  const guides = template.match(COMMENT) ?? [];
  const lines: string[] = [];
  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    const cut = guides.reduce((s, g) => s.split(g).join(''), line);
    if (cut !== line && !cut.trim()) continue; // 안내 주석만 있던 줄
    lines.push(cut);
  }
  // `## ` 절마다 묶어, 제목 말고 빈 목록 표시뿐이면 절째 지운다
  const out: string[] = [];
  let section: string[] | null = null;
  const flush = () => {
    if (section && !section.slice(1).every((l) => BLANK_ITEM.test(l))) out.push(...section);
    section = null;
  };
  for (const line of lines) {
    if (/^#{1,2}\s/.test(line)) {
      flush();
      if (line.startsWith('## ')) {
        section = [line];
        continue;
      }
    }
    if (section) section.push(line);
    else out.push(line);
  }
  flush();
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  const rest = text.replace(/^# .*\n?/, '').trim();
  return { body: text, empty: !rest };
}
