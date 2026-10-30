/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 되돌리기 어려운 동작 앞의 확인. 브라우저 confirm() 대신 쓴다(자동화 도구를 막는 모달을 피한다).
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import { Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, FormControlLabel, useTheme } from '@mui/material';
import { createContext, ReactNode, useCallback, useContext, useRef, useState } from 'react';

import { t } from '@/i18n';
import { dialogTokens } from '@/lib/shellTokens';

/** danger: 되돌릴 수 없는 삭제 — 확인 단추를 Tier 3 위험(brand red)으로(DESIGN §1-1.1, OMAI-1153 D11).
 *  title·confirmLabel: 제목과 확인 단추 글자(없으면 「확인」). cancelFirst: 위험이 아니어도 처음 포커스를 취소에 둔다 —
 *  방 사람 모두에게 미치는 동작이 Enter 한 번으로 실행되지 않게(회의 「새 대화」, 스펙 2026-10-20-027 DR9) */
export interface ConfirmOpts {
  danger?: boolean;
  /** 본문 아래 체크 하나(공지 「끝남 안내 만들기」, 스펙 공지 바 3B). 확인을 누르기 전 값이 바뀔 때마다 부른다. 처음은 꺼짐 */
  check?: { label: string; onChange: (checked: boolean) => void };
  title?: string;
  confirmLabel?: string;
  cancelFirst?: boolean;
}
type Confirm = (message: string, opts?: ConfirmOpts) => Promise<boolean>;

const Ctx = createContext<Confirm | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const [opts, setOpts] = useState<ConfirmOpts>({});
  const [checked, setChecked] = useState(false);
  const danger = !!opts.danger;
  const cancelFirst = danger || !!opts.cancelFirst;
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  // 확인창을 연 요소. 서랍(모달) 안 단추에서 열면 확인창이 서랍에 aria-hidden 을 붙이는데, 그때 포커스가 서랍 안에 남아 있으면
  // 브라우저가 경고한다(공지 「지금 내리기」, 2026-10-24). 열기 전에 포커스를 놓고, 닫힌 뒤 이 요소로 직접 돌려준다
  const opener = useRef<HTMLElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const mode = useTheme().palette.mode;
  const tk = dialogTokens[mode];

  const confirm = useCallback<Confirm>((m, opts) => {
    resolver.current?.(false);
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) {
      opener.current = active;
      active.blur();
    }
    setOpts(opts ?? {});
    setChecked(false);
    setMessage(m);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  // 처음 포커스를 줄 단추(jsx-a11y/no-autofocus 때문에 autoFocus 대신 ref 로 준다)
  const focusNow = useCallback((node: HTMLButtonElement | null) => node?.focus(), []);

  // 닫힘 효과가 끝난 뒤(바깥 서랍의 aria-hidden 이 풀린 뒤) 연 단추로 돌아간다. 포커스가 비었거나, 아직 확인창 안이거나,
  // 연 단추를 감싼 곳(바깥 서랍의 틀)에 있을 때만 돌려준다. 다른 곳(새로 연 서랍 등)이 가져갔으면 두지 않는다
  const restoreFocus = useCallback(() => {
    const el = opener.current;
    opener.current = null;
    const now = document.activeElement;
    if (el?.isConnected && (now === null || now === document.body || root.current?.contains(now) || now.contains(el))) el.focus();
  }, []);

  const answer = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setMessage(null);
  };

  return (
    <Ctx.Provider value={confirm}>
      {children}
      <Dialog
        open={message !== null}
        onClose={() => answer(false)}
        maxWidth="xs"
        fullWidth
        aria-labelledby="confirm-title"
        disableRestoreFocus
        ref={root}
        TransitionProps={{ onExited: restoreFocus }}
      >
        {/* 위험 확인에만 경고 아이콘 칩을 둔다. 본문은 제목 글자 줄에 맞춰 들여 쓴다(스펙 ui/common-dialog-redesign.md §3) */}
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: '12px', px: 3, pt: '20px' }}>
          {danger && (
            <Box
              aria-hidden
              data-testid="confirm-danger-icon"
              sx={{
                flex: 'none', width: 36, height: 36, borderRadius: '50%', display: 'grid', placeItems: 'center',
                color: tk.dangerIcon, bgcolor: 'rgba(218, 41, 28, 0.12)', border: '1px solid rgba(218, 41, 28, 0.25)',
              }}
            >
              <WarningAmberRoundedIcon sx={{ fontSize: 20 }} />
            </Box>
          )}
          <DialogTitle id="confirm-title" sx={{ p: 0, pt: danger ? '6px' : 0, flex: 1 }}>
            {opts.title ?? t('common.confirm')}
          </DialogTitle>
        </Box>
        <DialogContent sx={{ pl: danger ? '72px' : 3 }}>
          <DialogContentText>{message}</DialogContentText>
          {opts.check && (
            <FormControlLabel
              sx={{ mt: 1 }}
              control={
                <Checkbox
                  size="small"
                  checked={checked}
                  onChange={(e) => {
                    setChecked(e.target.checked);
                    opts.check?.onChange(e.target.checked);
                  }}
                />
              }
              label={opts.check.label}
            />
          )}
        </DialogContent>
        <DialogActions>
          {/* 위험한 동작은 Enter 한 번으로 실행되지 않도록 처음 포커스를 취소에 둔다 */}
          <Button onClick={() => answer(false)} ref={cancelFirst ? focusNow : undefined}>
            {t('common.cancel')}
          </Button>
          <Button variant="contained" color={danger ? 'error' : 'primary'} onClick={() => answer(true)} ref={cancelFirst ? undefined : focusNow}>
            {opts.confirmLabel ?? t('common.confirm')}
          </Button>
        </DialogActions>
      </Dialog>
    </Ctx.Provider>
  );
}

export function useConfirm(): Confirm {
  const v = useContext(Ctx);
  if (!v) throw new Error('ConfirmProvider 안에서만 쓸 수 있습니다'); // i18n-ignore: 개발자용 오류
  return v;
}
