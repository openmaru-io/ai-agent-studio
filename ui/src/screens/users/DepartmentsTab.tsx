/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 「사용자·권한」의 「부서」 탭(스펙 2026-10-15-026, 디자인 리뷰 1A·1B·2A·2C·2D·2E·2F·3A·6A·7A).
// - 표: 부서 · 사람 수 · 슬로건(글자 한 줄 말줄임) · 만든 날. 사람 수는 Keycloak 사용자 목록 기준(알 수 없으면 「알 수 없음」)
// - 목록에 없는 부서(Keycloak 콘솔·로그인 claim 으로 들어온 값)는 맨 위에 모아 경고 알약 「목록에 없음」, 행 동작은 「목록에 추가」·「이름 바꾸기」
// - 행을 누르면 서랍(구성원 목록 + 이름 바꾸기·삭제), 행 「…」 메뉴에도 같은 동작. 사람이 있는 부서의 삭제는 누르면 이유 대화상자
// - useDeptActions 가 대화상자·요청을 쥐고, 제목 옆 「+」(부서 추가)도 같은 곳을 부른다
// - 「팀 관리자」 칸은 읽기 전용(OMAI-1434 DD1): 사람 칩 최대 2개 + 「외 n」, 옮긴 사람은 흐린 「옮김 n」(DD4). 지정은 행 「…」 메뉴·서랍 동작 줄
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import DriveFileRenameOutlineIcon from '@mui/icons-material/DriveFileRenameOutline';
import ManageAccountsOutlinedIcon from '@mui/icons-material/ManageAccountsOutlined';
import PlaylistAddIcon from '@mui/icons-material/PlaylistAdd';
import { Alert, Box, Typography } from '@mui/material';
import { useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { ReactNode, useCallback, useRef, useState } from 'react';

import { KV } from '@/components/bits';
import { GridAction, GridColumn, LocalDataGrid, nameColumn, Pill } from '@/components/DataGrid';
import { DrawerAction, DrawerActions } from '@/components/DrawerActions';
import { SloganSuggestButton } from '@/components/SloganSuggest';
import { DrawerSpec, useUi } from '@/components/UiContext';
import { UserChip } from '@/components/UserChip';
import { t } from '@/i18n';
import { post } from '@/lib/api';

import { DeptBlockedDialog, DeptNameDialog, DeptPartialDialog, ManagersDialog, PartialInfo } from './DepartmentDialogs';
import { buildDeptRows, DEPT_KEY, deptBadge, DeptRow, useDepartments } from './departments';
import type { KcUser, KcUsersData } from './logic';
import { useAsk, useKcUsers, useUserWrite } from './parts';

const SEED_NOTE_KEY = 'aas.dept.seedNote';

/** 부서 탭이 쓰는 값. 사용자 목록과 부서 목록이 다시 받아지면 같이 바뀐다(서랍도 이 값을 읽는다) */
export function useDeptModel(d?: KcUsersData) {
  const users = useKcUsers();
  const data = users.data?.mode === 'keycloak' ? users.data : d;
  const list = useDepartments();
  // 사용자 목록을 받지 못했거나 Keycloak 에 닿지 않으면 사람 수를 모른다(0 이 아니다, 2F·결정 R1)
  const usersKnown = !!data && data.keycloak.ok;
  const people = data?.users ?? [];
  const rows = buildDeptRows(list.data?.departments ?? [], people, usersKnown);
  return { rows, usersKnown, users: people, list, ...deptBadge(rows) };
}
export type DeptModel = ReturnType<typeof useDeptModel>;

interface Handlers {
  add: () => void;
  rename: (r: DeptRow) => void;
  del: (r: DeptRow) => void;
  addToList: (r: DeptRow) => void;
  open: (r: DeptRow) => void;
  managers: (r: DeptRow) => void;
}

/** 대화상자·요청을 쥔다. [동작, 그릴 대화상자, 부서 탭이 쓰는 값] */
export function useDeptActions(d: KcUsersData | undefined): [Handlers, ReactNode, DeptModel] {
  const model = useDeptModel(d);
  const handlersRef = useRef<Handlers>(null as unknown as Handlers);
  const { openDrawer } = useUi();
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const write = useUserWrite();
  const [ask, askEl] = useAsk();
  const [name, setName] = useState<null | { mode: 'add' } | { mode: 'rename'; row: DeptRow }>(null);
  const [blocked, setBlocked] = useState<null | { row: DeptRow; message?: string }>(null);
  const [partial, setPartial] = useState<PartialInfo | null>(null);
  const [managing, setManaging] = useState<DeptRow | null>(null);

  const refresh = useCallback(async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: DEPT_KEY }), qc.invalidateQueries({ queryKey: ['users'] })]);
  }, [qc]);

  const open = useCallback(
    (row: DeptRow) => {
      const spec: DrawerSpec = {
        title: row.name,
        sub: row.listed ? undefined : t('users.dept.notListed'),
        body: <DeptDetail rowKey={row.key} fallback={row} d={d} handlers={handlersRef.current} />,
      };
      openDrawer(spec);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openDrawer, d]
  );

  const rename = useCallback((row: DeptRow) => setName({ mode: 'rename', row }), []);

  const addToList = useCallback(
    async (row: DeptRow) => {
      try {
        await write('/api/departments/create', { name: row.name });
        enqueueSnackbar(t('users.dept.added', { name: row.name }), { variant: 'success' });
        await refresh();
      } catch (e) {
        enqueueSnackbar((e as Error).message, { variant: 'error' });
      }
    },
    [write, enqueueSnackbar, refresh]
  );

  const del = useCallback(
    async (row: DeptRow) => {
      if (row.people === null) return setBlocked({ row });
      if (row.people > 0) return setBlocked({ row });
      const ok = await ask({
        title: t('users.dept.delete.title'),
        message: t('users.dept.delete.confirm', { name: row.name }) + (row.goal ? t('users.dept.delete.withGoal') : ''),
        okLabel: t('users.dept.action.delete'),
        danger: true,
      });
      if (!ok) return;
      try {
        await write('/api/departments/delete', { name: row.name });
        enqueueSnackbar(t('users.dept.deleted', { name: row.name }), { variant: 'success' });
        await refresh();
      } catch (e) {
        // 그 사이 사람이 들어와 막힌 경우(409)나 Keycloak 에 닿지 않은 경우(503): 서버 문구를 이유 대화상자로 보인다
        setBlocked({ row, message: (e as Error).message });
      }
    },
    [ask, write, enqueueSnackbar, refresh]
  );

  const handlers: Handlers = { add: () => setName({ mode: 'add' }), rename, del, addToList, open, managers: setManaging };
  handlersRef.current = handlers;

  // 이름 바꾸기를 보내고 응답을 알린다. 일부만 되었으면 결과 대화상자(2E)
  const sendRename = useCallback(
    async (from: string, to: string): Promise<void> => {
      const r = await write<{ name: string; changed: number; total: number; partial?: boolean; failed?: { name: string; username: string }[] }>(
        '/api/departments/rename',
        { name: from, new_name: to }
      );
      await refresh();
      if (r.partial) {
        setPartial({ from, to: r.name, changed: r.changed, total: r.total, failed: r.failed ?? [] });
      } else {
        setPartial(null);
        enqueueSnackbar(t('users.dept.renamed', { name: r.name, n: r.changed }), { variant: 'success' });
      }
    },
    [write, refresh, enqueueSnackbar]
  );

  const el = (
    <>
      {name && (
        <DeptNameDialog
          key={name.mode === 'rename' ? name.row.key : 'add'}
          mode={name.mode}
          initial={name.mode === 'rename' ? name.row.name : ''}
          people={name.mode === 'rename' ? (model.usersKnown ? name.row.people : null) : null}
          onClose={() => setName(null)}
          onSubmit={async (value) => {
            if (name.mode === 'add') {
              const r = await write<{ name: string }>('/api/departments/create', { name: value });
              enqueueSnackbar(t('users.dept.added', { name: r.name }), { variant: 'success' });
              await refresh();
            } else {
              await sendRename(name.row.name, value);
            }
            setName(null);
          }}
        />
      )}
      {blocked && (
        <DeptBlockedDialog
          people={blocked.row.people}
          message={blocked.message}
          onClose={() => setBlocked(null)}
          onShow={() => {
            const row = blocked.row;
            setBlocked(null);
            open(row);
          }}
        />
      )}
      {partial && (
        <DeptPartialDialog
          info={partial}
          onClose={() => setPartial(null)}
          onRetry={async () => {
            try {
              await sendRename(partial.from, partial.to);
            } catch (e) {
              enqueueSnackbar((e as Error).message, { variant: 'error' });
            }
          }}
        />
      )}
      {managing && (
        <ManagersDialog
          key={managing.key}
          dept={managing}
          users={model.users}
          onClose={() => setManaging(null)}
          onSubmit={async (emails) => {
            await write('/api/departments/managers', { name: managing.name, emails });
            enqueueSnackbar(t('users.dept.managers.saved', { name: managing.name }), { variant: 'success' });
            await qc.invalidateQueries({ queryKey: DEPT_KEY });
            setManaging(null);
          }}
        />
      )}
      {askEl}
    </>
  );
  return [handlers, el, model];
}

