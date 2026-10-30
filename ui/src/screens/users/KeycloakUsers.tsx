/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 「사용자·권한」 Keycloak 방식(GET /api/users 의 mode=keycloak, 2026-10-14-011 §5-3).
// 목록: 「확인 필요 N」 카드 하나 → 탭(전체·관리자·지금 로그인됨·AAS 접근 없음·Keycloak 계정 없음) + 사용 중지 거르기 → 공통 표(아이디 첫 열).
// 행 「…」 메뉴는 상세 보기·고치기만(공통 표 D17, V3). 그 밖의 동작은 상세 서랍 제목 줄의 DrawerActions 에 둔다.
// 잠금 규칙은 logic.userActions 하나를 행 메뉴와 서랍이 함께 쓴다(V12).
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import HowToRegOutlinedIcon from '@mui/icons-material/HowToRegOutlined';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import LogoutOutlinedIcon from '@mui/icons-material/LogoutOutlined';
import PersonAddAltIcon from '@mui/icons-material/PersonAddAlt';
import PersonOffIcon from '@mui/icons-material/PersonOff';
import { Alert, Box, Button, Typography } from '@mui/material';
import { useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { ReactNode, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { AddAction, AddIconButton } from '@/components/AddIconButton';
import { AgentChips, podLabels } from '@/components/AgentChip';
import { KV, ScreenLoading, Section } from '@/components/bits';
import { AgeCell, ageColumn, GridColumn, nameColumn, Pill, statusColumn } from '@/components/DataGrid';
import { DrawerAction, DrawerActions } from '@/components/DrawerActions';
import type { PageOf } from '@/components/drawerPages';
import { useDrawerHead } from '@/components/drawerScope';
import { ListBanner, ListView } from '@/components/ListView';
import { DrawerSpec, useUi } from '@/components/UiContext';
import { UserChip } from '@/components/UserChip';
import { useOpenParam } from '@/components/useRouteDrawer';
import { useRoutePage } from '@/components/useRoutePage';
import { t } from '@/i18n';
import { agentLabels } from '@/lib/agentLabel';
import { fmtTs } from '@/lib/format';

import { ConnectionsTab, useAllConnections } from './ConnectionsTab';
import { DepartmentsTab, useDeptActions } from './DepartmentsTab';
import { KcUser, KcUsersData, makePassword, roleOf, rolePills, userActions } from './logic';
import { ResultDialog, ResultInfo, useKcUsers, useUserWrite, useWriteLock } from './parts';
import { UserForm } from './UserForm';

/** 볼 수 있는 에이전트 칩의 글자: 「주인 이름 · 에이전트 이름」(스펙 2026-10-19-003). 주인 이름은 같은 응답의 사용자 목록에서 찾는다 */
const kcAgentLabels = (d: KcUsersData) => agentLabels(d.pods, (e) => d.users.find((u) => u.email === e)?.name || undefined);

/** 서랍·폼이 화면에 되돌려 주는 일 */
interface Ctx {
  data: KcUsersData;
  showResult: (r: ResultInfo) => void;
  openRow: (key: string) => void;
}

const dash = '—';
/** AAS 값을 읽지 못한 칸은 「—」(V6 일부만) */
const orDash = (v: ReactNode) => (v === undefined || v === null ? dash : v);
/** 사용 중지 행은 글자를 text.secondary 로(빨강 금지 — 의도한 상태이지 경보가 아니다, V9) */
const dim = (x: KcUser, node: ReactNode) =>
  x.id && !x.enabled ? (
    <Box component="span" data-dim="" sx={{ color: 'text.secondary', display: 'contents' }}>
      {node}
    </Box>
  ) : (
    node
  );

const roleText = (x: KcUser) => t(`users.roleLabel.${roleOf(x)}`);

const COLUMNS = (me: string, labels: Record<string, string>): GridColumn<KcUser>[] => {
  const name = nameColumn<KcUser>({ id: 'username', label: t('users.username'), value: (x) => x.username || x.email });
  return [
    { ...name, render: (x) => dim(x, name.render?.(x)) },
    { id: 'name', label: t('users.name'), value: (x) => x.name, width: 'minmax(110px, 1fr)', render: (x) => dim(x, x.name ? <UserChip name={x.name} email={x.email} /> : x.name) },
    { id: 'email', label: t('users.email'), value: (x) => x.email, width: 'minmax(180px, 1.5fr)', render: (x) => dim(x, x.email) },
    (() => {
      const col = statusColumn<KcUser>({
        id: 'role',
        label: t('users.role'),
        value: roleText,
        // 권한은 무채색 점(V9). 관리자를 초록으로 칠하지 않는다 — 초록은 정상·성공
        tone: () => undefined,
        extra: (x) => (
          <>
            {rolePills(x, me).map((p) => (
              <Pill key={p.key} tone={p.tone}>
                {t(p.key)}
              </Pill>
            ))}
          </>
        ),
      });
      return { ...col, width: 'minmax(160px, auto)', render: (x: KcUser) => dim(x, col.render?.(x)) };
    })(),
    { id: 'department', label: t('users.field.department'), value: (x) => x.department, width: 'minmax(100px, 1fr)', render: (x) => dim(x, orDash(x.department)) },
    {
      id: 'pods',
      label: t('users.visibleHermes'),
      value: (x) => (x.pods ?? []).map((p) => labels[p] || p).join(', '),
      width: 'minmax(160px, 2fr)',
      render: (x) =>
        dim(x, x.pods === undefined ? dash : x.pods.length ? <AgentChips names={x.pods} labels={labels} /> : x.status === 'ok' || x.status === 'unmigrated' ? t('users.noVisiblePods') : dash),
    },
    {
      id: 'sessions',
      label: t('users.grid.sessions'),
      value: (x) => x.sessions,
      width: 'minmax(96px, auto)',
      render: (x) => (x.sessions === undefined ? dash : x.sessions ? <Pill tone="good">{t('users.loggedIn')}</Pill> : null),
    },
    {
      ...ageColumn<KcUser>({ id: 'last_login', label: t('users.grid.lastLogin'), value: (x) => x.last_login }),
      width: '112px',
      render: (x) => dim(x, x.last_login ? <AgeCell ts={x.last_login} /> : t('users.noLoginRecord')),
    },
  ];
};

function deleteMessage(x: KcUser) {
  return (
    <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
      <li>{t('users.del.line1')}</li>
      <li>{t('users.del.line2', { n: x.agents_running ?? 0 })}</li>
      <li>{t('users.del.line3')}</li>
      <li>{t('users.del.line4')}</li>
    </Box>
  );
}

/** 상세 서랍 본문. 목록을 다시 받으면 같은 행의 새 값으로 다시 그린다(사용 중지 뒤 뱃지 등) */
function UserDetail({ rowKey, fallback, ctx }: { rowKey: string; fallback: KcUser; ctx: Ctx }) {
  const q = useKcUsers();
  const data = q.data?.mode === 'keycloak' ? q.data : ctx.data;
  const x = data.users.find((u) => u.key === rowKey) ?? fallback;
  const lock = useWriteLock(data);
  const write = useUserWrite();
  const { openDrawer, closeDrawer } = useUi();
  const { enqueueSnackbar, closeSnackbar } = useSnackbar();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const a = userActions(x, data.me, data.admin_count, lock);
  const who = x.username || x.email;
  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });

  const actions: DrawerAction[] = [];
  if (a.edit.visible)
    actions.push({
      id: 'edit',
      label: t('users.action.edit'),
      icon: EditOutlinedIcon,
      disabled: a.edit.locked,
      onClick: () => openDrawer(formSpec('edit', ctx, x)),
    });
  if (a.password.visible)
    actions.push({
      id: 'password',
      label: t('users.action.password'),
      description: t('users.action.passwordTip'),
      icon: KeyOutlinedIcon,
      disabled: a.password.locked,
      confirm: {
        message: t('users.confirmPassword', { who }),
        okLabel: t('users.action.password'),
        onConfirm: async () => {
          const password = makePassword();
          await write('/api/users/password', { id: x.id, password });
          ctx.showResult({ kind: 'password', id: x.key, username: x.username, password, loginUrl: data.login_url || window.location.origin });
        },
      },
    });
  if (a.access.visible)
    actions.push({
      id: 'access',
      label: t('users.action.access'),
      icon: PersonAddAltIcon,
      disabled: a.access.locked,
      confirm: {
        message: t('users.confirmAccess', { who }),
        okLabel: t('users.action.access'),
        onConfirm: async () => {
          await write('/api/users/access', { id: x.id });
          enqueueSnackbar(t('users.accessGiven', { who }), { variant: 'success' });
          await refresh();
        },
      },
    });
  if (a.createAccount.visible)
    actions.push({
      id: 'createAccount',
      label: t('users.action.createAccount'),
      icon: PersonAddAltIcon,
      disabled: a.createAccount.locked,
      onClick: () => openDrawer(formSpec('create', ctx, undefined, x.email)),
    });
  if (a.enable.visible) {
    const off = x.enabled;
    actions.push({
      id: 'enable',
      label: t(off ? 'users.action.disable' : 'users.action.enable'),
      icon: off ? PersonOffIcon : HowToRegOutlinedIcon,
      danger: off,
      disabled: a.enable.locked,
      confirm: {
        message: off
          ? t('users.confirmDisable', { who, n: x.agents_running ?? 0 })
          : t('users.confirmEnable', { who, n: x.agents_suspended ?? 0 }),
        okLabel: t(off ? 'users.action.disable' : 'users.action.enable'),
        onConfirm: async () => {
          const r = await write<{ agents?: number }>('/api/users/enable', { id: x.id, enabled: !off });
          enqueueSnackbar(t(off ? 'users.disabled' : 'users.enabled', { who, n: r.agents ?? 0 }), { variant: 'success' });
          await refresh();
        },
      },
    });
  }
  if (a.logout.visible)
    actions.push({
      id: 'logout',
      label: t('users.logoutUser'),
      description: t('users.logoutTipKc'),
      icon: LogoutOutlinedIcon,
      danger: true,
      confirm: {
        message: t('users.confirmLogout', { email: x.email }) + (x.email === data.me ? ' ' + t('users.confirmLogoutSelf') : ''),
        okLabel: t('users.logoutUser'),
        onConfirm: async () => {
          const r = await write<{ ended: number }>('/api/users/logout', { email: x.email });
          enqueueSnackbar(t('users.sessionsEnded', { n: r.ended }), { variant: 'success' });
          if (x.email === data.me) window.location.href = '/auth/login';
          else await refresh();
        },
      },
    });
  if (a.delete.visible)
    actions.push({
      id: 'delete',
      label: t('users.action.delete'),
      icon: DeleteOutlineIcon,
      danger: true,
      disabled: a.delete.locked,
      confirm: {
        message: deleteMessage(x),
        okLabel: t('users.action.delete'),
        typed: { label: t('users.retypeUsername', { username: x.username }), value: x.username },
        onConfirm: async () => {
          const r = await write<{ agents?: string[] }>('/api/users/delete', { id: x.id });
          const agents = r.agents ?? [];
          closeDrawer();
          // 멈춘 에이전트가 있으면 「에이전트 › 소유권 옮기기」로 가는 링크(V8)
          enqueueSnackbar(agents.length ? t('users.deletedWithAgents', { who, n: agents.length }) : t('users.deleted', { who }), {
            variant: 'success',
            autoHideDuration: agents.length ? 10000 : undefined,
            action: agents.length
              ? (key) => (
                  <Button
                    size="small"
                    color="inherit"
                    onClick={() => {
                      closeSnackbar(key);
                      navigate('/agents' + (agents.length === 1 ? '?q=' + encodeURIComponent(agents[0]) : ''));
                    }}
                  >
                    {t('users.toOwnerMove')}
                  </Button>
                )
              : undefined,
          });
          await refresh();
        },
      },
    });

  const groups = [x.member ? t('users.group.users') : '', x.admin_group ? t('users.group.admins') : ''].filter(Boolean).join(', ');
  return (
    <>
      <DrawerActions actions={actions} />
      <KV
        pairs={[
          [t('users.username'), x.username],
          [t('users.name'), x.name],
          [t('users.email'), x.email],
          [t('users.field.department'), x.department || t('users.departmentNone')], // 비어 있어도 행을 둔다(KV 는 빈 값의 행을 숨긴다)
          [t('users.enabledState'), x.id ? t(x.enabled ? 'users.enabledOn' : 'users.enabledOff') : t('users.pill.noAccount')],
          [t('users.groups'), groups || t('users.none')],
          [
            t('users.role'),
            x.admin ? t('users.roleAdminDesc') : roleOf(x) === 'none' ? t('users.roleNoneKc') : t('users.roleUserDesc'),
          ],
          [t('users.visibleHermes'), (x.pods ?? []).length ? <AgentChips key="v" names={x.pods ?? []} labels={kcAgentLabels(data)} /> : ''],
          [t('users.ownAgents'), (x.own_pods ?? []).length ? <AgentChips key="o" names={x.own_pods ?? []} labels={podLabels(data.pods)} /> : ''],
          [t('users.loginMethod'), ['SSO', x.password ? t('users.passwordInternal') : ''].filter(Boolean).join(' · ')],
          [t('users.logins'), x.logins ? t('users.loginsDetail', { n: x.logins, time: fmtTs(x.last_login) }) : t('users.noRecord')],
          [t('users.currentSession'), x.sessions ? t('users.sessionUntil', { n: x.sessions, time: fmtTs(x.until) }) : t('users.none')],
        ]}
      />
      {x.fixed && (
        <Section title={t('users.role')}>
          <Typography variant="caption" color="text.secondary">
            {t('users.fixedNoteKc')}
          </Typography>
        </Section>
      )}
      {x.status === 'unmigrated' && (
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
          {t('users.unmigratedNote')}
        </Typography>
      )}
    </>
  );
}

