/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 「사용자·권한」 Keycloak 방식이 함께 쓰는 조각(2026-10-14-011 §5-3):
// - SectionHeader: DESIGN §4 Section Header(▬ 01 / 제목)
// - useAsk: 이 화면의 확인 창. 공통 useConfirm(제목·단추가 늘 「확인」)을 쓰지 않는다(V7)
// - ResultDialog: 사람 추가·비밀번호 재설정 뒤의 결과 창. 바깥 누르기·Esc 로 닫히지 않는다(V4)
// - useUserWrite·useWriteLock: 쓰기 요청과 403(Keycloak 쓰기 권한 없음) 뒤 쓰기 잠금(V5)
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
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
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ReactNode, useCallback, useId, useRef, useState } from 'react';

import { KV, monoFont } from '@/components/bits';
import { tier1, tier2, tier3 } from '@/components/tierButton';
import { t } from '@/i18n';
import { ApiError, get, post } from '@/lib/api';

import { handoffText, KcUsersData } from './logic';

/** DESIGN §4 「Section Headers」: 붉은 20×2 막대 · 두 자리 번호 · / · 제목 */
export function SectionHeader({ index, title }: { index: number; title: string }) {
  return (
    <Box
      component="h3"
      data-section-index={index}
      sx={(th) => {
        const dark = th.palette.mode === 'dark';
        return {
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          m: 0,
          mt: 2.5,
          mb: '12px',
          fontFamily: monoFont,
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          fontFeatureSettings: '"tnum" 1',
          '&::before': {
            content: '""',
            flex: '0 0 20px',
            height: '2px',
            borderRadius: '1px',
            bgcolor: '#DA291C',
            boxShadow: '0 0 6px rgba(218, 41, 28, 0.25)',
          },
          '& .idx': { color: dark ? '#8a8f98' : '#9ca3af' },
          '& .sep': { color: dark ? '#3e3e44' : '#d1d5db', fontWeight: 400 },
          '& .cap': { color: dark ? '#d0d6e0' : '#1f2937', fontWeight: 600 },
        };
      }}
    >
      <span className="idx" aria-hidden>
        {String(index).padStart(2, '0')}
      </span>
      <span className="sep" aria-hidden>
        /
      </span>
      <span className="cap">{title}</span>
    </Box>
  );
}

/** 좁은 화면(xs)에서는 대화 상자가 화면을 채운다(V11) */
export const useNarrow = () => useMediaQuery(useTheme().breakpoints.down('sm'));

// 누르는 영역 44px 이상(V11)
const touch = { minHeight: 44 };

interface Ask {
  title: string;
  message: ReactNode;
  okLabel: string;
  danger?: boolean;
}

