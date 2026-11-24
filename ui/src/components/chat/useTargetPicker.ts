/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 「MindWiki 에 저장할 곳」 고르기 창의 상태(스펙 2026-11-23-019 4-4·4-6). 화면(TargetDialog)은 그리기만 하고 불러오기·펼치기·찾기·새로 만들기는 여기서 한다.
// 목록은 팀스페이스 줄 → 한 단계씩 불러오는 하위(P2: pages?teamspace= 다음 pages?parent=). 데이터베이스는 하위가 없다(늘 has_children 거짓).
// 이유는 코드로만 들고 있고 문장은 화면이 바꾼다(chat.mwSave.reason.<코드>).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { apiFetch } from '@/lib/api';

export type TargetKind = 'page' | 'database' | 'teamspace';

export interface SaveTarget {
  teamspace: string;
  parent_id: string;
  parent_title: string;
  path: string;
  /** 없으면 page(옛 서버·옛 기억 줄) */
  kind?: TargetKind;
}

/** 최근 저장한 위치 한 줄(서버 state.recent, 새것 먼저, 스펙 2026-11-23-019 R2) */
export interface RecentTarget extends SaveTarget {
  saved_at?: string;
}

/** 저장에 성공한 위치를 최근 목록 맨 앞으로(서버와 같은 규칙: 같은 위치는 한 줄, 다섯 줄까지) */
export const RECENT_MAX = 5;
export function withRecent(list: RecentTarget[] | undefined, t: SaveTarget): RecentTarget[] {
  return [{ ...t, saved_at: new Date().toISOString() }, ...(list ?? []).filter((r) => r.parent_id !== t.parent_id)].slice(0, RECENT_MAX);
}

export interface Teamspace {
  id: string;
  name: string;
  can_create_top?: boolean;
}

export interface PageRow {
  id: string;
  title: string;
  path: string;
  kind?: 'page' | 'database';
  has_children?: boolean;
}

/** 목록·찾기·최근의 한 줄 */
export interface PickItem {
  key: string;
  id: string;
  title: string;
  kind: TargetKind;
  /** 팀스페이스 id(찾기 결과는 모른다 — 빈 값) */
  teamspace: string;
  /** 위 경로(자기 제목은 뺀다) */
  path: string;
  hasChildren: boolean;
  canCreateTop?: boolean;
}

interface Children {
  status: 'loading' | 'ok' | 'failed';
  items: PickItem[];
  more: boolean;
  reason: string;
}

export type TreeRow =
  | { type: 'item'; item: PickItem; level: number; parentKey: string; expandable: boolean; expanded: boolean; loading: boolean }
  | { type: 'empty' | 'failed' | 'more'; key: string; parentKey: string; level: number; teamspaceLevel: boolean };

export interface CreateState {
  make: 'page' | 'database';
  name: string;
  busy: boolean;
  reason: string;
  /** 결과를 모름(시간 초과·5xx·in_progress) — [다시 시도]는 같은 nonce 로 보낸다(P8) */
  unknown: boolean;
  nonce: string;
}

/** 찾기 칸 입력 뒤 기다리는 시간(4-6 상태 표). 값은 이 한 곳에만 둔다(리뷰 DX 4-7) */
export const SEARCH_DELAY_MS = 300;
/** 결과를 모르는 실패. 서버가 같은 키로 한 번 다시 보냈는데도 모르는 경우다(리뷰 Eng M4) */
const UNKNOWN = new Set(['timeout', 'mindwiki_5xx', 'in_progress']);

export class SaveFail extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export async function call<T>(method: 'GET' | 'PUT' | 'POST', url: string, body?: unknown): Promise<T> {
  const r = await apiFetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-AAS': '1' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const out = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok || out.ok === false) throw new SaveFail(String(out.reason ?? 'invalid'));
  return out as T;
}

export const reasonOf = (e: unknown) => (e instanceof SaveFail ? e.reason : 'invalid');

export const q = (o: Record<string, string>) => new URLSearchParams(Object.entries(o).filter(([, v]) => v)).toString();

