/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 서랍 머리의 동작 단추(COP Console Drawer 처럼 제목 줄의 닫기 앞).
// 본문이 <DrawerActions actions={…}/> 를 그리면 단추는 포털로 서랍 머리 자리에 그려진다 — 단추와 대화 상자가 본문의
// React 트리에 남아 본문의 자료·권한·hook 을 그대로 쓴다. 누르면 대화 상자를 거쳐 진행한다:
// - confirm: 확인/취소만 묻는 동작(내보내기 등)
// - dialog: 입력이 필요한 동작(이름 바꾸기·삭제 이름 다시 입력). 양식이 끝나면 close() 를 부른다
// - onClick: 바뀌는 것이 없는 동작만(복제처럼 새 서랍을 여는 것). 대화 상자 없이 바로 부른다
// confirm.onConfirm 이 오류를 던지면 대화 상자를 닫지 않고 안에 오류를 보인다(2026-10-14-011 V6).
// 확인 단추는 DESIGN §4 3-Tier: 위험한 동작은 Tier 3, 나머지는 Tier 1, 취소는 Tier 2. 좁은 화면(xs)에서는 대화 상자가 화면을 채운다(V11).
// 아이콘은 @mui/icons-material SVG 라 에어갭에서도 보인다.
import type { SvgIconComponent } from '@mui/icons-material';
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
  IconButton,
  TextField,
  Tooltip,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { ReactNode, useContext, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { t } from '@/i18n';

import { DrawerHeadSlotContext } from './drawerScope';
import { tier1, tier2, tier3 } from './tierButton';

export interface DrawerAction {
  id: string;
  /** 단추 이름(읽는 이름·툴팁 첫 줄·대화 상자 제목) */
  label: string;
  /** 툴팁의 상세 설명 */
  description?: string;
  icon: SvgIconComponent;
  /** 되돌릴 수 없는 동작은 빨강 단추 */
  danger?: boolean;
  /** 잠긴 동작이면 그 이유. 단추는 보이되 누를 수 없고, 이유를 툴팁과 설명(aria-describedby)으로 읽는다(V12) */
  disabled?: string;
  confirm?: {
    message: ReactNode;
    okLabel: string;
    onConfirm: () => void | Promise<void>;
    /** 이 값을 그대로 다시 입력해야 확인 단추가 켜진다(삭제의 아이디 다시 입력, V7). 입력 칸에 먼저 커서를 둔다 */
    typed?: { label: string; value: string };
  };
  dialog?: { title?: string; render: (close: () => void) => ReactNode };
  /** 바뀌는 것이 없는 동작(다른 서랍 열기)만. 대화 상자를 거치지 않는다 */
  onClick?: () => void;
  /** 아이콘만이 아니라 글자도 보인다. 아이콘 단추들 사이에서 찾지 못하던 동작에만 쓴다(에이전트 「수정」, 2026-10-19-001 디자인 D6) */
  text?: boolean;
}

function ActionButton({ a }: { a: DrawerAction }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [typed, setTyped] = useState('');
  const titleId = useId();
  const reasonId = useId();
  const typedRef = useRef<HTMLInputElement>(null);
  const fullScreen = useMediaQuery(useTheme().breakpoints.down('sm'));
  const Icon = a.icon;
  const close = () => {
    setOpen(false);
    setBusy(false);
    setError('');
    setTyped('');
  };
  const ok = async () => {
    setBusy(true);
    setError('');
    try {
      await a.confirm?.onConfirm();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      return;
    }
    close();
  };
  const need = a.confirm?.typed;
  if (a.disabled)
    return (
      <>
        {/* 잠긴 단추: disabled 단추는 툴팁을 띄우지 못하므로 span 으로 감싼다. 키보드로도 이유를 읽게 aria-disabled 로 둔다 */}
        <Tooltip title={a.disabled}>
          <span>
            <IconButton
              aria-label={a.label}
              aria-disabled="true"
              aria-describedby={reasonId}
              size="small"
              data-locked=""
              sx={{ opacity: 0.38, cursor: 'not-allowed' }}
              onClick={(e) => e.preventDefault()}
            >
              <Icon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <span id={reasonId} hidden>
          {a.disabled}
        </span>
      </>
    );
  return (
    <>
      {/* describeChild: 툴팁을 설명(aria-describedby)으로 단다. 이름표로 달면 대화 상자가 닫혀 초점이 돌아와 툴팁이 열렸을 때
          단추 이름이 「이름+설명」으로 바뀐다 */}
      <Tooltip
        describeChild
        title={
          <>
            <Box component="span" sx={{ display: 'block', fontWeight: 600 }}>
              {a.label}
            </Box>
            {a.description && (
              <Box component="span" sx={{ display: 'block', mt: 0.25 }}>
                {a.description}
              </Box>
            )}
          </>
        }
      >
        {a.text ? (
          <Button size="small" variant="outlined" color="inherit" data-guide={`drawer-action.${a.id}`} startIcon={<Icon fontSize="small" />} onClick={() => (a.onClick ? a.onClick() : setOpen(true))}>
            {a.label}
          </Button>
        ) : (
          <IconButton aria-label={a.label} data-guide={`drawer-action.${a.id}`} size="small" color={a.danger ? 'error' : 'default'} onClick={() => (a.onClick ? a.onClick() : setOpen(true))}>
            <Icon fontSize="small" />
          </IconButton>
        )}
      </Tooltip>
      {!a.onClick && (
      <Dialog
        open={open}
        onClose={busy ? undefined : close}
        aria-labelledby={titleId}
        fullWidth
        maxWidth="sm"
        fullScreen={fullScreen}
        // 다시 입력이 필요한 확인은 입력 칸에 먼저 커서를 둔다(V11)
        TransitionProps={{ onEntered: () => typedRef.current?.focus() }}
      >
        <DialogTitle id={titleId}>{a.dialog?.title ?? a.label}</DialogTitle>
        {a.confirm ? (
          <>
            <DialogContent>
              <DialogContentText component="div">{a.confirm.message}</DialogContentText>
              {need && (
                <TextField
                  size="small"
                  fullWidth
                  inputRef={typedRef}
                  label={need.label}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  disabled={busy}
                  sx={{ mt: 2 }}
                  slotProps={{ htmlInput: { spellCheck: false, autoComplete: 'off' } }}
                />
              )}
              {error && (
                <Alert severity="error" sx={{ mt: 2 }}>
                  {error}
                </Alert>
              )}
            </DialogContent>
            <DialogActions>
              <Button variant="outlined" color="inherit" sx={tier2} onClick={close} disabled={busy}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="outlined"
                color="inherit"
                sx={a.danger ? tier3 : tier1}
                onClick={() => void ok()}
                disabled={busy || (!!need && typed !== need.value)}
                startIcon={busy ? <CircularProgress size={14} color="inherit" /> : undefined}
              >
                {a.confirm.okLabel}
              </Button>
            </DialogActions>
          </>
        ) : (
          <>
            <DialogContent>{open && a.dialog?.render(close)}</DialogContent>
            <DialogActions>
              <Button variant="outlined" color="inherit" sx={tier2} onClick={close}>
                {t('common.cancel')}
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>
      )}
    </>
  );
}

export function DrawerActions({ actions }: { actions: DrawerAction[] }) {
  const slot = useContext(DrawerHeadSlotContext);
  if (!actions.length) return null;
  const buttons = (
    <>
      {actions.map((a) => (
        <ActionButton key={a.id} a={a} />
      ))}
    </>
  );
  if (!slot) return <Box sx={{ display: 'flex', gap: 0.5, mb: 1 }}>{buttons}</Box>; // 서랍 밖(화면)에서는 본문 자리에
  if (!slot.active || !slot.el) return null; // 쌓인 아래 서랍이거나 머리 자리가 아직 없다
  return createPortal(buttons, slot.el);
}
