/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 「제한 스킬·템플릿 설치 허용」 보기 카드(스펙 2026-11-18-015 §3-1·§3-2). 허용이 필요한 구역(「제한」)을 작업공간마다, 또는 「전체 허용」 한 번으로 정한다.
// 위에서 아래로: 구역 요약(전체 허용 스위치) → 도구 줄(일괄) → 작업공간별 표. 관리자에게만.
// 칸 하나는 바로 바꾸고(낙관적 갱신) 실패하면 되돌린다. 일괄·전체 허용은 확인 창 뒤라 미리 바꾸지 않고 성공하면 다시 읽는다(취향 결정 D4).
import { Alert, Box, Button, Checkbox, CircularProgress, Collapse, Menu, MenuItem, Stack, Switch, Typography } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { MouseEvent, useMemo, useState } from 'react';

import { Tag } from '@/components/bits';
import { useConfirm } from '@/components/ConfirmDialog';
import type { GridColumn } from '@/components/DataGrid';
import { DisclosureButton } from '@/components/DisclosureButton';
import type { ListTab } from '@/components/ListView';
import { t } from '@/i18n';
import { agentLabel } from '@/lib/agentLabel';
import { ApiError, get, post } from '@/lib/api';
import { fmtTs } from '@/lib/format';
import { useNameOfEmail } from '@/lib/people';

export interface GrantCell {
  by: string;
  ts: string;
}
export interface GrantZoneItem {
  name: string;
  kind: 'skill' | 'template';
  summary: string;
}
export interface GrantZone {
  slug: string;
  label: string;
  packages: number;
  /** 이 구역의 스킬·템플릿(요약 줄을 펼치면 보인다). 옛 서버는 없다 */
  items?: GrantZoneItem[];
}
export interface GrantPod {
  id: string;
  name: string;
  owner: string;
  owner_name: string;
  grants: Record<string, GrantCell>;
}
/** 표의 줄: 서버 값에 지금 화면의 칸 상태(낙관적 값·요청 중)를 붙인다. 줄 데이터가 바뀌어야 표가 그 칸을 다시 그린다 */
export interface GrantRow extends GrantPod {
  cells: Record<string, { on: boolean; busy: boolean }>;
}
export interface GrantsView {
  namespaces: GrantZone[];
  all: Record<string, GrantCell>;
  limit: number;
  pods: GrantPod[];
  error?: { code: string; detail: string };
}
interface GrantResult {
  changed: string[];
  stale: string[];
  warning?: string;
}

export const GRANTS_KEY = ['market-grants'];
/** 허용이 바뀌면 함께 다시 읽을 조회 — 목록·서랍·템플릿 카드·템플릿 상세가 allowed 를 따라온다(§3-1) */
export const GRANT_DEPENDENTS = [['market'], ['market-package'], ['market-templates'], ['market-template']];

const cellKey = (pod: string, ns: string) => `${pod}|${ns}`;

/** 서버 응답 그대로가 아니라 지금 화면의 상태: 낙관적 값(over)이 있으면 그것 */
function granted(p: GrantPod, ns: string, over: Map<string, boolean>): boolean {
  return over.get(cellKey(p.id, ns)) ?? !!p.grants[ns];
}

