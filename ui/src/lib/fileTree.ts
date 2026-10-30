/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 「파일」 서랍의 에이전트 파일 폴더 트리(스펙 2026-10-27-012 §5-2). 상태 없는 함수만 둔다 — 펼침 상태·저장소는 서랍이 가진다.
// 경로는 모두 ListingEntry.path 와 같은 `workspace/…` 꼴이다. `workspace/` 는 화면 이름(label)을 만들 때만 뗀다.
import type { ListingEntry } from './chatFiles';

export interface TreeFolder {
  kind: 'dir';
  /** 맨 안쪽 폴더 경로. 한 갈래를 합친 줄이면 합친 사슬의 끝(펼침 기억·reveal 이 이 값을 쓴다) */
  path: string;
  /** 합친 사슬의 모든 폴더 경로(바깥 → 안쪽). 합치지 않았으면 [path] */
  chain: string[];
  /** 화면 이름: 부모 기준 한 토막 또는 합친 사슬(`13`, `.hermes/plans`) */
  label: string;
  depth: number;
  files: number;
  size: number;
  mtime: number;
  children: TreeNode[];
}
export interface TreeFile {
  kind: 'file';
  entry: ListingEntry;
  depth: number;
}
export type TreeNode = TreeFolder | TreeFile;

interface Draft {
  path: string;
  name: string;
  dirs: Map<string, Draft>;
  files: ListingEntry[];
}

/** 파일 줄에서 폴더 트리를 만든다. 폴더 줄(kind 'dir')은 쓰지 않는다 — 파일이 없는 폴더는 생기지 않는다(목록이 잘려도 같다) */
export function buildTree(entries: ListingEntry[], root = 'workspace'): TreeNode[] {
  const top: Draft = { path: root, name: '', dirs: new Map(), files: [] };
  for (const e of entries) {
    if (e.kind !== 'file' || !e.path.startsWith(root + '/')) continue;
    const parts = e.path.slice(root.length + 1).split('/');
    let at = top;
    for (const part of parts.slice(0, -1)) {
      let next = at.dirs.get(part);
      if (!next) {
        next = { path: `${at.path}/${part}`, name: part, dirs: new Map(), files: [] };
        at.dirs.set(part, next);
      }
      at = next;
    }
    at.files.push(e);
  }
  return nodesOf(top, 0);
}

function nodesOf(d: Draft, depth: number): TreeNode[] {
  const folders = [...d.dirs.values()].map((sub) => folderOf(sub, depth));
  folders.sort((a, b) => b.mtime - a.mtime || a.label.localeCompare(b.label));
  const files = [...d.files].sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name)).map((entry): TreeFile => ({ kind: 'file', entry, depth }));
  return [...folders, ...files];
}

function folderOf(d: Draft, depth: number): TreeFolder {
  // 한 갈래 합치기(D4): 파일 없이 폴더 하나만 있으면 한 줄로 이어 붙인다
  const chain = [d.path];
  let label = d.name;
  let at = d;
  while (!at.files.length && at.dirs.size === 1) {
    at = [...at.dirs.values()][0];
    chain.push(at.path);
    label += '/' + at.name;
  }
  const children = nodesOf(at, depth + 1);
  let files = 0;
  let size = 0;
  let mtime = 0;
  for (const c of children) {
    const [f, s, m] = c.kind === 'dir' ? [c.files, c.size, c.mtime] : [1, c.entry.size, c.entry.mtime];
    files += f;
    size += s;
    mtime = Math.max(mtime, m);
  }
  return { kind: 'dir', path: at.path, chain, label, depth, files, size, mtime, children };
}

/** 펼친 폴더만 따라 내려가 화면에 그릴 줄 순서(포커스 이동·지우기 뒤 포커스가 쓴다) */
export function visibleRows(nodes: TreeNode[], open: ReadonlySet<string>): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (list: TreeNode[]) => {
    for (const n of list) {
      out.push(n);
      if (n.kind === 'dir' && open.has(n.path)) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** 기억한 경로 + 그 위 폴더 경로(R2·R6). 합치기가 풀려도 펼쳐 둔 폴더가 보인다 */
export function withAncestors(open: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const p of open) {
    const parts = p.split('/');
    for (let i = 2; i <= parts.length; i++) out.add(parts.slice(0, i).join('/'));
  }
  return out;
}

/** 폴더를 접는다(R3): 접은 폴더(합친 사슬 모두)와 그 아래 기억을 지운다. 그래서 위 폴더를 접으면 다음에 열 때도 접혀 있다 */
export function collapse(open: ReadonlySet<string>, f: TreeFolder): Set<string> {
  return new Set([...open].filter((p) => !f.chain.includes(p) && !p.startsWith(f.path + '/')));
}

/** 접힌 폴더 안 파일의 보이는 가장 가까운 위 폴더(5A). 파일이 보이거나 트리 밖이면 undefined */
export function visibleAncestor(path: string, nodes: TreeNode[], open: ReadonlySet<string>): string | undefined {
  for (const n of nodes) {
    if (n.kind !== 'dir' || !path.startsWith(n.path + '/')) continue;
    return open.has(n.path) ? visibleAncestor(path, n.children, open) : n.path;
  }
  return undefined;
}

/** 이 경로를 사슬에 가진 폴더(reveal, 합친 줄이어도 찾는다) */
export function findFolder(nodes: TreeNode[], path: string): TreeFolder | undefined {
  for (const n of nodes) {
    if (n.kind !== 'dir') continue;
    if (n.chain.includes(path)) return n;
    if (path.startsWith(n.path + '/')) return findFolder(n.children, path);
  }
  return undefined;
}
