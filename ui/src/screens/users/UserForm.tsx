/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 사람 추가·고치기 서랍 폼(2026-10-14-011 §5-3, V1·V10·V13).
// 01 계정(아이디·이메일·성·이름·부서) · 02 권한(권한·볼 수 있는 에이전트·에이전트 바로 만들기) · 03 첫 비밀번호(추가만).
// 고치기는 01(아이디·이메일 잠김, R2)과 02 만 있다. 비밀번호는 폼에서 보이지 않는다(보이기·복사는 결과 창에서만, V4).
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  FormHelperText,
  NativeSelect,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { ReactNode, useId, useState } from 'react';

import { podLabels } from '@/components/AgentChip';
import { Labeled } from '@/components/bits';
import { DepartmentPicker } from '@/components/DepartmentPicker';
import { tier2 } from '@/components/tierButton';
import { useUi } from '@/components/UiContext';
import { t } from '@/i18n';
import { agentLabel } from '@/lib/agentLabel';
import { useFocusOnMount } from '@/lib/useFocusOnMount';

import { DEPT_KEY, teamKey, useDepartments } from './departments';
import {
  createBody,
  FieldErrors,
  FormField,
  grantableFor,
  KcUser,
  KcUsersData,
  makePassword,
  updateBody,
  userActions,
  UserFormValues,
  validateUserForm,
  writeErrorView,
} from './logic';
import { AgentResult, PartialAlert, ResultInfo, SaveButton, SectionHeader, useAsk, useUserWrite, useWriteForbidden } from './parts';

export interface UserFormProps {
  mode: 'create' | 'edit';
  data: KcUsersData;
  row?: KcUser;
  /** 「이 이메일로 계정 만들기」(Keycloak 계정 없음 행)에서 채워 여는 이메일 */
  email?: string;
  /** 만들기 성공: 결과 창을 띄운다 */
  onCreated: (r: ResultInfo) => void;
  /** 그 행을 연다(?open=) */
  openRow: (key: string) => void;
}

const initial = (p: UserFormProps): UserFormValues => ({
  username: p.row?.username ?? '',
  email: p.row?.email ?? p.email ?? '',
  last_name: p.row?.last_name ?? '',
  first_name: p.row?.first_name ?? '',
  department: p.row?.department ?? '',
  role: p.row?.admin ? 'admin' : 'user',
  pods: p.row?.shared_pods ?? [],
  create_agent: true,
  password: p.mode === 'create' ? makePassword() : '',
});

