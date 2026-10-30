/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 사용자·권한: 누가 들어올 수 있고 누가 관리자인지, 지금 로그인돼 있는지. 관리자만 본다.
// GET /api/users 의 mode 로 두 방식을 가른다(2026-10-14-011 V5):
// - keycloak: Keycloak 사용자를 만들고 관리한다(screens/users/KeycloakUsers)
// - legacy(Keycloak 관리 설정 없음, R6): 이 파일의 옛 화면 그대로 — 화면 권한만 준다(/api/users/set). info 안내 띠를 단다
import DashboardOutlinedIcon from '@mui/icons-material/DashboardOutlined';
import LogoutOutlinedIcon from '@mui/icons-material/LogoutOutlined';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  NativeSelect,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { AddAction, AddIconButton } from '@/components/AddIconButton';
import { AgentChips } from '@/components/AgentChip';
import { KV, Labeled, ScreenLoading, Section } from '@/components/bits';
import { useConfirm } from '@/components/ConfirmDialog';
import { AgeCell, ageColumn, GridColumn, nameColumn, Pill, statusColumn } from '@/components/DataGrid';
import { DrawerActions } from '@/components/DrawerActions';
import { ListView, Tone } from '@/components/ListView';
import { PageTitle } from '@/components/PageTitle';
import { useUi } from '@/components/UiContext';
import { UserChip } from '@/components/UserChip';
import { t } from '@/i18n';
import { agentLabel, agentLabels } from '@/lib/agentLabel';
import { get, post } from '@/lib/api';
import { isAdmin, useMe } from '@/lib/data';
import { fmtTs } from '@/lib/format';
import { usePeople } from '@/lib/people';

import { ConnectionsTab, useAllConnections } from './users/ConnectionsTab';
import { KeycloakUsers } from './users/KeycloakUsers';
import { KcUsersData } from './users/logic';

interface UserRow {
  email: string;
  admin: boolean;
  pods: string[];
  sessions: number;
  logins?: number;
  last_login?: string | null;
  until?: string | null;
  password?: boolean;
  fixed?: boolean;
  grant?: { ts: string; by?: string } | null;
}
interface UsersData {
  mode?: 'legacy';
  auth_enabled: boolean;
  domain?: string;
  me: string;
  registry_file?: string;
  registry_error?: string;
  pods: { id: string; name?: string; owner?: string }[];
  users: UserRow[];
}

type Role = 'user' | 'admin' | 'none';