const dash = '—';
const created = (ts: string) => (ts ? ts.slice(0, 10) : dash);

function peopleText(r: DeptRow) {
  return r.people === null ? t('users.dept.unknownPeople') : String(r.people);
}

/** 표의 「팀 관리자」 칸(읽기 전용). 칩 최대 2개 + 「외 n」, 없으면 흐린 「—」. 옮긴 사람은 칩 뒤 흐린 「옮김 n」(호박 알약은 쓰지 않는다, DD4) */
export function ManagersCell({ row, names }: { row: DeptRow; names: Map<string, string> }) {
  const nameOf = (e: string) => names.get(e.toLowerCase()) || undefined;
  const shown = row.managers.slice(0, 2);
  const rest = row.managers.slice(2);
  if (!row.managers.length && !row.moved.length)
    return (
      <Box component="span" sx={{ color: 'text.disabled' }}>
        {dash}
      </Box>
    );
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap' }}>
      {shown.map((e) => (
        <UserChip key={e} name={nameOf(e)} email={e} />
      ))}
      {rest.length > 0 && (
        <Box component="span" title={rest.map((e) => nameOf(e) || e).join(', ')} sx={{ fontSize: 12, color: 'text.secondary' }}>
          {t('users.dept.managers.more', { n: rest.length })}
        </Box>
      )}
      {row.moved.length > 0 && (
        <Box component="span" title={t('users.dept.managers.movedTip')} sx={{ fontSize: 12, color: 'text.disabled' }}>
          {t('users.dept.managers.moved', { n: row.moved.length })}
        </Box>
      )}
    </Box>
  );
}

