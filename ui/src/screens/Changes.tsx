/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 변경 기록: AAS 에서 누가 언제 무엇을 바꿨는지. 값은 기록하지 않고 이름과 대상만 남는다.
// 관리자는 전체 기록을, 에이전트 주인은 지금 POD 의 자기 기간 기록만 본다(OMAI-1126 디자인 결정 1A, 재검토 L6).
import BadgeOutlinedIcon from '@mui/icons-material/BadgeOutlined';
import { Box, Button, Menu, Tooltip, useTheme } from '@mui/material';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';

import { AgentChip } from '@/components/AgentChip';
import { agentMenuItems } from '@/components/AgentSwitch';
import { KV, PeriodSelect, ScreenLoading, Tag } from '@/components/bits';
import { GridColumn, nameColumn, Pill } from '@/components/DataGrid';
import { ListTab, ListView, Tone } from '@/components/ListView';
import { menuItemSx } from '@/components/menuItemSx';
import { SubtleBadge } from '@/components/SubtleBadge';
import { ActorChip, UserChip } from '@/components/UserChip';
import { t } from '@/i18n';
import { agentLabel, viewerAgentLabel } from '@/lib/agentLabel';
import { get } from '@/lib/api';
import { changeGroupLabel, changeWhat, isAccess } from '@/lib/changeLabels';
import { chatTokens } from '@/lib/chatTokens';
import { Me, useMe } from '@/lib/data';
import { changeEditTarget, useEditColumn } from '@/lib/editLink';
import { fmtTs } from '@/lib/format';
import { reloadAtView, switchPod } from '@/lib/pod';
import { useDays } from '@/lib/useDays';

interface ChangeRow {
  ts: string;
  group: string;
  kind: string;
  failed: boolean;
  who?: string;
  /** who 가 이메일일 때 사람 이름(서버가 준다, 2026-10-18-010). 없으면 이메일을 보인다 */
  who_name?: string;
  what: string;
  detail?: string;
  /** 주인 화면에서 관리자가 바꾼 줄. 서버가 이메일을 지우고 보낸다(D15 부터 관리자가 한 줄만) */
  by_admin?: boolean;
  /** 팀 관리자 자격으로 한 줄(스펙 2026-10-22-001 DD10). who 는 가리지 않고 사람 칩 옆에 「팀 관리자」 배지를 단다 */
  by_team_manager?: boolean;
  /** 주인·팀 관리자·관리자가 아닌 사람(접근 권한만 받은 사람·TFT 방 구성원 등)이 한 줄(D15). 이름은 보이고 「다른 사람」 배지를 단다 */
  by_other?: boolean;
  /** 「일 시키기」를 같은 사람·대상·날짜로 묶은 건수. 시각은 마지막으로 보낸 시각(DD7) */
  count?: number;
  /** 마켓 설치·지우기 요청의 지금 상태(queued·running·done·failed, 디자인 결정 4A) */
  request_status?: string;
  /** 어느 에이전트(POD)의 일인가. owner 는 그 주인의 표시 이름(주인이 없으면 POD 이름) — 관리자 응답에만 온다(2026-10-18) */
  pod?: string;
  owner?: string;
  /** 그 에이전트의 이름과 주인의 사람 이름(관리자 응답, 없으면 빈 값). 화면은 「주인 · 에이전트 이름」으로 그린다(스펙 2026-10-19-003) */
  pod_name?: string;
  owner_name?: string;
  /** 사람이 아닌 주체(2026-10-17-012): aas = AAS 서버가 스스로 바꿈, agent = Hermes 가 스킬 문서를 고침, guest = 로그인 실패(IP 만 남음). 없고 who 도 비면 옛 기록 */
  actor?: 'aas' | 'agent' | 'guest';
  /** token: Claude Code 연결(토큰)로 한 일(스펙 2026-10-28-001 §3-7 ⑦). 사람 칩 옆에 「Claude Code」 배지 */
  via?: 'token';
}

interface ChangesData {
  days: number;
  rows: ChangeRow[];
  /** 주인용 응답(지금 POD 기록만) */
  owner?: boolean;
  /** 팀 관리자가 팀원 에이전트를 보는 응답(owner 는 거짓, 기록 범위는 주인 응답과 같다, DD8) */
  team_manager?: boolean;
  /** 주인 응답에만: 주인 부서의 지금 팀 관리자 표시 이름(DD6) */
  team_managers?: string[];
  pod?: string;
  /** 지금 에이전트의 이름(없으면 빈 값, 스펙 2026-10-19-003) */
  pod_name?: string;
  /** 지금 주인이 된 시각. 이보다 앞선 기록은 보이지 않는다 */
  since?: string;
}

