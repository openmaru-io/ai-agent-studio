/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 부서 탭의 대화상자 세 가지(스펙 2026-10-15-026, 디자인 리뷰 2D·2E·2F).
// - DeptNameDialog: 「부서 추가」·「부서 이름 바꾸기」. 이름 한 칸(라벨 「부서 이름」, 80자 카운터, Enter 로 확인), 중복(409)은 칸 아래 오류
// - DeptBlockedDialog: 사람이 있는 부서의 「삭제」를 누르면 삭제하지 않고 이유와 「구성원 보기」를 보인다
// - DeptPartialDialog: 이름 바꾸기가 일부만 되었을 때의 결과 창(ResultDialog 와 같은 규격: 바깥 누르기·Esc 로 닫히지 않는다)
// - ManagersDialog: 「팀 관리자 지정」(OMAI-1434 디자인 DD3·DD4·DD11). 후보는 그 부서 사람, 옮긴 사람은 줄을 그은 회색 칩
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useId, useRef, useState } from 'react';

import { PersonMultiPicker } from '@/components/PersonPicker';
import { tier1, tier2 } from '@/components/tierButton';
import { t } from '@/i18n';
import { ApiError } from '@/lib/api';
import type { Person } from '@/lib/people';

import { DeptRow, movedDeptText } from './departments';
import type { KcUser } from './logic';
import { useAsk, useNarrow } from './parts';

const touch = { minHeight: 44 };
export const DEPT_NAME_MAX = 80;

