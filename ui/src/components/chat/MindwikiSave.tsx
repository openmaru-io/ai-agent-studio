/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 「MindWiki 에 저장」(스펙 2026-11-15-002 A4·D3·D19, 리뷰 Design 「MindWiki 에 저장」 표).
// 답 아래 행동 줄의 단추. 처음 누르면 저장 위치를 고르고(프로파일마다 서버에 기억), 답을 그대로 새 하위 페이지로 옮긴다(모델 없음).
// 위젯 안에서는 그리지 않는다(D19: 위젯 토큰으로는 저장 경로를 부를 수 없다 — 위젯에서는 에이전트가 MCP 로 쓴다).
// 이유는 코드가 아니라 문장으로(chat.mwSave.reason.<코드>). 같은 저장을 두 번 눌러도 요청 id 가 같아 페이지는 하나다.
import CheckIcon from '@mui/icons-material/Check';
import SaveAltOutlinedIcon from '@mui/icons-material/SaveAltOutlined';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Link,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { useEffect, useState } from 'react';

import { useChatTokens } from '@/components/chat/useChatTokens';
import { t } from '@/i18n';
import { apiFetch } from '@/lib/api';
import { chatMetrics } from '@/lib/chatTokens';
import { useEmbed } from '@/lib/embedContext';

export interface SaveTarget {
  teamspace: string;
  parent_id: string;
  parent_title: string;
  path: string;
}
export interface SaveState {
  available: boolean;
  hidden: boolean;
  reason: string;
  target: SaveTarget | null;
}

/** 서버가 준 이유 코드를 문장으로. 모르는 코드는 「저장하지 못했습니다」 */
export const reasonText = (reason: string): string => {
  const key = `chat.mwSave.reason.${reason}`;
  const s = t(key);
  return s === key ? t('chat.mwSave.reason.invalid') : s;
};

class SaveFail extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

async function call<T>(method: 'GET' | 'PUT' | 'POST', url: string, body?: unknown): Promise<T> {
  const r = await apiFetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-AAS': '1' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const out = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok || out.ok === false) throw new SaveFail(String(out.reason ?? 'invalid'));
  return out as T;
}

const q = (o: Record<string, string>) => new URLSearchParams(Object.entries(o).filter(([, v]) => v)).toString();

/** 답의 첫 제목 줄, 없으면 「<에이전트> 답 <날짜>」 */
export function defaultTitle(markdown: string, agent: string, now = new Date()): string {
  const h = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m.exec(markdown)?.[1];
  if (h) return h.slice(0, 200);
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return t('chat.mwSave.defaultTitle', { agent, date: d });
}

/** 같은 (대화, 메시지, 저장 위치)는 같은 키 — 다시 눌러도 MindWiki 페이지는 하나다(리뷰 DX·Eng E5) */
export const saveKey = (conversation: string, message: string, parent: string) => `${conversation}:${message}:${parent}`.slice(0, 200);

const stateCache = new Map<string, Promise<SaveState>>();
/** 프로파일마다 한 번 읽는다(저장 위치를 바꾸면 지운다) */
export function loadSaveState(pod: string, profile: string): Promise<SaveState> {
  const k = `${pod}\n${profile}`;
  let p = stateCache.get(k);
  if (!p) {
    p = call<SaveState>('GET', `/api/mindwiki/save/state?${q({ pod, profile })}`).catch(() => ({ available: false, hidden: true, reason: 'invalid', target: null }));
    stateCache.set(k, p);
  }
  return p;
}
export const forgetSaveState = (pod?: string, profile?: string) => {
  if (pod === undefined) stateCache.clear();
  else stateCache.delete(`${pod}\n${profile}`);
};

type Phase = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; title: string; url: string } | { kind: 'failed'; reason: string };