const REQUEST: Record<string, [string, Tone | undefined]> = {
  queued: ['market.statusQueued', undefined],
  running: ['market.statusRunning', undefined],
  done: ['market.statusDone', undefined],
  failed: ['market.statusFailed', 'warn'],
};

const ACTOR = { aas: 'changes.actorAas', agent: 'changes.actorAgent', guest: 'changes.actorGuest' } as const;

// 누가 칸의 글. 사람이 아니면 주체를 짧게 보인다 — 예전 「(누가 했는지 기록 없음)」은 길어 칸이 두 줄이 되고, 자동으로 된 일과 옛 기록이 구분되지 않았다(2026-10-17-012)
// 팀 관리자가 한 줄은 「팀 관리자 이름」으로 찾고 내보낸다(DD10)
const whoOf = (r: ChangeRow) =>
  r.by_admin
    ? t('changes.byAdmin')
    : r.by_team_manager
    ? t('changes.byTeamManager', { name: r.who_name || r.who || '' })
    : r.who_name || r.who || (r.actor ? t(ACTOR[r.actor]) : t('changes.noRecord'));

/** 사람 칩이 아닐 때의 누가 칸. 사람이 아닌 주체는 사람 칩과 같은 모양의 주체 칩(색이 다름), 옛 기록은 마우스를 올리면 왜 비었는지 알린다 */
const whoText = (r: ChangeRow): ReactNode =>
  !r.who && r.actor ? (
    <ActorChip kind={r.actor} label={whoOf(r)} />
  ) : !r.who && !r.actor ? (
    <Tooltip title={t('changes.whoUnknownTip')}>
      <Box component="span" color="text.secondary" data-who-unknown="">
        {whoOf(r)}
      </Box>
    </Tooltip>
  ) : (
    whoOf(r)
  );

// 사람은 에이전트 화면의 소유자 칸과 같은 사용자 칩(머리글자·한 줄·넘치면 말줄임, 마우스를 올리면 전체 주소)이다(OMAI-1294, 표와 서랍 공통).
// 서버(aas/ops/changes.py rows)는 who 에 로그인 이메일만 넣고 이메일이 아니면 비운다 — 에이전트 별칭이 사람 칩으로 보일 일이 없다.
// 로그인을 쓰지 않는 설치의 'local' 은 사람이 아니라 칩을 쓰지 않는다
const whoChip = (r: ChangeRow): ReactNode => (!r.by_admin && r.who?.includes('@') ? <UserChip name={r.who_name} email={r.who} /> : null);

/** Claude Code 연결로 한 일이면 사람 칩 오른쪽에 무채색 배지(§3-7 ⑦ — 호박색·ActorChip 은 쓰지 않는다) */
const withVia = (r: ChangeRow, node: ReactNode): ReactNode =>
  r.via === 'token' ? (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, minWidth: 0, maxWidth: '100%' }}>
      {node}
      <SubtleBadge>{t('changes.viaBadge')}</SubtleBadge>
    </Box>
  ) : (
    node
  );
const viaOf = (r: ChangeRow): string => (r.via === 'token' ? t('changes.viaBadge') : t('changes.viaScreen'));

/** 표의 누가 칸. 관리자가 바꾼 줄만 호박 태그, 팀 관리자·다른 사람이 한 줄은 사람 칩 오른쪽에 무채색 배지(행 높이 안, DD10·D15) */
const whoCell = (r: ChangeRow): ReactNode => withVia(r, whoCellBase(r));
const whoCellBase = (r: ChangeRow): ReactNode =>
  r.by_admin ? (
    <Pill tone="warn">{t('changes.byAdminTag')}</Pill>
  ) : r.by_team_manager || r.by_other ? (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, minWidth: 0, maxWidth: '100%' }}>
      {whoChip(r) ?? whoText(r)}
      <SubtleBadge>{t(r.by_team_manager ? 'changes.teamManagerBadge' : 'changes.otherBadge')}</SubtleBadge>
    </Box>
  ) : (
    whoChip(r) ?? whoText(r)
  );