/**
 * 사람 관리 행 서랍(스펙 2026-10-28-014 D8). 행 클릭·주소 ?open=<행 id>(사람 추가 뒤 포함, V8)가 이 페이지로 연다.
 * 목록과 같은 조회를 스스로 읽고, 없는 사람이면 안내를 보인다. 서랍 본문은 화면 밖(DrawerHost)에서 그려 화면의 결과 창을 쓰지 못한다 —
 * 임시 비밀번호·새 계정 결과 창은 이 본문이 들고 있다. 이 위에서 연 편집 서랍은 쌓이고, 저장 뒤 닫으면 이 서랍으로 돌아온다(D13)
 */
export function UserPage({ page }: { page: PageOf<'user'> }) {
  const q = useKcUsers();
  const qc = useQueryClient();
  const data = q.data?.mode === 'keycloak' ? q.data : undefined;
  const x = data?.users.find((u) => u.key === page.key);
  const [result, setResult] = useState<ResultInfo | null>(null);
  const writeOpen = useOpenParam('open');
  useDrawerHead(x ? { title: x.username || x.email, sub: x.username ? x.email : t('users.pill.noAccount') } : null);
  if (!data || !x)
    return q.data ? <Alert severity="warning">{t('users.notFound', { id: page.key })}</Alert> : <ScreenLoading title={page.key} error={q.error?.message} />;
  const ctx: Ctx = { data, showResult: setResult, openRow: (key) => writeOpen({ open: key }) };
  const closeResult = () => {
    const r = result;
    setResult(null);
    if (r?.kind === 'create' && r.id) ctx.openRow(r.id);
    void qc.invalidateQueries({ queryKey: ['users'] });
  };
  return (
    <>
      <UserDetail rowKey={x.key} fallback={x} ctx={ctx} />
      <ResultDialog info={result} onClose={closeResult} />
    </>
  );
}

