/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
// 관리자 「스킬 허브에 게시」 서랍과 허브에서 숨기기(스펙 2026-10-29-002 §3-1·§3-2, 디자인 DD3~DD21).
// zip 고르기·스크립트 확인·파일 목록은 작업공간 올리기와 같은 공용 부품(zipParts, DD15)을 쓴다.
import RefreshIcon from '@mui/icons-material/Refresh';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import { Alert, Box, Button, NativeSelect, Stack, TextField, Typography } from '@mui/material';
import { visuallyHidden } from '@mui/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useEffect, useRef, useState } from 'react';

import { KV, Labeled } from '@/components/bits';
import { useConfirm } from '@/components/ConfirmDialog';
import { DrawerAction } from '@/components/DrawerActions';
import { tier1, tier2 } from '@/components/tierButton';
import { useUi } from '@/components/UiContext';
import { ScriptReview, sendZip, ZipDropZone, ZipFile, ZipFileChip, ZipFileList, zipProblem, ZipScript } from '@/components/zipParts';
import { t } from '@/i18n';
import { ApiError, get, post } from '@/lib/api';
import { fmtTs } from '@/lib/format';
import { useNameOfEmail } from '@/lib/people';

export interface HubPreview {
  hash: string;
  name: string;
  description: string;
  files: ZipFile[];
  scripts: ZipScript[];
  hub: { namespace: string; version: string } | null;
  next_version: string;
  changed: { basis: '' | 'bundle' | 'hub' | 'hub_size'; version: string; added: string[]; removed: string[]; changed: string[] } | null;
  refs: { public: string[]; member: string[] };
  installed: number;
  blockers: string[];
  expected_mismatch: string;
  public_namespaces: string[];
}

export interface HiddenRow {
  namespace: string;
  name: string;
  by: string;
  ts: string;
}

interface PublishResult {
  request: { id: string; status: string; message?: string; version: string; namespace: string; name: string };
}