// 대상 칸의 글. 프로파일 이름(main 등)은 사용자마다 같아 앞에 주인 이름을 붙인다(2026-10-18)
// 2026-10-19: 주인 이름만으로는 한 사람의 에이전트 여럿을 가르지 못해 「주인 · 에이전트 이름」을 붙인다(스펙 2026-10-19-003). 옛 서버(pod_name 없음)는 owner 그대로
const agentOf = (r: ChangeRow, podName?: string) =>
  r.pod && (r.pod_name !== undefined || podName !== undefined)
    ? agentLabel({ id: r.pod, name: r.pod_name ?? podName, owner_name: r.owner_name })
    : (r.owner ?? r.pod ?? '');
const targetOf = (r: ChangeRow) => (r.owner ? `${agentOf(r)} · ${r.detail ?? ''}` : (r.detail ?? ''));

// 공통 표의 열(OMAI-1127). 묶음은 모두 중립색이고, 주인 화면에서 관리자가 바꾼 줄만 Amber 로 짚는다(디자인 결정 14A).
// 색은 글자와 함께 쓴다 — 색만으로 뜻을 전하지 않는다(15A)
const COLUMNS = (): GridColumn<ChangeRow>[] => [
  // 누가 칸은 「사람 칩 + 팀 관리자 배지」가 말줄임 없이 들어가도록 176px 을 둔다. 1200px 창에서 가로 스크롤이 생기지 않게
  // 무엇을·대상 칸의 최소 폭을 그만큼 줄였다(스펙 2026-10-22-001, OKE 실화면에서 이름이 「A·」로 잘렸다)
  { ...nameColumn<ChangeRow>({ id: 'what', label: t('changes.what'), value: changeWhat }), width: 'minmax(168px, 2fr)' },
  {
    id: 'group',
    label: t('changes.kind'),
    value: changeGroupLabel,
    width: 'minmax(96px, auto)',
    render: (r) => <Pill>{changeGroupLabel(r)}</Pill>,
  },
  {
    id: 'who',
    label: t('changes.who'),
    value: whoOf,
    width: 'minmax(176px, 1fr)',
    render: whoCell,
  },
  { id: 'detail', label: t('changes.target'), value: targetOf, width: 'minmax(152px, 2fr)' },
  {
    id: 'result',
    label: t('changes.result'),
    value: (r) => (r.failed ? t('changes.resultFailed') : r.request_status ? t(REQUEST[r.request_status]?.[0] ?? '') : ''),
    width: '96px',
    render: (r) =>
      r.failed ? (
        <Pill tone="bad">{isAccess(r) ? t('changes.failedShort') : t('changes.tabFailed')}</Pill>
      ) : r.request_status && REQUEST[r.request_status] ? (
        <Pill tone={REQUEST[r.request_status][1]}>{t(REQUEST[r.request_status][0])}</Pill>
      ) : null,
  },
  // 변경 기록은 「몇 분 전」보다 정확한 시각이 쓸모 있어 경과 시간 칸 대신 연도까지 쓴 시각을 보인다
  { id: 'ts', label: t('changes.when'), value: (r) => r.ts, render: (r) => fmtTs(r.ts), width: '136px', num: true },
];

/** 팀 관리자 화면 머리의 대상 에이전트 칩과 「바꾸기」(DD8). 목록은 상단 고르개와 같은 줄(agentMenuItems)이고 내 것과 팀원 것만 둔다.
 *  고르면 상단 고르개와 같은 동작(switchPod → 그 화면으로 새로 고침)이라 앱 전체의 지금 에이전트가 바뀐다 */
function TeamTarget({ me }: { me: Me }) {
  const tk = chatTokens[useTheme().palette.mode];
  const { enqueueSnackbar } = useSnackbar();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const email = (me.user?.email ?? '').toLowerCase();
  const pods = (me.pods ?? []).filter((p) => p.team || (!!email && (p.owner ?? '').toLowerCase() === email));
  if (!me.pod) return null;
  const pick = async (id: string) => {
    setBusy(true);
    try {
      await switchPod(id);
      reloadAtView('changes');
    } catch (e) {
      setBusy(false);
      enqueueSnackbar(t('shell.switchFailed', { error: (e as Error).message }), { variant: 'error' });
    }
  };
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', verticalAlign: 'middle' }}>
      <AgentChip name={viewerAgentLabel(me.pod, me.user?.email)} title={me.pod.id} />
      {pods.length > 1 && (
        <Button
          size="small"
          aria-haspopup="menu"
          disabled={busy}
          onClick={(e) => setAnchor(e.currentTarget)}
          sx={{ '@media (pointer: coarse)': { minHeight: 44 } }}
        >
          {t('changes.switchAgent')}
        </Button>
      )}
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
        {agentMenuItems({
          pods,
          currentId: me.pod.id,
          viewerEmail: me.user?.email,
          sx: menuItemSx(tk),
          onClose: () => setAnchor(null),
          onPick: (id) => void pick(id),
          sections: { muted: tk.muted },
        })}
      </Menu>
    </Box>
  );
}