export function UserForm(p: UserFormProps) {
  const { mode, data, row } = p;
  const { enqueueSnackbar } = useSnackbar();
  const { closeDrawer } = useUi();
  const qc = useQueryClient();
  const write = useUserWrite();
  const [forbidden] = useWriteForbidden();
  const [ask, askEl] = useAsk();
  const first = useFocusOnMount<HTMLInputElement>();
  const roleHelpId = useId();
  // 부서 목록: 사용자 폼의 후보와 부서 탭이 같은 캐시(['departments'])를 쓴다. 이 사용자의 부서가 목록에 같은 부서(team_key)로 있으면 그 표기로 맞춘다
  const deptQuery = useDepartments();
  const deptNames = (deptQuery.data?.departments ?? []).map((d) => d.name);
  const deptStatus = deptQuery.isError ? 'error' : deptQuery.data ? 'ready' : 'loading';
  const listedAs = (name: string) => deptNames.find((n) => teamKey(n) === teamKey(name));
  // 목록에 같은 부서로 있으면(띄어쓰기·대소문자만 다름) 목록밖이 아니다. 목록 밖이면 값은 지우지 않고 보인다(5A)
  const offListCurrent = row?.department && !listedAs(row.department) ? row.department : undefined;
  const [v, setV] = useState<UserFormValues>(() => initial(p));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [alert, setAlert] = useState('');
  const [partial, setPartial] = useState('');
  const [taken, setTaken] = useState<KcUser | undefined>();
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof UserFormValues>(k: K, value: UserFormValues[K]) => {
    setV((cur) => ({ ...cur, [k]: value }));
    if (k in errors) setErrors((cur) => ({ ...cur, [k]: undefined }));
  };
  const roleLock = row ? userActions(row, data.me, data.admin_count).role.locked : undefined;
  const own = row?.own_pods ?? [];
  // 공유할 수 있는 에이전트: 이 사람이 주인인 것은 「본인 에이전트」 줄로 따로 보인다(V13)
  const shareable = data.pods.filter((x) => !own.includes(x.id));
  const names = podLabels(data.pods);
  const ownerName = (email: string) => data.users.find((u) => u.email === email)?.name || undefined;

  const save = async () => {
    setAlert('');
    setTaken(undefined);
    const found = validateUserForm(v, mode, data.domain);
    if (Object.keys(found).length) {
      setErrors(found);
      return;
    }
    setErrors({});
    const who = mode === 'create' ? v.username.trim() : row?.username || row?.email || '';
    const promote = v.role === 'admin' && !row?.admin;
    const demote = mode === 'edit' && v.role === 'user' && !!row?.admin;
    if (promote && !(await ask({ title: t('users.ask.makeAdmin'), message: t('users.confirmMakeAdmin', { who }), okLabel: t('users.ask.makeAdmin') })))
      return;
    if (demote && !(await ask({ title: t('users.ask.demote'), message: t('users.confirmDemote', { who }), okLabel: t('users.ask.demote') })))
      return;
    setBusy(true);
    try {
      if (mode === 'create') {
        const r = await write<{ id: string; username: string; agent?: AgentResult }>('/api/users/create', createBody(v));
        setPartial('');
        closeDrawer();
        p.onCreated({
          kind: 'create',
          id: r.id,
          username: r.username || v.username.trim(),
          password: v.password,
          loginUrl: data.login_url || window.location.origin,
          agent: r.agent,
        });
      } else if (row) {
        await write('/api/users/update', updateBody(row.id, v, row.department));
        enqueueSnackbar(t('users.saved', { who: v.username.trim() || row.username || row.email || '' }), { variant: 'success' });
        closeDrawer();
        await qc.invalidateQueries({ queryKey: ['users'] });
      }
    } catch (e) {
      const view = writeErrorView(e, v.username.trim());
      setErrors(view.fields);
      if (view.partial) setPartial(view.partial);
      setAlert(view.alert ?? '');
      if (view.fields.department) void qc.invalidateQueries({ queryKey: DEPT_KEY });          // 목록이 바뀌었을 수 있다 — 다음에 열 때 새 목록을 받는다
      const dup = (Object.keys(view.fields) as FormField[]).find((f) => f === 'username' || f === 'email');
      if (dup) setTaken(grantableFor(dup, v[dup], data.users));
      setBusy(false);
    }
  };

  // 409 로 겹친 사람이 「AAS 접근 없음」이면 그 사람에게 접근을 준다(V6)
  const grant = async (x: KcUser) => {
    const who = x.username || x.email;
    if (!(await ask({ title: t('users.action.access'), message: t('users.confirmAccess', { who }), okLabel: t('users.action.access') })))
      return;
    try {
      await write('/api/users/access', { id: x.id });
      enqueueSnackbar(t('users.accessGiven', { who }), { variant: 'success' });
      closeDrawer();
      p.openRow(x.key);
      await qc.invalidateQueries({ queryKey: ['users'] });
    } catch (e) {
      setAlert((e as Error).message);
    }
  };

  const help = (f: FormField, base?: ReactNode): ReactNode => {
    const err = errors[f];
    if (!err) return base;
    if (taken && (f === 'username' || f === 'email'))
      return (
        <>
          {err}{' '}
          <Button size="small" color="inherit" sx={{ p: 0, minWidth: 0, textDecoration: 'underline', verticalAlign: 'baseline' }} onClick={() => void grant(taken)}>
            {t('users.grantTaken')}
          </Button>
        </>
      );
    return err;
  };

  const field = (f: 'username' | 'email' | 'last_name' | 'first_name' | 'department', o: { required?: boolean; locked?: boolean; placeholder?: string; base?: string } = {}) => (
    <TextField
      size="small"
      fullWidth
      label={t(`users.field.${f}`)}
      required={o.required}
      value={v[f]}
      disabled={o.locked || busy}
      onChange={(e) => set(f, e.target.value)}
      placeholder={o.placeholder}
      error={!!errors[f]}
      helperText={help(f, o.base)}
      inputRef={f === (mode === 'create' ? 'username' : 'last_name') ? first : undefined}
      slotProps={{ htmlInput: { spellCheck: false, 'data-field': f } }}
    />
  );

  const locked = !!forbidden;
  return (
    <Stack spacing={1.5} component="form" noValidate onSubmit={(e) => (e.preventDefault(), void save())}>
      {partial && <PartialAlert text={partial} />}
      {alert && <Alert severity={forbidden ? 'warning' : 'error'}>{alert}</Alert>}

      <SectionHeader index={1} title={t('users.section.account')} />
      {field('username', {
        required: mode === 'create',
        locked: mode === 'edit',
        base: mode === 'edit' ? t('users.lockedEdit') : t('users.usernameHelp'),
      })}
      {field('email', {
        required: mode === 'create',
        locked: mode === 'edit',
        placeholder: t('users.emailPlaceholder', { domain: data.domain?.split(',')[0]?.trim() || 'example.com' }),
        base: mode === 'edit' ? t('users.lockedEdit') : undefined,
      })}
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
        {field('last_name', { required: true })}
        {field('first_name', { required: true })}
      </Stack>
      <DepartmentPicker
        label={t('users.field.department')}
        value={listedAs(v.department) ?? v.department}
        onChange={(name) => set('department', name)}
        options={deptNames}
        status={deptStatus}
        onRetry={() => void deptQuery.refetch()}
        current={offListCurrent}
        disabled={busy}
        error={!!errors.department}
        helperText={errors.department ? help('department') : undefined}
      />

      <SectionHeader index={2} title={t('users.section.role')} />
      <Box>
        <Labeled label={t('users.role')}>
          <NativeSelect
            value={v.role}
            disabled={!!roleLock || busy}
            onChange={(e) => set('role', e.target.value as 'user' | 'admin')}
            inputProps={{ 'aria-label': t('users.role'), 'aria-describedby': roleHelpId }}
            fullWidth
          >
            <option value="user">{t('users.optionUser')}</option>
            <option value="admin">{t('users.optionAdmin')}</option>
          </NativeSelect>
        </Labeled>
        <FormHelperText id={roleHelpId}>{roleLock ?? t('users.roleDelay')}</FormHelperText>
      </Box>

      <Box>
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.5 }}>
          {t('users.visibleHermes')}
        </Typography>
        {mode === 'create' ? (
          <FormControlLabel
            control={<Checkbox checked disabled />}
            label={t(v.create_agent ? 'users.ownAgentNew' : 'users.ownAgentLater')}
          />
        ) : own.length ? (
          own.map((id) => <FormControlLabel key={id} control={<Checkbox checked disabled />} label={t('users.ownAgent', { id: names[id] || id })} />)
        ) : (
          <FormControlLabel control={<Checkbox checked disabled />} label={t('users.ownAgentLater')} />
        )}
        {v.role === 'admin' ? (
          <Typography variant="caption" color="text.secondary" component="p">
            {t('users.adminSeesAll')}
          </Typography>
        ) : (
          <>
            <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1 }}>
              {t('users.shareTitle')}
            </Typography>
            {shareable.length ? (
              shareable.map(({ id, ...pod }) => (
                <FormControlLabel
                  key={id}
                  label={agentLabel({ id, ...pod }, ownerName)}
                  control={
                    <Checkbox
                      checked={v.pods.includes(id)}
                      disabled={busy}
                      onChange={(e) => set('pods', e.target.checked ? [...v.pods, id] : v.pods.filter((x) => x !== id))}
                    />
                  }
                />
              ))
            ) : (
              <Typography variant="caption" color="text.secondary" component="p">
                {t('users.noShareable')}
              </Typography>
            )}
          </>
        )}
      </Box>
      {mode === 'create' && (
        <FormControlLabel
          control={
            // 작은 단색 스위치(V10). 켜기·끄기는 색이 아니라 글로 알린다
            <Switch size="small" color="default" checked={v.create_agent} disabled={busy} onChange={(e) => set('create_agent', e.target.checked)} />
          }
          label={t('users.createAgent')}
        />
      )}

      {mode === 'create' && (
        <>
          <SectionHeader index={3} title={t('users.section.password')} />
          <Stack direction="row" spacing={1} alignItems="flex-start">
            <TextField
              size="small"
              fullWidth
              type="password"
              label={t('users.field.password')}
              required
              value={v.password}
              disabled={busy}
              onChange={(e) => set('password', e.target.value)}
              error={!!errors.password}
              helperText={errors.password ?? t('users.passwordHelp')}
              slotProps={{ htmlInput: { autoComplete: 'new-password', 'data-field': 'password' } }}
            />
            <Button variant="outlined" color="inherit" sx={[tier2 as object, { minHeight: 40, whiteSpace: 'nowrap' }]} disabled={busy} onClick={() => set('password', makePassword())}>
              {t('users.regenerate')}
            </Button>
          </Stack>
        </>
      )}

      <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1 }}>
        <Button variant="outlined" color="inherit" sx={[tier2 as object, { minHeight: 44 }]} disabled={busy} onClick={() => void closeDrawer()}>
          {t('common.cancel')}
        </Button>
        <SaveButton busy={busy} disabled={locked} onClick={() => void save()}>
          {t('users.save')}
        </SaveButton>
      </Stack>
      {locked && (
        <Typography variant="caption" color="text.secondary">
          {t('users.lock.forbidden')}
        </Typography>
      )}
      {askEl}
    </Stack>
  );
}