/** 이 화면의 확인 창. ask() 는 확인이면 true. 제목·단추 이름을 동작마다 정한다(V7) */
export function useAsk(): [(a: Ask) => Promise<boolean>, ReactNode] {
  const [cur, setCur] = useState<Ask | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const titleId = useId();
  const fullScreen = useNarrow();
  const ask = useCallback((a: Ask) => {
    resolver.current?.(false);
    setCur(a);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);
  const answer = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setCur(null);
  };
  const el = (
    <Dialog open={!!cur} onClose={() => answer(false)} aria-labelledby={titleId} fullWidth maxWidth="xs" fullScreen={fullScreen}>
      <DialogTitle id={titleId}>{cur?.title}</DialogTitle>
      <DialogContent>
        <DialogContentText component="div">{cur?.message}</DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button variant="outlined" color="inherit" sx={[tier2 as object, touch]} onClick={() => answer(false)}>
          {t('common.cancel')}
        </Button>
        <Button variant="outlined" color="inherit" sx={[(cur?.danger ? tier3 : tier1) as object, touch]} onClick={() => answer(true)}>
          {cur?.okLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
  return [ask, el];
}

// ── 쓰기 잠금 ──

const LOCK_KEY = ['users-write-forbidden'];

/** 쓰기 403(Keycloak manage-users 없음)을 한 번 받으면 이 화면의 쓰기를 잠근다. 조회 캐시에 두어 서랍 안에서도 바로 보인다 */
export function useWriteForbidden(): [boolean, () => void] {
  const qc = useQueryClient();
  const q = useQuery<boolean>({
    queryKey: LOCK_KEY,
    queryFn: () => false,
    initialData: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return [q.data === true, useCallback(() => qc.setQueryData(LOCK_KEY, true), [qc])];
}

/** Keycloak 에 쓸 수 없으면 그 이유(쓰기 단추를 잠근다). 쓸 수 있으면 undefined */
export function useWriteLock(d: KcUsersData | undefined): string | undefined {
  const [forbidden] = useWriteForbidden();
  if (!d) return undefined;
  if (!d.keycloak.ok) return t(d.keycloak.reason === 'forbidden' ? 'users.lock.forbidden' : 'users.lock.keycloak');
  if (forbidden) return t('users.lock.forbidden');
  return undefined;
}

/** 쓰기 요청. 403 + reason forbidden 이면 쓰기를 잠그고 오류를 그대로 던진다 */
export function useUserWrite() {
  const [, setForbidden] = useWriteForbidden();
  return useCallback(
    async <T,>(path: string, body: unknown): Promise<T> => {
      try {
        return await post<T>(path, body);
      } catch (e) {
        if (e instanceof ApiError && e.status === 403 && e.reason === 'forbidden') setForbidden();
        throw e;
      }
    },
    [setForbidden]
  );
}

export const useKcUsers = () => useQuery<KcUsersData>({ queryKey: ['users'], queryFn: () => get<KcUsersData>('/api/users') });

// ── 결과 창 ──

export type AgentResult = 'created' | 'exists' | 'deferred' | 'failed';

export interface ResultInfo {
  kind: 'create' | 'password';
  /** 만든 사람의 행 id(닫은 뒤 그 행을 연다) */
  id: string;
  username: string;
  password: string;
  loginUrl: string;
  agent?: AgentResult;
}

/** 결과 창(V4). 바깥 누르기·Esc 로 닫히지 않고, 「전달했습니다, 닫기」로만 닫는다. 닫으면 값을 버린다 */
export function ResultDialog({ info, onClose }: { info: ResultInfo | null; onClose: () => void }) {
  const fullScreen = useNarrow();
  const titleId = useId();
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState('');
  const copyRef = useRef<HTMLButtonElement>(null);
  const close = () => {
    setShown(false);
    setCopied('');
    onClose();
  };
  const copy = async () => {
    if (!info) return;
    try {
      await navigator.clipboard.writeText(handoffText(info));
      setCopied(t('users.result.copied'));
    } catch {
      setCopied(t('users.result.copyFailed'));
    }
  };
  return (
    <Dialog
      open={!!info}
      // 바깥 누르기·Esc 로 닫지 않는다. 임시 비밀번호를 전달하기 전에 창이 사라지면 다시 볼 방법이 없다
      onClose={() => undefined}
      disableEscapeKeyDown
      aria-labelledby={titleId}
      fullWidth
      maxWidth="sm"
      fullScreen={fullScreen}
      data-result=""
      // 열리면 「전달용 문구 복사」에 커서를 둔다(V11)
      TransitionProps={{ onEntered: () => copyRef.current?.focus() }}
    >
      {info && (
        <>
          <DialogTitle id={titleId}>{t(info.kind === 'create' ? 'users.result.created' : 'users.result.reset')}</DialogTitle>
          <DialogContent>
            <KV
              pairs={[
                [t('users.username'), <Box key="u" component="span" sx={{ fontFamily: monoFont }}>{info.username}</Box>],
                [
                  t('users.result.password'),
                  <Box key="p" component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                    <Box component="span" data-password="" sx={{ fontFamily: monoFont, letterSpacing: shown ? 0 : '0.1em' }}>
                      {shown ? info.password : '•'.repeat(12)}
                    </Box>
                    <Button size="small" variant="outlined" color="inherit" sx={tier2} onClick={() => setShown((v) => !v)} aria-pressed={shown}>
                      {t(shown ? 'users.result.hide' : 'users.result.show')}
                    </Button>
                  </Box>,
                ],
                [t('users.result.loginUrl'), <Box key="l" component="span" sx={{ fontFamily: monoFont, wordBreak: 'break-all' }}>{info.loginUrl}</Box>],
                ...(info.kind === 'create' && info.agent
                  ? ([[t('users.result.agent'), t(`users.result.agent.${info.agent}`)]] as [string, ReactNode][])
                  : []),
              ]}
            />
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
              {t('users.result.howTo')}
            </Typography>
          </DialogContent>
          <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
            <Button startIcon={<ContentCopyOutlinedIcon />} variant="outlined" color="inherit" sx={[tier2 as object, touch]} onClick={() => void copy()} ref={copyRef}>
              {t('users.result.copy')}
            </Button>
            <Typography variant="caption" color="text.secondary" aria-live="polite" role="status" sx={{ mr: 'auto' }}>
              {copied}
            </Typography>
            <Button variant="outlined" color="inherit" sx={[tier1 as object, touch]} onClick={close}>
              {t('users.result.done')}
            </Button>
          </DialogActions>
        </>
      )}
    </Dialog>
  );
}

/** 저장 단추(Tier 1) — 진행 중이면 돌림 표시 */
export function SaveButton({ busy, disabled, onClick, children }: { busy: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Button
      variant="outlined"
      color="inherit"
      sx={[tier1 as object, touch]}
      disabled={busy || disabled}
      onClick={onClick}
      startIcon={busy ? <CircularProgress size={14} color="inherit" /> : undefined}
    >
      {children}
    </Button>
  );
}

/** 폼에 남는 오류(「일부만 만들어짐」). 다른 오류처럼 다음 입력에 사라지지 않는다 */
export const PartialAlert = ({ text }: { text: string }) => (
  <Alert severity="error" data-partial="">
    {text}
  </Alert>
);