export function SaveToMindwiki({ pod, profile, conversation, message, markdown, agent }: { pod: string; profile: string; conversation: string; message: string; markdown: string; agent: string }) {
  const embed = useEmbed();
  const tk = useChatTokens();
  const [state, setState] = useState<SaveState | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    if (embed || !pod || !profile) return;
    let live = true;
    void loadSaveState(pod, profile).then((s) => live && setState(s));
    return () => {
      live = false;
    };
  }, [embed, pod, profile]);
  if (embed || !state || state.hidden) return null;

  const save = async (target: SaveTarget, title: string) => {
    setPhase({ kind: 'saving' });
    try {
      const out = await call<{ url: string }>('POST', '/api/mindwiki/save/answer', {
        pod,
        profile,
        key: saveKey(conversation, message, target.parent_id),
        parent_id: target.parent_id,
        title,
        markdown,
        agent,
      });
      setPhase({ kind: 'saved', title, url: out.url });
    } catch (e) {
      const reason = e instanceof SaveFail ? e.reason : 'invalid';
      setPhase({ kind: 'failed', reason });
      if (reason === 'parent_not_found' || reason === 'forbidden_parent' || reason === 'need_target') setPicking(true); // 위치를 다시 고른다
    }
  };
  const press = () => (state.target ? void save(state.target, defaultTitle(markdown, agent)) : setPicking(true));
  const blocked = !state.available;
  const label = blocked ? reasonText(state.reason) : t('chat.mwSave.button');
  const btnSx = { color: tk.muted, '&:hover': { color: tk.text }, '@media (pointer: coarse)': { minWidth: chatMetrics.touch, minHeight: chatMetrics.touch } };
  return (
    <>
      <Tooltip title={label}>
        <span>
          <IconButton size="small" aria-label={t('chat.mwSave.button')} aria-busy={phase.kind === 'saving'} disabled={blocked || phase.kind === 'saving'} data-testid="mw-save" onClick={press} sx={btnSx}>
            {phase.kind === 'saving' ? <CircularProgress size={14} /> : phase.kind === 'saved' ? <CheckIcon sx={{ fontSize: 16 }} /> : <SaveAltOutlinedIcon sx={{ fontSize: 16 }} />}
          </IconButton>
        </span>
      </Tooltip>
      <Box component="span" aria-live="polite" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, fontSize: 12, color: tk.muted, minWidth: 0 }}>
        {phase.kind === 'saved' && (
          <span data-testid="mw-saved">
            {t('chat.mwSave.saved', { title: phase.title })}{' '}
            {phase.url && (
              <Link href={phase.url} target="_blank" rel="noopener">
                {t('chat.mwSave.open')}
              </Link>
            )}
          </span>
        )}
        {phase.kind === 'failed' && <span data-testid="mw-failed">{reasonText(phase.reason)}</span>}
        {phase.kind === 'idle' && state.target && !blocked && (
          <span>
            {t('chat.mwSave.target', { path: [state.target.path, state.target.parent_title].filter(Boolean).join(' › ') })} ·{' '}
            <Link component="button" type="button" onClick={() => setPicking(true)} sx={{ fontSize: 12, verticalAlign: 'baseline' }}>
              {t('chat.mwSave.change')}
            </Link>
          </span>
        )}
      </Box>
      {picking && (
        <TargetDialog
          pod={pod}
          profile={profile}
          initialTitle={defaultTitle(markdown, agent)}
          onClose={() => setPicking(false)}
          onPicked={(target, title, remember) => {
            setPicking(false);
            if (remember) setState({ ...state, target });
            void save(target, title);
          }}
        />
      )}
    </>
  );
}

interface Teamspace {
  id: string;
  name: string;
}
interface PageRow {
  id: string;
  title: string;
  path: string;
}