export function DeptNameDialog({
  mode,
  initial,
  people,
  onClose,
  onSubmit,
}: {
  mode: 'add' | 'rename';
  initial: string;
  /** 이름 바꾸기에서 함께 바뀔 사람 수. null 이면 알 수 없음 */
  people: number | null;
  onClose: () => void;
  /** 이름을 보낸다. 409 는 ApiError 로 던진다 */
  onSubmit: (name: string) => Promise<void>;
}) {
  const fullScreen = useNarrow();
  const titleId = useId();
  const infoId = useId();
  const [name, setName] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // 열릴 때 이름 칸에 포커스(jsx-a11y/no-autofocus 때문에 autoFocus 대신 ref)
    const id = window.setTimeout(() => input.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, []);
  const clean = name.split(/\s+/).filter(Boolean).join(' ');

  const submit = async () => {
    if (busy) return;
    if (!clean) {
      setError(t('users.dept.err.required'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSubmit(clean);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? t('users.dept.err.exists') : (e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={busy ? undefined : onClose} aria-labelledby={titleId} fullWidth maxWidth="xs" fullScreen={fullScreen}>
      <Box component="form" noValidate onSubmit={(e) => (e.preventDefault(), void submit())}>
        <DialogTitle id={titleId}>{t(mode === 'add' ? 'users.dept.add.title' : 'users.dept.rename.title')}</DialogTitle>
        <DialogContent>
          <TextField
            size="small"
            fullWidth
            margin="dense"
            label={t('users.dept.field.name')}
            value={name}
            inputRef={input}
            disabled={busy}
            onChange={(e) => {
              setName(e.target.value);
              setError('');
            }}
            error={!!error}
            helperText={error || `${clean.length}/${DEPT_NAME_MAX}`}
            slotProps={{ htmlInput: { maxLength: DEPT_NAME_MAX + 20, spellCheck: false, 'data-field': 'dept-name', 'aria-describedby': mode === 'rename' ? infoId : undefined } }}
          />
          {mode === 'rename' && (
            <Typography id={infoId} variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              {people === null ? t('users.dept.renameInfoUnknown') : t('users.dept.renameInfo', { n: people })}
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button variant="outlined" color="inherit" sx={[tier2 as object, touch]} disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            variant="outlined"
            color="inherit"
            sx={[tier1 as object, touch]}
            disabled={busy || !clean || clean.length > DEPT_NAME_MAX}
            startIcon={busy ? <CircularProgress size={14} color="inherit" /> : undefined}
          >
            {t(mode === 'add' ? 'users.dept.add.ok' : 'users.dept.rename.ok')}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}

export function DeptBlockedDialog({
  people,
  message,
  onClose,
  onShow,
}: {
  /** 알 수 없으면 null */
  people: number | null;
  /** 서버가 준 문구(그 사이 사람이 들어와 409 가 났을 때) */
  message?: string;
  onClose: () => void;
  onShow: () => void;
}) {
  const fullScreen = useNarrow();
  const titleId = useId();
  const unknown = people === null && !message;
  return (
    <Dialog open onClose={onClose} aria-labelledby={titleId} fullWidth maxWidth="xs" fullScreen={fullScreen}>
      <DialogTitle id={titleId}>{t('users.dept.blocked.title')}</DialogTitle>
      <DialogContent>
        <DialogContentText>
          {message ?? (people === null ? t('users.dept.blocked.unknown') : t('users.dept.blocked.body', { n: people }))}
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        {!unknown && (
          <Button variant="outlined" color="inherit" sx={[tier2 as object, touch]} onClick={onShow}>
            {t('users.dept.blocked.show')}
          </Button>
        )}
        <Button variant="outlined" color="inherit" sx={[tier1 as object, touch]} onClick={onClose}>
          {t('common.close')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export interface PartialInfo {
  /** 바꾸려던 옛 이름과 새 이름(다시 시도에 쓴다) */
  from: string;
  to: string;
  changed: number;
  total: number;
  failed: { name: string; username: string }[];
}

export function DeptPartialDialog({ info, onRetry, onClose }: { info: PartialInfo; onRetry: () => Promise<void>; onClose: () => void }) {
  const fullScreen = useNarrow();
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    try {
      await onRetry();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      // 바깥 누르기·Esc 로 닫지 않는다. 누가 바뀌지 않았는지 보기 전에 창이 사라지면 안 된다(ResultDialog 와 같다)
      onClose={() => undefined}
      disableEscapeKeyDown
      aria-labelledby={titleId}
      fullWidth
      maxWidth="sm"
      fullScreen={fullScreen}
      data-result=""
    >
      <DialogTitle id={titleId}>{t('users.dept.partial.title')}</DialogTitle>
      <DialogContent>
        <DialogContentText component="div">
          <Typography variant="body2">{t('users.dept.partial.body', { total: info.total, changed: info.changed })}</Typography>
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1.5 }}>
            {t('users.dept.partial.failed')}
          </Typography>
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {info.failed.map((f) => (
              <li key={f.username}>
                {f.name}
                {f.name !== f.username && ` (${f.username})`}
              </li>
            ))}
          </Box>
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button
          variant="outlined"
          color="inherit"
          sx={[tier2 as object, touch]}
          disabled={busy}
          onClick={() => void retry()}
          startIcon={busy ? <CircularProgress size={14} color="inherit" /> : undefined}
        >
          {t('users.dept.partial.retry')}
        </Button>
        <Button variant="outlined" color="inherit" sx={[tier1 as object, touch]} disabled={busy} onClick={onClose}>
          {t('common.close')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

const lower = (e: string) => e.trim().toLowerCase();

/**
 * 팀 관리자 지정 창. 저장하면 고른 이메일 목록 전체를 보낸다(목록에서 빠진 사람의 행은 서버가 지운다).
 * 상태(DD3): ① 구성원을 모름(people=null) — 후보 없이 이메일을 적는 칸과 안내 ② 0명 — 빈 안내, 저장 꺼짐
 * ③ 저장 중 — 단추에 진행 표시·입력 잠금, 400 은 칸 아래 서버 문구, 403·네트워크 오류는 창 안 오류 줄 ④ 지금 팀 관리자를 빼면 확인
 */
export function ManagersDialog({
  dept,
  users,
  onClose,
  onSubmit,
}: {
  dept: DeptRow;
  /** 전체 사용자 목록(이름과 옮긴 사람의 지금 부서를 찾는다). 모르면 빈 목록 */
  users: KcUser[];
  onClose: () => void;
  /** 이메일 목록을 보낸다. 실패는 ApiError 로 던진다 */
  onSubmit: (emails: string[]) => Promise<void>;
}) {
  const fullScreen = useNarrow();
  const titleId = useId();
  const [initial] = useState(() => [...new Set([...dept.managers, ...dept.moved].map(lower))]);
  const [value, setValue] = useState<string[]>(initial);
  const [fieldError, setFieldError] = useState('');
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ask, askEl] = useAsk();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // 열릴 때 사람 고르기 칸에 포커스(DeptNameDialog 와 같다)
    const id = window.setTimeout(() => input.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, []);

  const unknown = dept.people === null;
  const empty = dept.people === 0;
  // 0명이고 지울 행도 없으면 바꿀 것이 없다. 옮긴 사람만 남은 부서는 칩을 빼고 저장할 수 있게 칸을 둔다
  const nothing = empty && initial.length === 0;
  // 처음 값과 같으면(순서 무관) 저장할 것이 없다. 옮긴 사람 칩을 지우면 달라져 저장이 켜진다(리뷰 판정 12)
  const unchanged = value.length === initial.length && value.every((e) => initial.includes(e));
  const people: Person[] = unknown
    ? []
    : dept.members
        .filter((m) => m.email)
        .map((m) => ({ email: lower(m.email), name: m.name || m.username, username: m.username, department: m.department || undefined }));
  const moved = new Set(dept.moved.map(lower));
  const nameOf = (email: string) =>
    users.find((u) => lower(u.email) === email)?.name || people.find((p) => p.email === email)?.name || email;
  const chip = (email: string) =>
    moved.has(lower(email)) ? { label: nameOf(lower(email)), title: movedDeptText(email, users, dept.name), muted: true } : { label: nameOf(lower(email)) };

  const submit = async () => {
    if (busy || nothing || unchanged) return;
    const removed = dept.managers.map(lower).filter((e) => !value.includes(e));
    if (removed.length) {
      const ok = await ask({
        title: t('users.dept.managers.removeTitle'),
        message: t('users.dept.managers.removeConfirm', { names: removed.map(nameOf).join(', ') }),
        okLabel: t('users.dept.managers.removeOk'),
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    setFieldError('');
    setFormError('');
    try {
      await onSubmit(value);
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) setFieldError(e.message);
      else setFormError((e as Error).message || t('users.dept.managers.failed'));
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog open onClose={busy ? undefined : onClose} aria-labelledby={titleId} fullWidth maxWidth="sm" fullScreen={fullScreen}>
        <Box component="form" noValidate onSubmit={(e) => (e.preventDefault(), void submit())}>
          <DialogTitle id={titleId}>
            {t('users.dept.managers.title')}
            <Typography variant="body2" color="text.secondary" component="div">
              {dept.name}
            </Typography>
          </DialogTitle>
          <DialogContent>
            {formError && (
              <Alert severity="error" role="alert" sx={{ mb: 1.5 }}>
                {formError}
              </Alert>
            )}
            {unknown && (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                {t('users.dept.managers.unknown')}
              </Typography>
            )}
            {empty && (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                {t('users.dept.managers.empty')}
              </Typography>
            )}
            {!nothing && (
              <Box sx={{ pt: 1 }}>
                <PersonMultiPicker
                  label={t('users.dept.managers.field')}
                  value={value}
                  people={people}
                  chip={chip}
                  inputRef={input}
                  disabled={busy}
                  error={!!fieldError}
                  helperText={fieldError || undefined}
                  onChange={(next) => {
                    setValue(next);
                    setFieldError('');
                    setFormError('');
                  }}
                />
              </Box>
            )}
          </DialogContent>
          <DialogActions>
            <Button variant="outlined" color="inherit" sx={[tier2 as object, touch]} disabled={busy} onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              variant="outlined"
              color="inherit"
              sx={[tier1 as object, touch]}
              disabled={busy || nothing || unchanged}
              startIcon={busy ? <CircularProgress size={14} color="inherit" /> : undefined}
            >
              {t('users.dept.managers.save')}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>
      {askEl}
    </>
  );
}