function RoleForm({ x, data }: { x: UserRow | null; data: UsersData }) {
  const confirm = useConfirm();
  const { enqueueSnackbar } = useSnackbar();
  const { closeDrawer } = useUi();
  const qc = useQueryClient();
  const [email, setEmail] = useState(x?.email ?? '');
  const [role, setRole] = useState<Role>(x?.admin ? 'admin' : 'user');
  const [pods, setPods] = useState<string[]>(x ? x.pods : data.pods.length === 1 ? [data.pods[0].id] : []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const labels = agentLabels(data.pods); // 확인창의 에이전트도 「주인 · 이름」(스펙 2026-10-19-003)

  const save = async () => {
    const who = email.trim();
    if (role === 'none' && !(await confirm(t('users.confirmRemoveAccess', { who })))) return;
    if (
      role === 'admin' &&
      !(await confirm(t('users.confirmMakeAdmin', { who })))
    )
      return;
    // 있는 사람의 권한을 낮추거나 볼 수 있는 에이전트를 바꾸는 것도 되돌리기 전까지 영향이 커서 확인한다(OMAI-1135)
    if (role === 'user' && x?.admin && !(await confirm(t('users.confirmDemote', { who })))) return;
    const samePods = x && [...x.pods].sort().join() === [...pods].sort().join();
    if (
      role === 'user' &&
      x &&
      !x.admin &&
      !samePods &&
      !(await confirm(t('users.confirmPods', { who, pods: pods.length ? pods.map((id) => labels[id] ?? id).join(', ') : t('users.none') })))
    )
      return;
    setBusy(true);
    try {
      await post('/api/users/set', { email: who, role, pods: role === 'user' ? pods : [] });
      enqueueSnackbar(t('users.roleSaved', { who }), { variant: 'success' });
      closeDrawer();
      await qc.invalidateQueries({ queryKey: ['users'] });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Stack spacing={1.5}>
      <TextField
        size="small"
        label={t('users.email')}
        value={email}
        disabled={!!x}
        onChange={(e) => setEmail(e.target.value)}
        placeholder={t('users.emailPlaceholder', { domain: data.domain || 'example.com' })}
        slotProps={{ htmlInput: { spellCheck: false, 'aria-label': t('users.email') } }}
      />
      <Labeled label={t('users.role')}>
        <NativeSelect
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
          inputProps={{ 'aria-label': t('users.role') }}
        >
          <option value="user">{t('users.optionUser')}</option>
          <option value="admin">{t('users.optionAdmin')}</option>
          {x?.grant && <option value="none">{t('users.optionNone')}</option>}
        </NativeSelect>
      </Labeled>
      {role === 'user' && (
        <Box>
          {data.pods.map((p) => (
            <FormControlLabel
              key={p.id}
              label={agentLabel(p)}
              control={
                <Checkbox
                  checked={pods.includes(p.id)}
                  onChange={(e) =>
                    setPods((cur) => (e.target.checked ? [...cur, p.id] : cur.filter((v) => v !== p.id)))
                  }
                />
              }
            />
          ))}
        </Box>
      )}
      {error && <Alert severity="error">{error}</Alert>}
      <Box>
        <Button variant="contained" disabled={busy} onClick={save}>
          {t('users.save')}
        </Button>
      </Box>
      <Typography variant="caption" color="text.secondary">
        {t('users.roleNote')}
      </Typography>
    </Stack>
  );
}

// 로그인 끊기는 서랍 머리의 단추로 둔다(COP Drawer 처럼, OMAI-1135). 대화 상자에서 확인한 뒤 끊는다
function UserActions({ x, me }: { x: UserRow; me: string }) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  if (!x.sessions) return null;
  const run = async () => {
    try {
      const r = await post<{ ended: number }>('/api/users/logout', { email: x.email });
      enqueueSnackbar(t('users.sessionsEnded', { n: r.ended }), { variant: 'success' });
      if (x.email === me) window.location.href = '/auth/login';
      else await qc.invalidateQueries({ queryKey: ['users'] });
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    }
  };
  return (
    <DrawerActions
      actions={[
        {
          id: 'logout',
          label: t('users.logoutUser'),
          description: t('users.logoutTip'),
          icon: LogoutOutlinedIcon,
          danger: true,
          confirm: {
            message: t('users.confirmLogout', { email: x.email }) + (x.email === me ? ' ' + t('users.confirmLogoutSelf') : ''),
            okLabel: t('users.logoutUser'),
            onConfirm: run,
          },
        },
      ]}
    />
  );
}

const roleOf = (x: UserRow): [string, Tone | undefined] =>
  x.admin ? [t('users.admin'), 'good'] : x.pods.length ? [t('users.user'), undefined] : [t('users.noPods'), 'warn'];

// 공통 표의 열(OMAI-1127). 두 줄 목록의 권한·나·파일 지정 태그 → 권한 칸, 로그인·비밀번호 태그 → 세션·로그인 방법,
// 둘째 줄의 에이전트 → 볼 수 있는 에이전트, 오른쪽 마지막 로그인 → 열
const COLUMNS = (me: string, labels: Record<string, string>): GridColumn<UserRow>[] => [
  { ...nameColumn<UserRow>({ id: 'email', label: t('users.email'), value: (x) => x.email }), render: (x) => <UserChip email={x.email} /> },
  statusColumn<UserRow>({
    id: 'role',
    label: t('users.role'),
    value: (x) => roleOf(x)[0],
    tone: (x) => roleOf(x)[1],
    extra: (x) => (
      <>
        {x.email === me && <Pill>{t('users.me')}</Pill>}
        {x.fixed && <Pill>{t('users.fixedInFile')}</Pill>}
      </>
    ),
  }),
  {
    id: 'pods',
    label: t('users.visibleHermes'),
    value: (x) => (x.pods.length ? x.pods.map((p) => labels[p] || p).join(', ') : t('users.noVisiblePods')),
    width: 'minmax(160px, 2fr)',
    render: (x) => (x.pods.length ? <AgentChips names={x.pods} labels={labels} /> : t('users.noVisiblePods')),
  },
  {
    id: 'sessions',
    label: t('users.grid.sessions'),
    value: (x) => x.sessions,
    width: 'minmax(96px, auto)',
    render: (x) => (x.sessions ? <Pill tone="good">{t('users.loggedIn')}</Pill> : null),
  },
  {
    id: 'password',
    label: t('users.loginMethod'),
    value: (x) => ['SSO', x.password ? t('users.hasPassword') : ''].filter(Boolean).join(' · '),
    width: 'minmax(120px, auto)',
    render: (x) => (
      <>
        SSO
        {x.password && <Pill>{t('users.hasPassword')}</Pill>}
      </>
    ),
  },
  {
    ...ageColumn<UserRow>({ id: 'last_login', label: t('users.grid.lastLogin'), value: (x) => x.last_login }),
    width: '112px',
    render: (x) => (x.last_login ? <AgeCell ts={x.last_login} /> : t('users.noLoginRecord')),
  },
];

export function Users() {
  const me = useMe();
  const admin = isAdmin(me.data);
  const people = usePeople(admin); // 「부여: 누구」를 이메일 대신 이름으로(2026-10-30)
  // 관리자가 아니면 부르지 않는다(서버는 403 「관리자만 볼 수 있습니다」). 메뉴에서도 뺐지만 주소로 들어온 경우 빨간 오류 대신 안내를 보인다
  const q = useQuery<UsersData | KcUsersData>({ queryKey: ['users'], queryFn: () => get<UsersData | KcUsersData>('/api/users'), enabled: admin });
  const { openDrawer } = useUi();
  const nav = useNavigate();
  const raw = q.data;
  // 옛 방식(비밀번호 로그인) 화면의 「Claude Code 연결」 탭 수. 조건부 반환 앞에서 부른다(훅 순서). Keycloak 화면은 자기 안에서 센다
  const conns = useAllConnections(admin && !!raw && raw.mode !== 'keycloak' && !!raw.auth_enabled);
  const connCount = Array.isArray(conns.data?.tokens) ? conns.data.tokens.filter((x) => x.state === 'active').length : null;
  if (me.data && !admin)
    return (
      <Box>
        <PageTitle>{t('users.title')}</PageTitle>
        <Alert severity="info" sx={{ mt: 2 }} action={<Button startIcon={<DashboardOutlinedIcon />} color="inherit" size="small" onClick={() => nav('/dashboard')}>{t('users.adminOnlyGo')}</Button>}>
          {t('users.adminOnly')}
        </Alert>
      </Box>
    );
  if (!raw) return <ScreenLoading title={t('users.title')} error={q.error?.message} />;
  if (raw.mode === 'keycloak')
    return <KeycloakUsers d={raw} refetch={() => void q.refetch()} isFetching={q.isFetching} error={q.error?.message} />;
  const d = raw as UsersData;
  const labels = agentLabels(d.pods); // 옛 방식은 이름이 없어 주인 이메일 · 에이전트(스펙 2026-10-19-003)

  const u = d.users;
  const admins = u.filter((x) => x.admin);
  const live = u.filter((x) => x.sessions);
  const add: AddAction = {
    label: t('users.addPerson'),
    guide: 'users.add',
    onClick: () =>
      openDrawer({
        title: t('users.addPerson'),
        sub: t('users.addPersonSub'),
        body: <RoleForm x={null} data={d} />,
      }),
  };

  return (
    <ListView<UserRow>
      guide="users.list"
      title={t('users.title')}
      sub={
        d.auth_enabled
          ? d.domain
            ? t('users.domainOnly', { domain: d.domain })
            : ''
          : t('users.authOff')
      }
      error={[q.error?.message, d.registry_error].filter(Boolean).join(' ') || null}
      banner={{ severity: 'info', message: t('users.banner.legacy') }}
      titleAction={<AddIconButton {...add} />}
      gridAction={add}
      // 보기 카드(2026-10-17-011)가 탭 줄을 대신한다. 「등록된 사람」 카드는 「전체」 보기 카드와 같아 지웠다
      cards={[{ n: d.pods.length, label: t('users.cardPods'), sub: d.pods.map((p) => p.name || p.id).join(', ') }]}
      tabs={[
        { id: 'all', label: t('users.all'), items: u, card: {} },
        { id: 'admin', label: t('users.admin'), items: admins, card: { sub: t('users.cardAdminSub') } },
        {
          id: 'live',
          label: t('users.liveTab'),
          items: live,
          empty: t('users.emptyLive'),
          card: { sub: t('users.sessionCount', { n: u.reduce((a, x) => a + x.sessions, 0) }) },
        },
        // 「Claude Code 연결」(스펙 2026-10-28-001 디자인 D19). 로그인을 켠 설치에서만
        ...(d.auth_enabled ? [{ id: 'connections', label: t('conn.adminTab'), items: [], count: connCount, toggles: [], content: <ConnectionsTab />, card: {} }] : []),
      ]}
      text={(x) => x.email}
      id="users"
      columns={COLUMNS(d.me, labels)}
      rowId={(x) => x.email}
      onRefresh={() => void q.refetch()}
      isFetching={q.isFetching}
      // 역할 서랍(RoleForm·UserActions)이 행 밖의 Hermes 목록·도메인·내 계정을 읽는다
      detailKey={[d.pods, d.domain, d.me, d.registry_file]}
      detail={(x) => ({
        title: x.email,
        sub: x.admin ? t('users.admin') : t('users.user'),
        body: (
          <>
            <UserActions x={x} me={d.me} />
            <KV
              pairs={[
                [
                  t('users.role'),
                  x.admin
                    ? t('users.roleAdminDesc')
                    : x.pods.length
                    ? t('users.roleUserDesc')
                    : t('users.roleNoneDesc'),
                ],
                [t('users.visibleHermes'), x.pods.length ? <AgentChips key="v" names={x.pods} labels={labels} /> : ''],
                [t('users.loginMethod'), ['SSO', x.password ? t('users.passwordInternal') : ''].filter(Boolean).join(' · ')],
                [t('users.logins'), x.logins ? t('users.loginsDetail', { n: x.logins, time: fmtTs(x.last_login) }) : t('users.noRecord')],
                [t('users.currentSession'), x.sessions ? t('users.sessionUntil', { n: x.sessions, time: fmtTs(x.until) }) : t('users.none')],
              ]}
            />
            {x.fixed ? (
              <Section title={t('users.role')}>
                <Typography variant="caption" color="text.secondary">
                  {t('users.fixedNote', { file: d.registry_file })}
                </Typography>
              </Section>
            ) : (
              <Section title={t('users.changeRole')}>
                <RoleForm x={x} data={d} />
                {x.grant && (
                  <Typography variant="caption" color="text.secondary" component="p">
                    {t('users.grantedBy', { date: String(x.grant.ts).slice(0, 10), by: (x.grant.by && people.find((p) => p.email === x.grant?.by)?.name) || x.grant.by || '' })}
                  </Typography>
                )}
              </Section>
            )}
            <Typography variant="caption" color="text.secondary" component="p">
              {t('users.passwordNote')}
            </Typography>
          </>
        ),
      })}
      note={t('users.note')}
    />
  );
}
