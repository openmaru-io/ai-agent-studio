/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 마크다운 글 안의 파일 경로를 「aasfile」 요소로 바꾸는 remark 플러그인(스펙 2026-10-20-002 §3-4, 리뷰 R6·R14).
// 글(text)과 인라인 코드만 본다. 코드 블록·링크 안은 건드리지 않는다. 그리는 것은 Markdown 의 components.aasfile 이다.
import { DATA_ROOT, findPaths } from '@/lib/filePaths';

interface Node {
  type: string;
  value?: string;
  children?: Node[];
  data?: { hName?: string; hProperties?: Record<string, string> };
}

const fileNode = (path: string, text: string): Node => ({
  type: 'aasFile',
  data: { hName: 'aasfile', hProperties: { path } },
  children: [{ type: 'text', value: text }],
});

const SKIP = new Set(['link', 'linkReference', 'code', 'definition', 'html']);

export function remarkFilePaths(known?: ReadonlySet<string>) {
  const walk = (node: Node) => {
    if (!node.children || SKIP.has(node.type)) return;
    const out: Node[] = [];
    for (const child of node.children) {
      if (child.type === 'inlineCode' && child.value) {
        // 백틱 안은 백틱 전체가 경로(공백 있는 이름 포함, R6 예외 ①)
        const v = child.value.trim();
        const rel = v.replace(/^\.\//, '');
        if (v.startsWith(DATA_ROOT + 'workspace/') && !v.endsWith('/')) out.push(fileNode(v.slice(DATA_ROOT.length), v));
        else if (known?.has(`workspace/${rel}`)) out.push(fileNode(`workspace/${rel}`, v));
        else out.push(child);
        continue;
      }
      if (child.type === 'text' && child.value) {
        const hits = findPaths(child.value, known);
        if (!hits.length) {
          out.push(child);
          continue;
        }
        let at = 0;
        for (const h of hits) {
          if (h.start > at) out.push({ type: 'text', value: child.value.slice(at, h.start) });
          out.push(fileNode(h.path, child.value.slice(h.start, h.end)));
          at = h.end;
        }
        if (at < child.value.length) out.push({ type: 'text', value: child.value.slice(at) });
        continue;
      }
      walk(child);
      out.push(child);
    }
    node.children = out;
  };
  return () => (tree: Node) => walk(tree);
}