export function Changes() {
  const [days, setDays] = useDays([7, 30], 30);
  const me = useMe().data;
  const pod = me?.pod?.id ?? '';
  const q = useQuery<ChangesData>({
    // POD 를 넣는다 — 주인은 POD 마다 다른 기록을 보므로 POD 를 바꾼 뒤 앞 POD 기록이 남아 보이면 안 된다(디자인 결정 5A)
    queryKey: ['changes', pod, days],
    queryFn: () => get('/api/changes?days=' + days),
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === pod ? keepPreviousData(prev) : undefined),
  });
  // 탭 두 개가 쿠키를 함께 쓰면 응답이 다른 POD 의 것일 수 있다 — 화면의 POD 와 다르면 버린다(재검토 L3)
  const d = q.data && !((q.data.owner || q.data.team_manager) && pod && q.data.pod !== pod) ? q.data : undefined;
  // 「편집」 열: 그 변경이 일어난 설정으로(스펙 ui/ops-edit-links.md, OMAI-1210). 열 곳을 모르는 종류는 빈 칸, 권한이 없으면 열이 없다
  const editCol = useEditColumn<ChangeRow>(changeEditTarget, changeWhat);
  if (!d) return <ScreenLoading title={t('changes.title')} error={q.error?.message} />;

  const owner = !!d.owner;
  // 팀 관리자는 주인과 같은 범위(지금 에이전트의 주인 기간 기록)를 본다. 화면 모양은 주인 화면을 따르고 머리·빈 상태만 다르다(DD8)
  const teamView = !owner && !!d.team_manager;
  const scoped = owner || teamView;
  // 서랍의 「팀 관리자 이름 (부서)」: 팀 관리자는 주인과 같은 부서라 보는 사람의 부서를 쓴다. 전체 기록(관리자)은 여러 부서가 섞여 부서를 붙이지 않는다(DD10)
  const dept = scoped ? me?.department ?? '' : '';
  const teamManagers = owner ? d.team_managers ?? [] : [];
  const rows = d.rows;
  const changes = rows.filter((r) => !isAccess(r));
  const failed = changes.filter((r) => r.failed);
  const today = new Date().toISOString().slice(0, 10);
  // 기록에는 식별자가 없다. 시각·종류·누가·대상으로 식별하고, 이 넷이 모두 같은 기록끼리만 같은 값이 몇 번째인지(n)를 붙인다.
  // 받은 배열의 위치는 쓰지 않는다 — 새 기록이 앞에 붙어도 열린 서랍·선택이 같은 기록을 따라가야 한다
  const seen = new Map<string, number>();
  const ids = new Map<ChangeRow, string>();
  for (const r of rows) {
    const base = `${r.ts}|${r.kind}|${r.who}|${r.detail}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    ids.set(r, n ? `${base}#${n}` : base);
  }
  // 보기 카드(2026-10-17-011): 카드 숫자는 그 보기의 행 수다. 예전 「바꾼 일」 카드는 실패를 포함해 세어 표와 달랐다(§4-1)
  const today_ = t('changes.today', { count: changes.filter((r) => r.ts.slice(0, 10) === today).length });
  const changedTab: ListTab<ChangeRow> = {
    id: 'changes',
    label: t('changes.changed'),
    items: changes.filter((r) => !r.failed),
    card: { sub: scoped ? t('changes.cardChangedOwnerSub', { today: today_, admin: changes.filter((r) => r.by_admin).length }) : today_ },
    empty: teamView
      ? t('changes.teamEmpty', { owner: me?.pod?.owner_name || me?.pod?.owner || d.pod_name || d.pod, date: (d.since ?? '').slice(0, 10) })
      : owner
      ? t('changes.ownerEmpty', { days: d.days, date: (d.since ?? '').slice(0, 10) })
      : t('changes.changedEmpty'),
  };
  const failedTab: ListTab<ChangeRow> = {
    id: 'failed',
    label: t('changes.tabFailed'),
    tone: 'warn',
    items: failed,
    empty: t('changes.failedEmpty'),
    card: { sub: t('changes.failedRequestsSub') },
  };

  return (
    <ListView<ChangeRow>
      guide="changes.list"
      title={owner ? t('changes.ownerTitle') : teamView ? t('changes.teamTitle') : t('changes.title')}
      sub={
        teamView && me ? (
          <>
            <TeamTarget me={me} /> · {t('common.lastDays', { count: d.days, days: d.days })}
          </>
        ) : owner ? (
          <>
            {t('changes.ownerSub', { pod: d.pod_name || d.pod, days: d.days })}
            {/* 내 에이전트를 다룰 수 있는 팀 관리자를 흐린 한 줄로 알린다. 없으면 줄이 없다(DD6) */}
            {teamManagers.length > 0 && (
              <Box component="span" data-team-managers="" sx={{ display: 'block', mt: 0.5, fontSize: 12, color: 'text.secondary' }}>
                {t('changes.teamManagersLine', { names: teamManagers.join(', ') })}
              </Box>
            )}
          </>
        ) : (
          t('changes.sub', { days: d.days })
        )
      }
      error={q.error?.message}
      toolbar={
        <>
          <PeriodSelect days={days} options={[7, 30]} onChange={setDays} />
          {scoped && (
            <Button startIcon={<BadgeOutlinedIcon />} size="small" component={Link} to="/profiles">
              {t('changes.toProfiles')}
            </Button>
          )}
        </>
      }
      cards={
        scoped
          ? [
              {
                n: changes.filter((r) => r.request_status === 'queued' || r.request_status === 'running').length,
                label: t('changes.pendingInstalls'),
              },
            ]
          : [{ n: new Set(changes.map((r) => r.who).filter(Boolean)).size, label: t('changes.people') }]
      }
      tabs={
        scoped
          ? [changedTab, failedTab]
          : [
              changedTab,
              failedTab,
              {
                id: 'access',
                label: t('changes.tabAccess'),
                items: rows.filter(isAccess),
                card: {
                  sub: t('changes.cardAccessSub', {
                    n: rows.filter((r) => r.kind === 'login').length,
                    failed: t('changes.loginFailed', { count: rows.filter((r) => r.kind === 'login_failed').length }),
                  }),
                },
              },
            ]
      }
      filters={[
        { key: 'group', label: t('changes.kind'), get: changeGroupLabel },
        { key: 'who', label: t('changes.who'), get: whoOf },
        { key: 'via', label: t('changes.via'), get: viaOf },
      ]}
      text={(r) => [changeWhat(r), targetOf(r), whoOf(r), changeGroupLabel(r)].join(' ')}
      id="changes"
      columns={[...COLUMNS(), ...editCol]}
      rowId={(r) => ids.get(r) ?? r.ts}
      onRefresh={() => void q.refetch()}
      isFetching={q.isFetching}
      detail={(r) => ({
        title: changeWhat(r),
        sub: `${changeGroupLabel(r)} · ${fmtTs(r.ts)}`,
        body: (
          <>
            <KV
              pairs={[
                [t('changes.when'), r.ts.slice(0, 19).replace('T', ' ')],
                [
                  t('changes.who'),
                  r.by_team_manager ? (
                    <span key="w" title={r.who}>
                      {dept ? t('changes.byTeamManagerDept', { name: r.who_name || r.who || '', dept }) : whoOf(r)}
                    </span>
                  ) : (
                    withVia(r, whoChip(r) ?? whoText(r))
                  ),
                ],
                [t('changes.what'), changeWhat(r)],
                ...(r.pod
                  ? ([[t('changes.agent'), <span key="a" title={r.pod}>{agentOf(r, d?.pod_name)}</span>]] as [string, ReactNode][])
                  : []),
                [t('changes.target'), <code key="c">{r.detail || '—'}</code>],
                [
                  t('changes.result'),
                  r.failed ? <Tag tone="bad">{t('changes.resultFailed')}</Tag> : <Tag tone="good">{t('changes.resultOk')}</Tag>,
                ],
                ...(r.request_status
                  ? ([
                      [
                        t('changes.request'),
                        <>
                          <Tag tone={REQUEST[r.request_status]?.[1]}>{t(REQUEST[r.request_status]?.[0] ?? '')}</Tag>{' '}
                          <Link to="/market?tab=log">{t('changes.toMarketLog')}</Link>
                        </>,
                      ],
                    ] as [string, ReactNode][])
                  : []),
              ]}
            />
            <p>{t('changes.noValuesNote')}</p>
          </>
        ),
      })}
    />
  );
}