/** 저장 위치 고르기(리뷰 Design): 팀스페이스 → 검색·부모 페이지 → 새 페이지 제목 → 「이 위치 기억」(기본 켬) */
export function TargetDialog({ pod, profile, initialTitle, noTitle, onClose, onPicked }: { pod: string; profile: string; initialTitle: string; noTitle?: boolean; onClose: () => void; onPicked: (t: SaveTarget, title: string, remember: boolean) => void }) {
  const [teamspaces, setTeamspaces] = useState<Teamspace[] | null>(null);
  const [ts, setTs] = useState('');
  const [search, setSearch] = useState('');
  const [pages, setPages] = useState<PageRow[] | null>(null);
  const [picked, setPicked] = useState<PageRow | null>(null);
  const [title, setTitle] = useState(initialTitle);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    call<{ teamspaces: Teamspace[] }>('GET', `/api/mindwiki/save/teamspaces?${q({ pod, profile })}`)
      .then((r) => {
        setTeamspaces(r.teamspaces);
        if (r.teamspaces.length) setTs(r.teamspaces[0].id);
      })
      .catch((e: unknown) => setError(reasonText(e instanceof SaveFail ? e.reason : 'invalid')));
  }, [pod, profile]);
  useEffect(() => {
    if (!ts && !search) return;
    let live = true;
    setPages(null);
    const h = setTimeout(() => {
      call<{ pages: PageRow[] }>('GET', `/api/mindwiki/save/pages?${q({ pod, profile, ...(search ? { q: search } : { teamspace: ts }) })}`)
        .then((r) => live && setPages(r.pages))
        .catch((e: unknown) => live && setError(reasonText(e instanceof SaveFail ? e.reason : 'invalid')));
    }, search ? 300 : 0);
    return () => {
      live = false;
      clearTimeout(h);
    };
  }, [pod, profile, ts, search]);
  const confirm = async () => {
    if (!picked) return;
    const target: SaveTarget = { teamspace: ts, parent_id: picked.id, parent_title: picked.title, path: picked.path || (teamspaces?.find((x) => x.id === ts)?.name ?? '') };
    if (remember) {
      try {
        await call('PUT', '/api/mindwiki/save/target', { pod, profile, ...target });
        forgetSaveState(pod, profile);
      } catch (e) {
        setError(reasonText(e instanceof SaveFail ? e.reason : 'invalid'));
        return;
      }
    }
    onPicked(target, title.trim() || initialTitle, remember);
  };
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm" aria-labelledby="mw-pick-title">
      <DialogTitle id="mw-pick-title">{t('chat.mwSave.pickTitle')}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, pt: '8px !important' }}>
        {error && <Alert severity="warning">{error}</Alert>}
        {teamspaces === null && !error && <Typography sx={{ fontSize: 13 }}>{t('chat.mwSave.loading')}</Typography>}
        {teamspaces?.length === 0 && <Typography sx={{ fontSize: 13 }}>{t('chat.mwSave.noTeamspace')}</Typography>}
        {!!teamspaces?.length && (
          <TextField select size="small" label={t('chat.mwSave.teamspace')} value={ts} onChange={(e) => setTs(e.target.value)}>
            {teamspaces.map((x) => (
              <MenuItem key={x.id} value={x.id}>
                {x.name}
              </MenuItem>
            ))}
          </TextField>
        )}
        <TextField size="small" label={t('chat.mwSave.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
        <Box role="group" aria-label={t('chat.mwSave.parent')} sx={{ maxHeight: 260, overflowY: 'auto', border: 1, borderColor: 'divider', borderRadius: 1 }}>
          {pages === null && (ts || search) && !error && <Typography sx={{ p: 1.5, fontSize: 13 }}>{t('chat.mwSave.loading')}</Typography>}
          {pages?.length === 0 && <Typography sx={{ p: 1.5, fontSize: 13 }}>{search ? t('chat.mwSave.noMatch') : t('chat.mwSave.noPage')}</Typography>}
          {!!pages?.length && (
            <List dense disablePadding>
              {pages.map((p) => (
                <ListItemButton key={p.id} selected={picked?.id === p.id} onClick={() => setPicked(p)} data-testid="mw-page">
                  <ListItemText primary={p.title} secondary={p.path || undefined} />
                </ListItemButton>
              ))}
            </List>
          )}
        </Box>
        {!noTitle && <TextField size="small" label={t('chat.mwSave.pageTitle')} value={title} onChange={(e) => setTitle(e.target.value)} inputProps={{ maxLength: 200 }} />}
        <FormControlLabel control={<Checkbox checked={remember} onChange={(e) => setRemember(e.target.checked)} />} label={t('chat.mwSave.remember')} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit">
          {t('chat.mwSave.cancel')}
        </Button>
        <Button variant="contained" disabled={!picked || (!noTitle && !title.trim())} onClick={() => void confirm()} data-testid="mw-pick-save">
          {t('chat.mwSave.save')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** 「파일」 서랍의 파일 하나를 그 위치의 「AAS 파일」 페이지에 첨부한다(A4). 크기 한도는 MindWiki 첨부 한도(파일은 흘려 보낸다) */
export function SaveFileToMindwiki({ pod, profile, path, name, sx }: { pod: string; profile: string; path: string; name: string; sx?: object }) {
  const embed = useEmbed();
  const { enqueueSnackbar } = useSnackbar();
  const [state, setState] = useState<SaveState | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    if (embed || !pod || !profile) return;
    let live = true;
    void loadSaveState(pod, profile).then((s) => live && setState(s));
    return () => {
      live = false;
    };
  }, [embed, pod, profile]);
  if (embed || !state || state.hidden) return null;
  const save = async (target: SaveTarget) => {
    setBusy(true);
    try {
      const out = await call<{ url: string; name: string }>('POST', '/api/mindwiki/save/file', { pod, profile, path, parent_id: target.parent_id, key: saveKey('file', path, target.parent_id) });
      enqueueSnackbar(t('chat.mwSave.saved', { title: out.name || name }), { variant: 'success' });
    } catch (e) {
      const reason = e instanceof SaveFail ? e.reason : 'invalid';
      enqueueSnackbar(reasonText(reason), { variant: 'warning' });
      if (reason === 'parent_not_found' || reason === 'forbidden_parent' || reason === 'need_target') setPicking(true);
    } finally {
      setBusy(false);
    }
  };
  const blocked = !state.available;
  return (
    <>
      <Tooltip title={blocked ? reasonText(state.reason) : t('chat.mwSave.button')}>
        <span>
          <IconButton
            aria-label={`${t('chat.mwSave.button')}: ${name}`}
            aria-busy={busy}
            disabled={blocked || busy}
            data-testid="mw-save-file"
            onClick={() => (state.target ? void save(state.target) : setPicking(true))}
            sx={sx}
          >
            {busy ? <CircularProgress size={14} /> : <SaveAltOutlinedIcon sx={{ fontSize: 16 }} />}
          </IconButton>
        </span>
      </Tooltip>
      {picking && (
        <TargetDialog
          pod={pod}
          profile={profile}
          initialTitle={name}
          noTitle
          onClose={() => setPicking(false)}
          onPicked={(target, _title, remember) => {
            setPicking(false);
            if (remember) setState({ ...state, target });
            void save(target);
          }}
        />
      )}
    </>
  );
}