const VER = /^\d+\.\d+\.\d+$/;
const verNum = (v: string) => (VER.test(v) ? v.split('.').map(Number) : [0, 0, 0]);
const newer = (a: string, b: string) => {
  const x = verNum(a);
  const y = verNum(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

/** 「스킬 허브에 게시」 서랍 본문. expected = 「새 판 게시」로 들어온 패키지(ns/name). */
export function HubPublishDrawer({
  spaces,
  labels,
  expected = '',
  onOpenPkg,
  onOpenPub,
}: {
  spaces: string[];
  labels: (ns: string) => string;
  expected?: string;
  onOpenPkg: (ns: string, name: string) => void;
  onOpenPub: () => void;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const { closeDrawer } = useUi();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const pickRef = useRef<HTMLInputElement>(null);
  const verdictRef = useRef<HTMLDivElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [pv, setPv] = useState<HubPreview | null>(null);
  const [ns, setNs] = useState(spaces[0] ?? 'free');
  const [version, setVersion] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [phase, setPhase] = useState<'' | 'checking' | 'publishing'>('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState<'' | 'inspect' | 'submit'>('');
  const [unknown, setUnknown] = useState(false);
  const [pending, setPending] = useState(false);
  const publishingRef = useRef(false);
  publishingRef.current = phase === 'publishing';

  // 게시 중에 서랍을 닫아도 게시는 계속된다(DD7)
  useEffect(
    () => () => {
      if (publishingRef.current) enqueueSnackbar(t('market.hub.keepsGoing'), { variant: 'info' });
    },
    [enqueueSnackbar],
  );
  useEffect(() => {
    if (pv) verdictRef.current?.focus(); // 미리 보기가 나오면 판정 줄로(DD17)
  }, [pv]);

  const inspect = async (f: File) => {
    setPhase('checking');
    setError('');
    setRetry('');
    setUnknown(false);
    setPending(false);
    try {
      const r = await sendZip<HubPreview>(`/api/market/publish/upload?expected=${encodeURIComponent(expected)}`, f);
      setPv(r);
      setVersion(r.next_version);
      if (r.hub) setNs(r.hub.namespace);
      setConfirmed(false);
    } catch (e) {
      setPv(null);
      setError((e as Error).message);
    } finally {
      setPhase('');
    }
  };
  const pick = (f: File | undefined) => {
    if (!f) return;
    setPv(null);
    const problem = zipProblem(f);
    if (problem) {
      setFile(null);
      setError(problem);
      return;
    }
    setFile(f);
    void inspect(f);
  };
  const clear = () => {
    setFile(null);
    setPv(null);
    setError('');
  };

  const isPublic = !!pv && pv.public_namespaces.includes(ns);
  const refs = pv ? (isPublic ? pv.refs.public : pv.refs.member) : [];
  const verError = !version ? '' : !VER.test(version) ? t('market.hub.versionFormat') : pv?.hub && !newer(version, pv.hub.version) ? t('market.hub.versionLow', { hub: pv.hub.version }) : '';
  const busy = phase !== '';
  const canPublish = !!pv && !busy && !pv.blockers.length && !!version && !verError && (!isPublic || !refs.length) && (!pv.scripts.length || confirmed);

  const submit = async () => {
    if (!pv) return;
    const nsLabel = labels(ns);
    if (!(await confirm(t('market.hub.confirm', { name: pv.name, version, ns: nsLabel, n: pv.scripts.length })))) return;
    setPhase('publishing');
    setError('');
    setRetry('');
    setUnknown(false);
    setPending(false);
    try {
      const r = await post<PublishResult>('/api/market/publish/direct', { hash: pv.hash, namespace: ns, version, confirm_scripts: confirmed });
      await qc.invalidateQueries({ queryKey: ['market'] });
      const st = r.request.status;
      if (st === 'published') {
        publishingRef.current = false;
        closeDrawer();
        enqueueSnackbar(t('market.hub.published', { version }), {
          variant: 'success',
          action: () => (
            <Button color="inherit" size="small" onClick={() => onOpenPkg(r.request.namespace, r.request.name)}>
              {t('market.hub.openPkg')}
            </Button>
          ),
        });
      } else if (st === 'pending_review') {
        setPending(true);
      } else {
        setError(t('market.hub.failed', { reason: r.request.message || '' }));
        setRetry('submit');
      }
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 409) {
        setError(err.message);
        if (file) void inspect(file); // 허브 판이 올랐을 수 있다 — 다음 판·바뀐 파일을 다시 계산한다(R2)
      } else if (err.status === 410) {
        setError(err.message);
        setRetry('inspect'); // 미리 보기 만료: 같은 파일을 다시 올린다(DR9)
      } else if (err.status === 400 || err.status === 403) {
        setError(err.message);
      } else {
        setUnknown(true); // 연결이 끊김·시간 초과 — 실패가 아니라 결과를 모른다(DD7)
      }
    } finally {
      setPhase('');
    }
  };

  const changed = pv?.changed;
  const nChanged = changed ? changed.added.length + changed.removed.length + changed.changed.length : 0;
  return (
    <Stack spacing={1.5}>
      <Box role="status" aria-live="polite" sx={visuallyHidden}>
        {phase === 'checking' ? t('skills.zipChecking') : phase === 'publishing' ? t('market.hub.publishing') : pending ? t('market.hub.pending') : ''}
      </Box>
      <ZipDropZone show={!pv} busy={busy} onPick={pick} pickRef={pickRef} sub={t('market.hub.dropSub')} />
      {file && <ZipFileChip file={file} checking={phase === 'checking'} busy={busy} onReplace={() => pickRef.current?.click()} onRemove={clear} />}
      {pv && (
        <Box ref={verdictRef} tabIndex={-1} sx={{ outline: 'none' }}>
          <Typography variant="subtitle2">
            {pv.hub ? t('market.hub.newVersion', { ns: labels(pv.hub.namespace), name: pv.name, from: pv.hub.version, to: version || '?' }) : t('market.hub.newSkill', { name: pv.name })}
          </Typography>
          {pv.expected_mismatch && <Alert severity="warning" sx={{ mt: 1 }}>{t('market.hub.expectedMismatch', { expected: pv.expected_mismatch, name: pv.name })}</Alert>}
          {pv.blockers.map((b) => (
            <Alert key={b} severity="error" role="alert" sx={{ mt: 1 }}>
              {b}
            </Alert>
          ))}
        </Box>
      )}
      {error && (
        <Alert severity="error" role="alert" action={retry && file ? <Button startIcon={<RefreshIcon />} color="inherit" size="small" onClick={() => void (retry === 'inspect' ? inspect(file) : submit())}>{t('skills.zipRetry')}</Button> : undefined}>
          {error}
        </Alert>
      )}
      {unknown && (
        <Alert severity="warning" action={<Button color="inherit" size="small" onClick={onOpenPub}>{t('market.hub.openPub')}</Button>}>
          {t('market.hub.unknown')}
        </Alert>
      )}
      {pending && (
        <Alert severity="warning" action={<Button color="inherit" size="small" onClick={onOpenPub}>{t('market.hub.openPub')}</Button>}>
          {t('market.hub.pending')}
        </Alert>
      )}
      {pv && (
        <Stack spacing={1.5}>
          {pv.description && <Typography variant="body2">{pv.description}</Typography>}
          <ScriptReview scripts={pv.scripts} confirmed={confirmed} onConfirm={setConfirmed} />
          {refs.length > 0 && (
            <Alert severity={isPublic ? 'error' : 'warning'}>{isPublic ? t('market.hub.refsPublic', { ns: labels(ns), list: refs.join(', ') }) : t('market.hub.refsMember', { list: refs.join(', ') })}</Alert>
          )}
          {changed && changed.basis && (
            <Box>
              <Typography variant="body2">{t('market.hub.changed', { a: changed.added.length, r: changed.removed.length, c: changed.changed.length })}</Typography>
              <Typography variant="caption" color="text.secondary" component="div">
                {t(`market.hub.basis.${changed.basis}` as Parameters<typeof t>[0])}
              </Typography>
              {nChanged === 0 && <Alert severity="warning" sx={{ mt: 0.5 }}>{t('market.hub.noChange', { basis: t(`market.hub.basis.${changed.basis}` as Parameters<typeof t>[0]) })}</Alert>}
              {nChanged > 0 && (
                <Box component="ul" sx={{ m: 0, pl: 2.5, fontSize: 13 }}>
                  {changed.added.map((f) => <li key={'a' + f}>{`+ ${f}`}</li>)}
                  {changed.removed.map((f) => <li key={'r' + f}>{`− ${f}`}</li>)}
                  {changed.changed.map((f) => <li key={'c' + f}>{`~ ${f}`}</li>)}
                </Box>
              )}
            </Box>
          )}
          {pv.hub && pv.installed > 0 && <Typography variant="caption" color="text.secondary">{t('market.hub.installed', { n: pv.installed })}</Typography>}
          <ZipFileList key={pv.hash} files={pv.files} scripts={pv.scripts} />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'flex-start' }}>
            {!pv.hub && (
              <Labeled label={t('market.category')}>
                <NativeSelect value={ns} onChange={(e) => setNs(e.target.value)} inputProps={{ 'aria-label': t('market.category') }}>
                  {spaces.map((n) => (
                    <option key={n} value={n}>
                      {labels(n)}
                    </option>
                  ))}
                </NativeSelect>
              </Labeled>
            )}
            <TextField
              size="small"
              label={t('market.hub.version')}
              value={version}
              onChange={(e) => setVersion(e.target.value.trim())}
              error={!!verError}
              helperText={verError || t('market.hub.versionHelp')}
              slotProps={{ htmlInput: { spellCheck: false, inputMode: 'decimal' } }}
            />
          </Stack>
          <Box sx={{ position: { xs: 'sticky', sm: 'static' }, bottom: 0, bgcolor: 'background.paper', py: { xs: 1, sm: 0 } }}>
            <Button variant="outlined" color="inherit" sx={{ ...tier1, width: { xs: '100%', sm: 'auto' }, minHeight: 44 }} disabled={!canPublish} onClick={() => void submit()}>
              {phase === 'publishing' ? t('market.hub.publishing') : t('market.hub.submit')}
            </Button>
          </Box>
        </Stack>
      )}
    </Stack>
  );
}

/** 패키지 서랍 머리의 관리자 동작: 새 판 게시·허브에서 숨기기(DD4·DD16). 허용(grant) 단추와 한 배열로 합친다. */
export function useHubPackageActions({
  admin,
  namespace,
  name,
  openPublish,
  onHidden,
}: {
  admin: boolean;
  namespace: string;
  name: string;
  openPublish: (expected: string) => void;
  onHidden: () => void;
}): DrawerAction[] {
  const { enqueueSnackbar } = useSnackbar();
  const info = useQuery({
    queryKey: ['market', 'hub', 'installed', namespace, name],
    queryFn: () => get<{ count: number; builtin: boolean }>(`/api/market/hub/installed?${new URLSearchParams({ namespace, name })}`),
    enabled: admin,
  });
  if (!admin) return [];
  const builtin = info.data?.builtin ? t('market.hub.builtin') : undefined;
  const show = async () => {
    try {
      await post('/api/market/hub/show', { namespace, name });
      enqueueSnackbar(t('market.hub.shown'), { variant: 'success' });
      onHidden();
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    }
  };
  const hide = async () => {
    try {
      await post('/api/market/hub/hide', { namespace, name });
      enqueueSnackbar(t('market.hub.hidden'), {
        variant: 'success',
        action: () => (
          <Button color="inherit" size="small" onClick={() => void show()}>
            {t('market.hub.undo')}
          </Button>
        ),
      });
      onHidden();
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    }
  };
  return [
    { id: 'hub-new', label: t('market.hub.publishNew'), description: t('market.hub.newVersionNote'), icon: RefreshIcon, disabled: builtin, onClick: () => openPublish(`${namespace}/${name}`) },
    {
      id: 'hub-hide',
      label: t('market.hub.hide'),
      description: t('market.hub.hideNote'),
      icon: VisibilityOffOutlinedIcon,
      disabled: builtin,
      confirm: { message: t('market.hub.hideConfirm', { name, n: info.data?.count ?? 0 }), okLabel: t('market.hub.hide'), onConfirm: hide },
      danger: true,
    },
  ];
}

/** 「허브에서 숨김」 탭의 한 줄 서랍: 누가·언제 숨겼는지와 「다시 보이기」. */
export function HiddenBody({ r, onDone }: { r: HiddenRow; onDone: () => void }) {
  const nameOf = useNameOfEmail();
  const { enqueueSnackbar } = useSnackbar();
  const [busy, setBusy] = useState(false);
  const show = async () => {
    setBusy(true);
    try {
      await post('/api/market/hub/show', { namespace: r.namespace, name: r.name });
      enqueueSnackbar(t('market.hub.shown'), { variant: 'success' });
      onDone();
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack spacing={1.5}>
      <KV
        pairs={[
          [t('market.hub.hiddenBy'), nameOf(r.by) ?? r.by],
          [t('market.hub.hiddenTs'), fmtTs(r.ts)],
        ]}
      />
      <Typography variant="caption" color="text.secondary">
        {t('market.hub.hiddenNote')}
      </Typography>
      <Box>
        <Button variant="outlined" color="inherit" startIcon={<VisibilityOutlinedIcon />} sx={tier2} disabled={busy} onClick={() => void show()}>
          {t('market.hub.show')}
        </Button>
      </Box>
    </Stack>
  );
}