function formSpec(mode: 'create' | 'edit', ctx: Ctx, row?: KcUser, email?: string): DrawerSpec {
  return {
    title: mode === 'create' ? t('users.addPerson') : t('users.editTitle', { who: row?.username || row?.email || '' }),
    sub: mode === 'create' ? t('users.addPersonSubKc') : row?.email,
    body: <UserForm mode={mode} data={ctx.data} row={row} email={email} onCreated={ctx.showResult} openRow={ctx.openRow} />,
  };
}

export function KeycloakUsers({ d, refetch, isFetching, error }: { d: KcUsersData; refetch: () => void; isFetching: boolean; error?: string }) {
  const { openDrawer } = useUi();
  const qc = useQueryClient();
  const [result, setResult] = useState<ResultInfo | null>(null);
  const lock = useWriteLock(d);
  const [dept, deptEl, deptModel] = useDeptActions(d);         // 부서 탭(스펙 2026-10-15-026)
  // 행 서랍은 주소 ?open=<행 id> 와 묶인다(스펙 2026-10-28-014 D8). 사람 목록은 POD 와 관계없어 pod 는 쓰지 않는다
  const { open, openRow, clearOnTab } = useRoutePage('users', { pod: false });
  const ctx: Ctx = { data: d, showResult: setResult, openRow };

  const closeResult = () => {
    const r = result;
    setResult(null);
    if (r?.kind === 'create' && r.id) openRow(r.id);
    void qc.invalidateQueries({ queryKey: ['users'] });
  };

  const u = d.users;
  const admins = u.filter((x) => x.admin);
  const live = u.filter((x) => x.sessions);
  const noAccess = u.filter((x) => x.status === 'no_access');
  const noAccount = u.filter((x) => x.status === 'no_account');
  const unmigrated = u.filter((x) => x.status === 'unmigrated').length;

  // 안내 띠(V5): 연결 실패·쓰기 권한 없음·옮기지 못한 관리자는 모두 warning. 빨강은 쓰지 않는다
  const warn: string[] = [];
  if (!d.keycloak.ok)
    warn.push(
      t(d.keycloak.reason === 'forbidden' ? 'users.banner.readForbidden' : 'users.banner.unreachable') +
        (d.keycloak.message ? ` (${d.keycloak.message})` : '')
    );
  else if (lock) warn.push(t('users.banner.writeForbidden'));
  if (d.unmigrated?.length) warn.push(t('users.banner.unmigrated', { list: d.unmigrated.join(', ') }));
  const banner: ListBanner | null = warn.length ? { severity: 'warning', message: warn.join(' ') } : null;
  // 제목 옆 + 와 표 툴바의 「+ …」: 부서 탭에서는 「부서 추가」, 나머지 탭에서는 「사용자 추가」(디자인 리뷰 6B 의 titleAction 함수 형태)
  // 「Claude Code 연결」 탭의 수(살아 있는 연결). 로그인을 켠 설치에서만(스펙 2026-10-28-001 디자인 D19)
  const conns = useAllConnections(!!d.auth_enabled);
  const connCount = Array.isArray(conns.data?.tokens) ? conns.data.tokens.filter((x) => x.state === 'active').length : null;
  const addFor = (tab: string): AddAction =>
    tab === 'departments'
      ? { label: t('users.addDepartment'), onClick: dept.add, guide: 'users.add' }
      : { label: t('users.addPerson'), guide: 'users.add', disabled: !!lock, disabledReason: lock || undefined, onClick: () => openDrawer(formSpec('create', ctx)) };

  return (
    <>
      <ListView<KcUser>
        guide="users.list"
        title={t('users.title')}
        sub={d.auth_enabled ? (d.domain ? t('users.domainOnly', { domain: d.domain }) : '') : t('users.authOff')}
        error={[error, d.registry_error].filter(Boolean).join(' ') || null}
        banner={banner}
        titleAction={({ tab }) => <AddIconButton {...addFor(tab)} />}
        gridAction={({ tab }) => addFor(tab)}
        // 보기 카드(2026-10-17-011)가 탭 줄을 대신한다. 「확인 필요」 카드는 접근 없음·계정 없음 두 보기 카드의 경고 색으로 대신하고,
        // 그 카드가 함께 세던 「OIDC 로 옮기지 못한 사람」은 따로 보는 보기가 없어 「전체」 카드 둘째 줄에 남긴다(§4-1)
        tabs={[
          {
            id: 'all',
            label: t('users.all'),
            items: u,
            empty: t('users.empty.all'),
            card: unmigrated ? { sub: t('users.cardUnmigratedSub', { n: unmigrated }) } : {},
          },
          { id: 'admin', label: t('users.admin'), items: admins, empty: t('users.empty.admin'), card: {} },
          { id: 'live', label: t('users.liveTab'), items: live, empty: t('users.empty.live'), card: {} },
          { id: 'no_access', label: t('users.tab.noAccess'), items: noAccess, tone: 'warn', empty: t('users.empty.check'), card: {} },
          { id: 'no_account', label: t('users.tab.noAccount'), items: noAccount, tone: 'warn', empty: t('users.empty.check'), card: {} },
          // 목록 밖 부서가 하나라도 있으면 배지를 호박색으로(디자인 리뷰 7A). 숫자는 목록 + 목록 밖 줄 수
          {
            id: 'departments',
            label: t('users.tab.departments'),
            items: [],
            count: deptModel.count,
            tone: deptModel.attention ? 'warn' : undefined,
            toggles: [],
            content: <DepartmentsTab model={deptModel} handlers={dept} />,
            card: {},
          },
          ...(d.auth_enabled
            ? [{ id: 'connections', label: t('conn.adminTab'), items: [], count: connCount, toggles: [], content: <ConnectionsTab />, card: {} }]
            : []),
        ]}
        toggles={[{ id: 'disabled', label: t('users.pill.disabled'), match: (x) => !!x.id && !x.enabled }]}
        text={(x) => [x.username, x.name, x.email, x.department].join(' ')}
        id="users-kc"
        columns={COLUMNS(d.me, kcAgentLabels(d))}
        rowId={(x) => x.key}
        openId={open}
        clearOnTab={clearOnTab}
        onRow={(x) => openRow(x.key)}
        actions={[
          {
            id: 'edit',
            label: t('users.action.edit'),
            visible: (x) => {
              const a = userActions(x, d.me, d.admin_count, lock).edit;
              return a.visible && !a.locked;
            },
            onClick: (x) => openDrawer(formSpec('edit', ctx, x)),
          },
        ]}
        onRefresh={refetch}
        isFetching={isFetching}
        note={t('users.note')}
      />
      <ResultDialog info={result} onClose={closeResult} />
      {deptEl}
    </>
  );
}