const COLUMNS = (names: Map<string, string>): GridColumn<DeptRow>[] => {
  const name = nameColumn<DeptRow>({ id: 'name', label: t('users.dept.col.name'), value: (r) => r.name });
  return [
    {
      ...name,
      width: 'minmax(180px, 2fr)',
      render: (r) => (
        <Box sx={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
          {name.render?.(r)}
          {!r.listed && <Pill tone="warn">{t('users.dept.notListed')}</Pill>}
        </Box>
      ),
    },
    { id: 'people', label: t('users.dept.col.people'), value: (r) => r.people ?? undefined, width: '104px', num: true, render: peopleText },
    {
      id: 'managers',
      label: t('users.dept.col.managers'),
      value: (r) => r.managers.map((e) => names.get(e.toLowerCase()) || e).join(', ') || undefined,
      width: 'minmax(160px, 2fr)',
      render: (r) => <ManagersCell row={r} names={names} />,
    },
    {
      id: 'goal',
      label: t('users.dept.col.goal'),
      value: (r) => r.goal,
      width: 'minmax(160px, 3fr)',
      render: (r) =>
        r.goal ? (
          <Box title={r.goal} sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {r.goal}
          </Box>
        ) : (
          dash
        ),
    },
    { id: 'created', label: t('users.dept.col.created'), value: (r) => r.ts || undefined, width: '112px', render: (r) => created(r.ts) },
  ];
};

/** 이메일(소문자) → 표시 이름 */
const nameMap = (users: KcUser[]) => new Map(users.filter((u) => u.email).map((u) => [u.email.toLowerCase(), u.name || u.username]));

function seedNoteDismissed(): boolean {
  try {
    return localStorage.getItem(SEED_NOTE_KEY) === '1';
  } catch {
    return false;
  }
}

/** 탭 안: 처음 안내 띠(3A) + 표 */
export function DepartmentsTab({ model, handlers }: { model: DeptModel; handlers: Handlers }) {
  const [noteGone, setNoteGone] = useState(seedNoteDismissed);
  const loading = model.list.isLoading;
  const actions: GridAction<DeptRow>[] = [
    { id: 'open', label: t('common.grid.openDetail'), onClick: handlers.open },
    { id: 'addToList', label: t('users.dept.action.addToList'), visible: (r) => !r.listed, onClick: handlers.addToList },
    { id: 'rename', label: t('users.dept.action.rename'), onClick: handlers.rename },
    // 팀 관리자는 목록에 있는 부서에만 둔다(서버 목록 줄에만 managers 가 있다)
    { id: 'managers', label: t('users.dept.action.managers'), visible: (r) => r.listed, onClick: handlers.managers },
    // 사람이 있어도 「삭제」는 보이고, 누르면 삭제하지 않고 이유 대화상자(2F). 목록 밖 줄에는 지울 목록 항목이 없다
    { id: 'delete', label: t('users.dept.action.delete'), visible: (r) => r.listed, onClick: handlers.del },
  ];
  return (
    <Box aria-busy={loading || undefined}>
      {model.rows.some((r) => r.listed) && !noteGone && (
        <Alert
          severity="info"
          role="status"
          sx={{ mb: 1.5 }}
          onClose={() => {
            setNoteGone(true);
            try {
              localStorage.setItem(SEED_NOTE_KEY, '1');
            } catch {
              /* 저장하지 못해도 화면은 정상이다(다시 보일 뿐) */
            }
          }}
        >
          {t('users.dept.seedNote')}
        </Alert>
      )}
      {model.list.isError && (
        <Alert severity="error" role="alert" sx={{ mb: 1.5 }}>
          {t('users.dept.pick.failed')}
        </Alert>
      )}
      <LocalDataGrid<DeptRow>
        storageKey="users-kc.departments"
        label={t('users.tab.departments')}
        columns={COLUMNS(nameMap(model.users))}
        rows={model.rows}
        rowId={(r) => r.key}
        onRow={handlers.open}
        actions={actions}
        pin={(r) => !r.listed}
        empty={loading ? t('common.loading') : t('users.dept.empty')}
      />
    </Box>
  );
}

/** 서랍의 슬로건 줄: 문구 옆 AI 추천 단추. 이 화면에는 입력 칸이 없어 고르면 바로 저장한다(스펙 2026-10-17-015) */
function GoalLine({ team, goal }: { team: string; goal: string }) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const save = async (text: string) => {
    await post('/api/settings/goal', { team, goal: text });
    enqueueSnackbar(t('settings.goalSaved', { team }), { variant: 'success' });
    await Promise.all([qc.invalidateQueries({ queryKey: DEPT_KEY }), qc.invalidateQueries({ queryKey: ['settings'] }), qc.invalidateQueries({ queryKey: ['office'] })]);
  };
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
      <Box component="span" sx={{ flex: 1, minWidth: 0 }}>
        {goal || dash}
      </Box>
      <SloganSuggestButton team={team} onPick={save} pickLabel={t('settings.sloganSave')} />
    </Box>
  );
}