/** onOpenPackage: 펼친 목록의 이름을 누르면 그 패키지 서랍을 연다(id = 「ns/name」) */
export function useGrantsTab(enabled: boolean, onOpenPackage?: (id: string) => void): ListTab<GrantRow> | null {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { enqueueSnackbar } = useSnackbar();
  const nameOf = useNameOfEmail();
  const q = useQuery<GrantsView>({
    queryKey: GRANTS_KEY,
    queryFn: () => get<GrantsView>('/api/market/grants'),
    enabled,
    retry: false,
    // 창으로 돌아오면 다시 읽는다 — 다른 관리자가 바꾼 것·새 작업공간이 따라온다(전역 기본은 꺼져 있다, main.tsx)
    refetchOnWindowFocus: true,
  });
  const [over, setOver] = useState<Map<string, boolean>>(() => new Map());
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ el: HTMLElement; allow: boolean } | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  // 모양이 다른 응답(옛 서버·대역)은 없는 것으로 다룬다 — 화면 전체가 멈추지 않게
  const raw = q.data;
  const v = useMemo(() => (raw && Array.isArray(raw.pods) ? { ...raw, all: raw.all ?? {}, namespaces: raw.namespaces ?? [] } : undefined), [raw]);
  const zones = useMemo(() => v?.namespaces ?? [], [v]);
  const label = (p: GrantPod) => agentLabel(p, nameOf);
  const pods = useMemo(() => [...(v?.pods ?? [])].sort((a, b) => agentLabel(a, nameOf).localeCompare(agentLabel(b, nameOf))), [v, nameOf]);
  const rows: GrantRow[] = useMemo(
    () =>
      pods.map((p) => ({
        ...p,
        cells: Object.fromEntries(zones.map((z) => [z.slug, { on: !!v?.all[z.slug] || granted(p, z.slug, over), busy: pending.has(cellKey(p.id, z.slug)) }])),
      })),
    [pods, zones, v, over, pending]
  );

  if (!enabled) return null;

  const refreshAll = async () => {
    await Promise.all([...GRANT_DEPENDENTS, GRANTS_KEY].map((queryKey) => qc.invalidateQueries({ queryKey })));
  };
  const send = (body: { namespace: string; pods: string[] | '*'; allow: boolean }) => post<GrantResult>('/api/market/grants', body);
  const afterResult = (r: GrantResult) => {
    if (r.stale?.length) enqueueSnackbar(t('market.grants.stale'), { variant: 'warning' });
    if (r.warning === 'all_granted') enqueueSnackbar(t('market.grants.allGrantedWarn'), { variant: 'info' });
  };
  const failed = async (e: unknown) => {
    // 400 unknown_pods: 그사이 다른 관리자가 작업공간을 지워 표가 오래됐다 — 다시 읽고 알린다. 그 밖의 code 는 오류 문장 그대로(DX 1)
    if (e instanceof ApiError && e.reason === 'unknown_pods') {
      await qc.invalidateQueries({ queryKey: GRANTS_KEY });
      enqueueSnackbar(t('market.grants.listChanged'), { variant: 'warning' });
      return;
    }
    enqueueSnackbar((e as Error).message, { variant: 'error' });
  };

  const toggleCell = async (p: GrantPod, ns: string) => {
    const key = cellKey(p.id, ns);
    if (pending.has(key) || v?.all[ns]) return;
    const next = !granted(p, ns, over);
    setPending((s) => new Set(s).add(key));
    setOver((m) => new Map(m).set(key, next));
    await qc.cancelQueries({ queryKey: GRANTS_KEY });            // 창 복귀 다시 읽기가 낙관적 값을 덮지 않게
    try {
      afterResult(await send({ namespace: ns, pods: [p.id], allow: next }));
      await refreshAll();
    } catch (e) {
      await failed(e);
    } finally {
      setOver((m) => {
        const n = new Map(m);
        n.delete(key);
        return n;
      });
      setPending((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }
  };

  const setAll = async (z: GrantZone, on: boolean) => {
    if (!v || busy) return;
    const own = v.pods.filter((p) => p.grants[z.slug]);
    const names = own.slice(0, 5).map(label);
    const more = own.length > 5 ? ` ${t('market.grants.allOffMore', { n: own.length - 5 })}` : '';
    const message = on
      ? t('market.grants.allOnConfirm', { m: v.pods.length, ns: z.label })
      : t('market.grants.allOffConfirm', { n: own.length, ns: z.label }) + (names.length ? `\n${names.join(', ')}${more}` : '');
    if (!(await confirm(message, { title: t('market.grants.allSwitch'), confirmLabel: on ? t('common.confirm') : t('market.grants.bulkRevoke') }))) return;
    setBusy(true);
    try {
      const r = await send({ namespace: z.slug, pods: '*', allow: on });
      enqueueSnackbar(r.changed?.length ? t(on ? 'market.grants.allOnDone' : 'market.grants.allOffDone', { ns: z.label }) : t('market.grants.same'), { variant: 'success' });
      afterResult(r);
    } catch (e) {
      await failed(e);
    } finally {
      setBusy(false);
      await refreshAll();
    }
  };

  const bulk = async (z: GrantZone, allow: boolean) => {
    setMenu(null);
    const ids = [...selected];
    if (!ids.length || busy) return;
    const n = ids.length;
    if (!(await confirm(t(allow ? 'market.grants.bulkAllowConfirm' : 'market.grants.bulkRevokeConfirm', { n, ns: z.label }), { title: t(allow ? 'market.grants.bulkAllow' : 'market.grants.bulkRevoke') }))) return;
    setBusy(true);
    try {
      const r = await send({ namespace: z.slug, pods: ids, allow });
      const done = r.changed?.length ?? 0;
      enqueueSnackbar(done ? t(allow ? 'market.grants.bulkAllowed' : 'market.grants.bulkRevoked', { n: done, ns: z.label }) : t('market.grants.same'), { variant: 'success' });
      afterResult(r);
      setSelected(new Set());
    } catch (e) {
      await failed(e);
    } finally {
      setBusy(false);
      await refreshAll();
    }
  };
  const openBulk = (e: MouseEvent<HTMLElement>, allow: boolean) => {
    if (zones.length === 1) void bulk(zones[0], allow);
    else setMenu({ el: e.currentTarget, allow });
  };

  const total = v?.pods.length ?? 0;
  const anyAll = zones.find((z) => v?.all[z.slug]);
  const grantedPods = v ? v.pods.filter((p) => zones.some((z) => v.all[z.slug] || p.grants[z.slug])).length : 0;
  const tooMany = selected.size > (v?.limit ?? 200);

  const columns: GridColumn<GrantRow>[] = [
    { id: 'name', label: t('market.grants.col.workspace'), value: label, width: 'minmax(200px, 2fr)', hideable: false },
    ...zones.map(
      (z): GridColumn<GrantRow> => ({
        id: `ns:${z.slug}`,
        label: t('market.grants.colHeader', { ns: z.label }),   // 「'제한' 허용」 — 구역 이름만으로는 칸의 뜻을 몰랐다(2026-11-18 사용자)
        value: (p) => (p.cells[z.slug]?.on ? 1 : 0),
        width: 'minmax(160px, 1fr)',
        render: (p) => {
          const all = v?.all[z.slug];
          const own = p.grants[z.slug];
          const on = !!p.cells[z.slug]?.on;
          const busyCell = !!p.cells[z.slug]?.busy;
          // 바꿀 수 없는 칸은 disabled 대신 aria-disabled — disabled 요소에는 툴팁이 뜨지 않고 키보드로도 닿지 않는다(디자인 M9)
          const locked = !!all || busyCell;
          const shown = own && on ? own : null;
          return (
            <Stack direction="row" alignItems="center" spacing={0.5} onClick={(e) => e.stopPropagation()}>
              <Checkbox
                size="small"
                checked={on}
                onChange={() => void toggleCell(p, z.slug)}
                inputProps={{ 'aria-label': t('market.grants.cellLabel', { name: label(p), ns: z.label }), 'aria-disabled': locked || undefined }}
                sx={locked ? { opacity: 0.6, cursor: 'default' } : undefined}
              />
              {busyCell ? (
                <CircularProgress size={14} aria-hidden />
              ) : (
                <Typography variant="caption" color="text.secondary" noWrap>
                  {[all ? (own ? t('market.grants.own') : t('market.grants.byAll')) : '', shown ? `${nameOf(shown.by) ?? shown.by} · ${fmtTs(shown.ts)}` : '']
                    .filter(Boolean)
                    .join(' · ')}
                </Typography>
              )}
            </Stack>
          );
        },
      })
    ),
  ];

  const summary = (
    <Stack spacing={1} sx={{ mb: 2 }} data-grants-summary="">
      {v?.error && (
        <Alert
          severity="warning"
          action={
            <Button color="inherit" size="small" onClick={() => void q.refetch()}>
              {t('market.grants.reload')}
            </Button>
          }
        >
          {t('market.grants.hubError')}
          {v.error.code === 'hub_auth' ? ` — ${t('market.grants.hubAuth')}` : v.error.detail ? ` — ${v.error.detail}` : ''}
        </Alert>
      )}
      {zones.map((z) => {
        const all = v?.all[z.slug];
        const n = v?.pods.filter((p) => p.grants[z.slug]).length ?? 0;
        const items = z.items ?? [];
        const expanded = open.has(z.slug);
        const listId = `grant-zone-items-${z.slug}`;
        const skills = items.filter((i) => i.kind === 'skill').length;
        return (
          <Box key={z.slug} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            alignItems={{ sm: 'center' }}
            spacing={1}
            sx={{ p: 1.25 }}
          >
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="subtitle2" component="h3" sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
                {z.label}
                {items.length ? (
                  // 무엇이 이 구역에 있는지 — 숫자만으로는 무엇을 허용하는지 몰랐다(2026-11-18 사용자). 누르면 아래에 이름 목록
                  <DisclosureButton
                    open={expanded}
                    controls={listId}
                    onToggle={() =>
                      setOpen((s) => {
                        const nx = new Set(s);
                        if (nx.has(z.slug)) nx.delete(z.slug);
                        else nx.add(z.slug);
                        return nx;
                      })
                    }
                    label={t('market.grants.kindCount', { skills, templates: items.length - skills })}
                    sx={{ color: 'text.secondary', fontWeight: 400, py: 0, minWidth: 0 }}
                  />
                ) : (
                  <Typography component="span" variant="caption" color="text.secondary">
                    {t('market.grants.packages', { n: z.packages })}
                  </Typography>
                )}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {all ? t('market.grants.allOnBy', { who: nameOf(all.by) ?? all.by, at: fmtTs(all.ts) }) : t('market.grants.nowN', { n })}
              </Typography>
              {all && (
                <Typography variant="caption" color="text.secondary">
                  {t('market.grants.allLocked')}
                </Typography>
              )}
            </Box>
            <Stack direction="row" alignItems="center" spacing={0.5}>
              <Typography variant="body2" component="label" htmlFor={`grant-all-${z.slug}`}>
                {t('market.grants.allSwitch')}
              </Typography>
              <Switch id={`grant-all-${z.slug}`} checked={!!all} disabled={busy} onChange={(e) => void setAll(z, e.target.checked)} />
            </Stack>
          </Stack>
          <Collapse in={expanded} unmountOnExit>
            <Box
              component="ul"
              id={listId}
              aria-label={t('market.grants.listLabel', { ns: z.label })}
              sx={{ listStyle: 'none', m: 0, px: 1.25, pb: 1.25, pt: 0, display: 'grid', gap: 0.25 }}
            >
              {items.map((it) => (
                <Box component="li" key={it.name} sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                  <Box sx={{ width: 64, flexShrink: 0 }}>
                    <Tag>{t(it.kind === 'template' ? 'market.grants.kind.template' : 'market.grants.kind.skill')}</Tag>
                  </Box>
                  <Button
                    size="small"
                    color="inherit"
                    onClick={() => onOpenPackage?.(`${z.slug}/${it.name}`)}
                    sx={{ textTransform: 'none', fontWeight: 600, minWidth: 0, flexShrink: 0 }}
                  >
                    {it.name}
                  </Button>
                  <Typography variant="body2" color="text.secondary" noWrap sx={{ minWidth: 0 }} title={it.summary}>
                    {it.summary}
                  </Typography>
                </Box>
              ))}
            </Box>
          </Collapse>
          </Box>
        );
      })}
      {zones.length > 0 && (
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Button size="small" variant="contained" disabled={!selected.size || tooMany || busy} onClick={(e) => openBulk(e, true)}>
            {t('market.grants.bulkAllow')}
          </Button>
          <Button size="small" variant="outlined" color="inherit" disabled={!selected.size || tooMany || busy} onClick={(e) => openBulk(e, false)}>
            {t('market.grants.bulkRevoke')}
          </Button>
          {tooMany && (
            <Typography variant="caption" color="warning.main" role="status">
              {t('market.grants.bulkLimit', { n: v?.limit ?? 200 })}
            </Typography>
          )}
          {zones.length === 1 && v?.all[zones[0].slug] && selected.size > 0 && (
            <Typography variant="caption" color="text.secondary">
              {t('market.grants.allByAll')}
            </Typography>
          )}
          <Menu anchorEl={menu?.el} open={!!menu} onClose={() => setMenu(null)}>
            <MenuItem disabled sx={{ opacity: '1 !important' }}>
              <Typography variant="caption" color="text.secondary">
                {t('market.grants.pickZone')}
              </Typography>
            </MenuItem>
            {zones.map((z) => (
              <MenuItem key={z.slug} disabled={!!v?.all[z.slug]} onClick={() => menu && void bulk(z, menu.allow)}>
                {v?.all[z.slug] ? t('market.grants.zoneAllOn', { ns: z.label }) : z.label}
              </MenuItem>
            ))}
          </Menu>
        </Stack>
      )}
    </Stack>
  );

  // 구역이 하나뿐이고 전체 허용 중이면 그 열의 일괄은 막는다(§3-2) — 여럿이면 메뉴에서 그 구역만 꺼진다
  const bulkBlocked = zones.length === 1 && !!v?.all[zones[0].slug];
  return {
    id: 'grants',
    label: t('market.grants.tab'),
    items: q.isPending || !zones.length ? [] : rows,           // 구역이 없으면 표 대신 안내 문구(디자인 M4)
    count: q.isPending ? null : grantedPods,
    card: {
      sub: !v
        ? undefined
        : !zones.length
          ? t('market.grants.noZones')
          : anyAll
            ? t('market.grants.cardAll', { ns: anyAll.label })
            : t('market.grants.cardSub', { n: grantedPods, m: total }),
    },
    above: summary,
    empty: q.isPending ? t('common.loading') : q.error ? (q.error as Error).message : !zones.length ? t('market.grants.noZonesLong') : t('market.grants.noPods'),
    noMatch: t('market.grants.noMatch'),
    columns: zones.length ? columns : columns.slice(0, 1),
    rowId: (p) => p.id,
    toggles: [{ id: 'granted', label: t('market.grants.onlyGranted'), match: (p) => zones.some((z) => !!p.cells[z.slug]?.on) }],
    select: bulkBlocked ? undefined : { selectable: () => true, selected, onChange: setSelected },
    detail: () => null,
  };
}