/** 「만들기」를 누를 때마다 새로(P8). http 사이트에서는 randomUUID 가 없어 getRandomValues 로 */
export function newNonce(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

const join = (...p: string[]) => p.filter(Boolean).join(' › ');

/** 고른 줄 → 저장 위치. 팀스페이스 맨 위는 parent_id 에 팀스페이스 id(P8 표) */
export function toTarget(it: PickItem): SaveTarget {
  return { teamspace: it.kind === 'teamspace' ? it.id : it.teamspace, parent_id: it.id, parent_title: it.title, path: it.path, kind: it.kind };
}

/** 기억한 위치·최근 위치 → 「최근」 줄 */
export function fromTarget(t: SaveTarget): PickItem {
  return { key: `recent:${t.parent_id}`, id: t.parent_id, title: t.parent_title, kind: t.kind ?? 'page', teamspace: t.teamspace, path: t.path, hasChildren: false };
}

const tsItem = (x: Teamspace): PickItem => ({ key: `ts:${x.id}`, id: x.id, title: x.name, kind: 'teamspace', teamspace: x.id, path: '', hasChildren: true, canCreateTop: !!x.can_create_top });

function childItem(r: PageRow, parent: PickItem | null): PickItem {
  const kind = r.kind === 'database' ? 'database' : 'page';
  const above = parent ? (parent.kind === 'teamspace' ? parent.title : join(parent.path, parent.title)) : '';
  return { key: r.id, id: r.id, title: r.title, kind, teamspace: parent?.teamspace ?? '', path: r.path || above, hasChildren: kind === 'page' && !!r.has_children };
}

export function useTargetPicker(pod: string, profile: string) {
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const [teamspaces, setTeamspaces] = useState<PickItem[] | null>(null);
  const [tsReason, setTsReason] = useState('');
  const [saveLevel, setSaveLevel] = useState(0);
  const [makeDatabase, setMakeDatabase] = useState(false);
  const [children, setChildren] = useState<Record<string, Children>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PickItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchReason, setSearchReason] = useState('');
  const [selected, setSelected] = useState<PickItem | null>(null);
  const [create, setCreate] = useState<CreateState | null>(null);
  const itemsByKey = useRef(new Map<string, PickItem>());

  const load = useCallback(
    async (parent: PickItem): Promise<PickItem[]> => {
      setChildren((c) => ({ ...c, [parent.key]: { status: 'loading', items: c[parent.key]?.items ?? [], more: false, reason: '' } }));
      try {
        const by: Record<string, string> = parent.kind === 'teamspace' ? { teamspace: parent.id } : { parent: parent.id };
        const r = await call<{ pages: PageRow[]; more?: boolean }>('GET', `/api/mindwiki/save/pages?${q({ pod, profile, ...by })}`);
        const items = (r.pages ?? []).map((p) => childItem(p, parent));
        if (live.current) setChildren((c) => ({ ...c, [parent.key]: { status: 'ok', items, more: !!r.more, reason: '' } }));
        return items;
      } catch (e) {
        if (live.current) setChildren((c) => ({ ...c, [parent.key]: { status: 'failed', items: [], more: false, reason: reasonOf(e) } }));
        return [];
      }
    },
    [pod, profile]
  );

  const expand = useCallback(
    (it: PickItem) => {
      if (!it.hasChildren && !children[it.key]) return;
      setExpanded((s) => new Set(s).add(it.key));
      const c = children[it.key];
      if (!c || c.status === 'failed') void load(it);
    },
    [children, load]
  );
  const collapse = useCallback((it: PickItem) => {
    setExpanded((s) => {
      const n = new Set(s);
      n.delete(it.key);
      return n;
    });
  }, []);
  const toggle = (it: PickItem) => (expanded.has(it.key) ? collapse(it) : expand(it));
  const retry = (parentKey: string) => {
    const it = itemsByKey.current.get(parentKey);
    if (it) void load(it);
  };

  const loadTeamspaces = useCallback(() => {
    setTsReason('');
    setTeamspaces(null);
    call<{ teamspaces: Teamspace[]; save_level?: number; make_database?: boolean }>('GET', `/api/mindwiki/save/teamspaces?${q({ pod, profile })}`)
      .then((r) => {
        if (!live.current) return;
        const list = (r.teamspaces ?? []).map(tsItem);
        setSaveLevel(Number(r.save_level) || 0);
        setMakeDatabase(!!r.make_database);
        setTeamspaces(list);
        // 첫 팀스페이스는 펼친 채로 연다(4-6 배치 그림)
        if (list.length) {
          setExpanded((s) => new Set(s).add(list[0].key));
          void load(list[0]);
        }
      })
      .catch((e: unknown) => live.current && setTsReason(reasonOf(e)));
  }, [pod, profile, load]);
  useEffect(loadTeamspaces, [loadTeamspaces]);

  // 찾기: 글자가 있으면 결과가 목록 자리를 대신한다
  const term = query.trim();
  useEffect(() => {
    if (!term) {
      setResults(null);
      setSearching(false);
      setSearchReason('');
      return;
    }
    let on = true;
    setSearching(true);
    const h = setTimeout(() => {
      call<{ pages: PageRow[] }>('GET', `/api/mindwiki/save/pages?${q({ pod, profile, q: term })}`)
        .then((r) => {
          if (!on) return;
          setResults((r.pages ?? []).map((p) => ({ ...childItem(p, null), key: `q:${p.id}` })));
          setSearchReason('');
        })
        .catch((e: unknown) => on && (setResults([]), setSearchReason(reasonOf(e))))
        .finally(() => on && setSearching(false));
    }, SEARCH_DELAY_MS);
    return () => {
      on = false;
      clearTimeout(h);
    };
  }, [pod, profile, term]);

  /** 펼친 것만 줄로 편다. 상태 줄(빔·실패·더 있음)은 그 부모 바로 아래 */
  const rows = useMemo<TreeRow[]>(() => {
    const out: TreeRow[] = [];
    const map = new Map<string, PickItem>();
    if (term) {
      for (const it of results ?? []) {
        map.set(it.key, it);
        out.push({ type: 'item', item: it, level: 1, parentKey: '', expandable: false, expanded: false, loading: false });
      }
      itemsByKey.current = map;
      return out;
    }
    const walk = (it: PickItem, level: number, parentKey: string) => {
      map.set(it.key, it);
      const c = children[it.key];
      const open = expanded.has(it.key);
      out.push({ type: 'item', item: it, level, parentKey, expandable: it.hasChildren || !!c?.items.length, expanded: open, loading: open && c?.status === 'loading' });
      if (!open || !c) return;
      for (const ch of c.items) walk(ch, level + 1, it.key);
      const base = { key: `${c.status}:${it.key}`, parentKey: it.key, level: level + 1, teamspaceLevel: it.kind === 'teamspace' };
      if (c.status === 'failed') out.push({ type: 'failed', ...base });
      else if (c.status === 'ok' && !c.items.length) out.push({ type: 'empty', ...base });
      else if (c.status === 'ok' && c.more) out.push({ type: 'more', ...base, key: `more:${it.key}` });
    };
    for (const ts of teamspaces ?? []) walk(ts, 1, '');
    itemsByKey.current = map;
    return out;
  }, [term, results, teamspaces, children, expanded]);

  const startCreate = (make: 'page' | 'database') => setCreate({ make, name: '', busy: false, reason: '', unknown: false, nonce: '' });
  const setCreateName = (name: string) => setCreate((c) => (c ? { ...c, name } : c));
  const cancelCreate = () => setCreate(null);

  /** 새로 만들기. again 이 참이면 앞 요청을 같은 nonce 로 다시 보낸다(결과를 모를 때만, P8) */
  const submitCreate = async (again = false) => {
    const parent = selected;
    if (!create || !parent || parent.kind === 'database' || create.busy) return;
    const name = create.name.trim();
    if (!name) return;
    const nonce = again && create.nonce ? create.nonce : newNonce();
    setCreate({ ...create, busy: true, reason: '', unknown: false, nonce });
    try {
      const out = await call<{ id: string; kind?: string; title?: string }>('POST', '/api/mindwiki/save/create', {
        pod,
        profile,
        make: create.make,
        parent_id: parent.id,
        parent_kind: parent.kind === 'teamspace' ? 'teamspace' : 'page',
        title: name,
        nonce,
      });
      if (!live.current) return;
      const made = childItem({ id: out.id, title: out.title || name, path: '', kind: (out.kind ?? create.make) === 'database' ? 'database' : 'page', has_children: false }, parent);
      if (term) {
        // 찾기 결과를 보고 있으면 결과의 부모 바로 아래에 넣는다
        const item = { ...made, key: `q:${made.id}` };
        setResults((rs) => {
          if (!rs) return rs;
          const i = rs.findIndex((r) => r.id === parent.id);
          const next = rs.filter((r) => r.id !== made.id);
          next.splice(i < 0 ? next.length : i + 1, 0, item);
          return next;
        });
        setSelected(item);
      } else {
        // 목록이면 부모를 펼치고(아직 안 불렀으면 불러 온 뒤) 새 줄을 더한다
        const have = children[parent.key];
        const base = have?.status === 'ok' ? have.items : await load(parent);
        if (!live.current) return;
        const items = base.some((x) => x.id === made.id) ? base : [...base, made];
        setChildren((c) => ({ ...c, [parent.key]: { status: 'ok', items, more: c[parent.key]?.more ?? false, reason: '' } }));
        setExpanded((s) => new Set(s).add(parent.key));
        setSelected(items.find((x) => x.id === made.id) ?? made);
      }
      setCreate(null);
    } catch (e) {
      if (!live.current) return;
      const reason = reasonOf(e);
      const unknown = UNKNOWN.has(reason);
      setCreate((c) => (c ? { ...c, busy: false, reason, unknown, nonce } : c));
      // 만들어졌는지 모르면 목록을 다시 불러 같은 이름이 생겼는지 보이게 한다(P8)
      if (unknown && !term) {
        setExpanded((s) => new Set(s).add(parent.key));
        void load(parent);
      }
    }
  };

  const select = (it: PickItem | null) => {
    setSelected(it);
    setCreate(null);
  };

  return {
    teamspaces,
    tsReason,
    reloadTeamspaces: loadTeamspaces,
    saveLevel,
    makeDatabase,
    rows,
    expand,
    collapse,
    toggle,
    retry,
    query,
    setQuery,
    searching,
    searchReason,
    searchActive: !!term,
    selected,
    select,
    create,
    startCreate,
    setCreateName,
    cancelCreate,
    submitCreate,
  };
}

export type TargetPicker = ReturnType<typeof useTargetPicker>;