/** 부서 서랍 본문(1B). 목록이 다시 받아지면 같은 부서의 새 값으로 다시 그린다 */
export function DeptDetail({ rowKey, fallback, d, handlers }: { rowKey: string; fallback: DeptRow; d?: KcUsersData; handlers: Handlers }) {
  const model = useDeptModel(d);
  const r = model.rows.find((x) => x.key === rowKey) ?? fallback;
  const actions: DrawerAction[] = [];
  if (!r.listed)
    actions.push({ id: 'addToList', label: t('users.dept.action.addToList'), icon: PlaylistAddIcon, onClick: () => handlers.addToList(r) });
  actions.push({ id: 'rename', label: t('users.dept.action.rename'), icon: DriveFileRenameOutlineIcon, onClick: () => handlers.rename(r) });
  if (r.listed)
    actions.push({ id: 'managers', label: t('users.dept.action.managers'), icon: ManageAccountsOutlinedIcon, onClick: () => handlers.managers(r) });
  const blockedWhy = r.people === null ? t('users.dept.blocked.unknown') : r.people > 0 ? t('users.dept.drawer.deleteBlocked', { n: r.people }) : undefined;
  if (r.listed)
    actions.push({
      id: 'delete',
      label: t('users.dept.action.delete'),
      icon: DeleteOutlineIcon,
      danger: true,
      disabled: blockedWhy,
      onClick: () => handlers.del(r),
    });
  const members: ReactNode =
    r.people === null ? (
      t('users.dept.drawer.membersUnknown')
    ) : r.members.length ? (
      <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
        {r.members.map((m) => (
          <li key={m.key}>
            {m.name}
            {m.name !== m.username && ` (${m.username})`}
          </li>
        ))}
      </Box>
    ) : (
      t('users.dept.drawer.noMembers')
    );
  return (
    <>
      <DrawerActions actions={actions} />
      <KV
        pairs={[
          [t('users.dept.drawer.goal'), <GoalLine key="goal" team={r.name} goal={r.goal} />],
          [t('users.dept.drawer.created'), r.listed ? created(r.ts) : dash],
          ...(r.listed ? [[t('users.dept.drawer.managers'), <ManagersCell key="managers" row={r} names={nameMap(model.users)} />] as [string, ReactNode]] : []),
          [t('users.dept.drawer.members'), members],
        ]}
      />
      {blockedWhy && r.listed && (
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
          {blockedWhy}
        </Typography>
      )}
    </>
  );
}

