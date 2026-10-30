/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 「PC 에서 가져오기」 서랍(OMAI-1136, 스펙 import-local-hermes-into-main §10-2·§10-4·§10-6).
// ① 내보내고 올리기 → ② 확인 → ③ 가져오는 중 → ④ 결과. 거절·실패는 ① 이나 결과 자리에 따로 그린다.
// 어느 화면을 그릴지는 서버의 마지막 가져오기(GET pc-import)로 정한다 — 서랍을 닫았다 다시 열거나 다른 관리자가 열어도 같은 화면이다(D6).
// 진행 중에는 2.5초마다 다시 읽고 끝나면 멈춘다(usePcImport). 단계가 바뀌면 단계 제목에 커서를 옮긴다(D14).
// main 이 아닌 프로파일도 대상이다(OMAI-1444). 문장의 대상 이름은 「{name} 프로파일」로 쓴다(DD12). 같은 AI 에이전트 작업공간의
// 다른 프로파일이 가져오는 중이면(busy_profile) 서랍 위에 알리고 놓기·시작을 막는다(DD6).
import CheckIcon from '@mui/icons-material/Check';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FileUploadOutlinedIcon from '@mui/icons-material/FileUploadOutlined';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import RefreshIcon from '@mui/icons-material/Refresh';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  CircularProgress,
  LinearProgress,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { visuallyHidden } from '@mui/utils';
import { useQueryClient } from '@tanstack/react-query';
import { DragEvent, ReactNode, useEffect, useId, useRef, useState } from 'react';

import { LinkChip, Tag } from '@/components/bits';
import { DisclosureButton } from '@/components/DisclosureButton';
import { tier1, tier2, tier3 } from '@/components/tierButton';
import { useUi } from '@/components/UiContext';
import { RequestAdminButton } from '@/features/requests/RequestAdminButton';
import { t, type Vars } from '@/i18n';
import { humanSize, MAX_SIZE } from '@/lib/chatFiles';
import { fmtTs } from '@/lib/format';
import { MONO_FONT } from '@/lib/monoFont';

import { CommandLine, OsTabs, Steps, tall } from './PcCommand';
import {
  archiveName,
  breakable,
  cancelImport,
  detectOs,
  exportCommand,
  findCommands,
  hasSecretStages,
  isArchive,
  type Job,
  mb,
  namesLine,
  type Os,
  outputPath,
  PcError,
  pcImportKey,
  pcProfile,
  rejectKind,
  repackCommand,
  type RowState,
  secretsMode,
  secretsTodo,
  shortName,
  stageLabels,
  stageName,
  stageRows,
  startImport,
  type StatusResp,
  uploadArchive,
  usePcImport,
} from './pcImportApi';

type View = 'upload' | 'rejected' | 'confirm' | 'running' | 'done' | 'failed';

/** 서버의 마지막 가져오기 → 그릴 화면. 사용자가 「다른 묶음 올리기」·「다시 시도」·「뒤로」를 누르면 upload 로 돌린다 */
export function viewOf(job: Job | null, forceUpload: boolean): View {
  if (forceUpload || !job || job.state === 'cancelled') return 'upload';
  if (job.state === 'rejected') return 'rejected';
  if (job.state === 'uploaded') return 'confirm';
  if (job.state === 'running') return 'running';
  if (job.state === 'done') return 'done';
  return 'failed';
}

const stepKey: Record<View, string> = {
  upload: 'profiles.pcImport.stepUpload',
  rejected: 'profiles.pcImport.stepUpload',
  confirm: 'profiles.pcImport.stepConfirm',
  running: 'profiles.pcImport.stepRunning',
  done: 'profiles.pcImport.stepResult',
  failed: 'profiles.pcImport.stepResult',
};

/** 문장 안 {slot} 자리에 요소(굵은 이름·링크 칩)를 넣는다(OMAI-1444 DD2·DD6). 언어마다 자리가 달라 번역한 문장을 나눠 그린다 */
function withSlot(key: string, vars: Vars, slot: string, node: ReactNode): ReactNode {
  const mark = '\u0000';
  const [a, b = ''] = t(key, { ...vars, [slot]: mark }).split(mark);
  return (
    <>
      {a}
      {node}
      {b}
    </>
  );
}

/** 다른 프로파일이 가져오는 중이라는 안내(OMAI-1444 DD6). 이름은 그 프로파일 서랍을 여는 링크 칩 */
function BusyOther({ name }: { name: string }) {
  return (
    <Alert severity="info" role="status">
      {withSlot('profiles.pcImport.busyOther', {}, 'name', <LinkChip to="profiles" params={{ name }}>{name}</LinkChip>)}
    </Alert>
  );
}

/** 오류 한 칸. 프로파일이 없으면 「서랍 닫기」, AI 에이전트 작업공간이 응답하지 않으면 「다시 하기」(OMAI-1444 DD9) */
function ErrAlert({ err, onRetry }: { err: PcError; onRetry?: () => void }) {
  const { closeDrawer } = useUi();
  const action =
    err.code === 'no_profile' ? (
      <Button color="inherit" size="small" onClick={() => void closeDrawer()}>
        {t('profiles.pcImport.closeDrawer')}
      </Button>
    ) : err.code === 'agent_unreachable' && onRetry ? (
      <Button color="inherit" size="small" onClick={onRetry}>
        {t('profiles.pcImport.again')}
      </Button>
    ) : undefined;
  return (
    <Alert severity={err.status === 409 || err.status === 429 ? 'warning' : 'error'} role="status" action={action}>
      {err.message}
    </Alert>
  );
}

export function PcImport({
  pod,
  profile,
  main = true,
  mcpLogins,
  onStep,
}: {
  pod?: string;
  /** 가져올 프로파일 이름(main 이 아니어도 된다, OMAI-1444) */
  profile: string;
  /** 대상이 main 인가. 아니면 「PC 에서 내보낼 프로파일」 칸을 대상 이름으로 미리 채운다(DD14) */
  main?: boolean;
  /** 그대로 남는 MCP 로그인 수(OAuth MCP 서버 수) */
  mcpLogins: number;
  /** 단계가 바뀌면 서랍 부제목을 바꾼다(D12) */
  onStep?: (label: string) => void;
}) {
  const qc = useQueryClient();
  const st = usePcImport(pod, profile, true);
  const [forceUpload, setForceUpload] = useState(false);
  // 올리기 전에 화면이 거른 크기 초과, 또는 서버가 413 으로 거절한 것(묶음 기록이 남지 않는다)
  const [localReject, setLocalReject] = useState<{ reason: string; file: string } | null>(null);
  const job = st.data?.job ?? null;
  const view: View = localReject ? 'rejected' : viewOf(job, forceUpload);
  const label = t(stepKey[view]);
  const heading = useRef<HTMLHeadingElement>(null);
  const prevState = useRef(job?.state);
  // 같은 AI 에이전트 작업공간의 다른 프로파일이 가져오는 중(DD6). 풀리면 「이제 가져올 수 있습니다」를 읽는다
  const busyOther = st.data?.busy_profile && st.data.busy_profile !== profile ? st.data.busy_profile : '';
  const wasBusy = useRef(busyOther);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (wasBusy.current && !busyOther) setReady(true);
    if (busyOther) setReady(false);
    wasBusy.current = busyOther;
  }, [busyOther]);

  useEffect(() => {
    onStep?.(label);
    heading.current?.focus();
    // onStep 은 서랍을 열 때 한 번 만든 함수다. 단계 이름이 바뀔 때만 부른다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label]);

  // 진행이 끝나면 프로파일 상세(「확인할 것」·크론 등)를 다시 읽는다
  useEffect(() => {
    if (prevState.current === 'running' && job && job.state !== 'running') {
      void qc.invalidateQueries({ queryKey: ['profile', profile] });
      void qc.invalidateQueries({ queryKey: ['profiles'] });
    }
    prevState.current = job?.state;
  }, [job, profile, qc]);

  const setJob = (next: Job) =>
    qc.setQueryData<StatusResp>(pcImportKey(pod, profile), (old) => ({ profile, owner: old?.owner ?? '', ...old, job: next }));
  const toUpload = () => {
    setLocalReject(null);
    setForceUpload(true);
  };
  // 올리기·시작이 409 busy_import 로 거절됐다. 다른 프로파일 이름이 오면 상태 응답을 기다리지 않고 먼저 막는다(R3)
  const onBusy = (other?: string) => {
    if (other && other !== profile)
      qc.setQueryData<StatusResp>(pcImportKey(pod, profile), (old) => (old ? { ...old, busy_profile: other } : old));
    void st.refetch();
  };

  let body: ReactNode;
  if (st.isLoading) body = <LinearProgress aria-label={t('profiles.loading')} />;
  else if (st.error && !st.data) body = <ErrAlert err={st.error} onRetry={() => void st.refetch()} />;
  else if (view === 'upload')
    body = (
      <UploadStep
        pod={pod ?? ''}
        profile={profile}
        main={main}
        blocked={busyOther}
        onUploaded={(j) => {
          setJob(j);
          setForceUpload(false);
        }}
        onReject={(reason, file) => setLocalReject({ reason, file })}
        onBusy={(other) => {
          setForceUpload(false);
          onBusy(other);
        }}
      />
    );
  else if (view === 'rejected')
    body = (
      <Rejected
        profile={profile}
        reason={localReject?.reason ?? job?.summary?.reason ?? job?.reason ?? ''}
        file={localReject?.file ?? job?.name ?? archiveName('default')}
        topNames={localReject ? [] : (job?.summary?.top_names ?? [])}
        onAgain={toUpload}
      />
    );
  else if (view === 'confirm' && job)
    body = (
      <Confirm
        pod={pod ?? ''}
        job={job}
        profile={profile}
        main={main}
        busyOther={busyOther}
        mcpLogins={mcpLogins}
        onBack={() => {
          void cancelImport(pod ?? '', job.id).catch(() => undefined);
          toUpload();
        }}
        onStarted={(j) => {
          setJob(j);
          setForceUpload(false);
          void qc.invalidateQueries({ queryKey: ['profiles'] });          // 목록 줄의 「가져오는 중」(ROV11)
        }}
        onBusy={onBusy}
      />
    );
  else if (view === 'running' && job) body = <Running job={job} />;
  else if (view === 'done' && job) body = <Result job={job} profile={profile} onAgain={toUpload} />;
  else if (job) body = <Failed job={job} profile={profile} onRetry={toUpload} />;

  return (
    <Stack spacing={2} sx={{ containerType: 'inline-size' }}>
      {/* 서랍 위(단계 제목 앞) 안내. 확인 단계에서는 단추 위에 한 번 더 둔다(DD6) */}
      {busyOther && view !== 'running' && <BusyOther name={busyOther} />}
      <Typography ref={heading} component="h2" variant="subtitle1" tabIndex={-1} sx={{ fontWeight: 600, outline: 'none' }}>
        {label}
      </Typography>
      {body}
      <Box role="status" aria-live="polite" sx={visuallyHidden}>
        {ready ? t('profiles.pcImport.nowReady') : ''}
      </Box>
    </Stack>
  );
}

// ---- ① 내보내고 올리기 -------------------------------------------------------------------------------------
function UploadStep({
  pod,
  profile,
  main,
  blocked,
  onUploaded,
  onReject,
  onBusy,
}: {
  pod: string;
  profile: string;
  main: boolean;
  /** 가져오는 중인 다른 프로파일 이름. 있으면 놓기·고르기를 막는다(DD6) */
  blocked: string;
  onUploaded: (j: Job) => void;
  onReject: (reason: string, file: string) => void;
  onBusy: (other?: string) => void;
}) {
  const [os, setOs] = useState<Os>(() => detectOs());
  // main 이 아니면 PC 에도 같은 이름이 있으리라 보고 대상 이름으로 채운다(DD14). 없으면 사용자가 고친다
  const [raw, setRaw] = useState(main ? 'default' : profile);
  const [drag, setDrag] = useState(false);
  const [wrongType, setWrongType] = useState(false);
  const [prog, setProg] = useState<{ loaded: number; total: number } | null>(null);
  const [err, setErr] = useState<PcError | null>(null);
  const abort = useRef<(() => void) | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const last = useRef<File | null>(null);
  const whyId = useId();
  const name = pcProfile(raw);

  const send = (file: File) => {
    setErr(null);
    setWrongType(false);
    if (blocked) return;
    if (!isArchive(file.name)) return setWrongType(true);
    if (file.size === 0) return setErr(new PcError('empty', 400));
    if (file.size > MAX_SIZE) return onReject('too_big', file.name);
    last.current = file;
    setProg({ loaded: 0, total: file.size });
    const h = uploadArchive(pod, profile, file, (loaded, total) => setProg({ loaded, total }));
    abort.current = h.abort;
    h.done
      .then((j) => onUploaded(j))
      .catch((e: PcError) => {
        if (e.code === 'too_big') return onReject('too_big', file.name);
        if (e.code === 'busy_import') return onBusy(typeof e.extra.profile === 'string' ? e.extra.profile : undefined);
        if (e.code !== 'aborted') setErr(e);
      })
      .finally(() => {
        abort.current = null;
        setProg(null);
      });
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer?.files?.[0];
    if (f && !prog) send(f);
  };
  const pct = prog && prog.total ? Math.round((prog.loaded / prog.total) * 100) : 0;

  return (
    <Stack spacing={1.5}>
      <OsTabs value={os} onChange={setOs} />
      <TextField
        size="small"
        label={t('profiles.pcImport.profileLabel')}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        slotProps={{ htmlInput: { spellCheck: false, autoComplete: 'off' } }}
        sx={{ maxWidth: 320 }}
      />
      <CommandLine cmd={exportCommand(os, name)} />
      <Typography variant="body2" color="text.secondary">
        {t('profiles.pcImport.fileWillBe', { name: outputPath(os, name) })}
      </Typography>
      <Accordion disableGutters variant="outlined" sx={{ '&:before': { display: 'none' } }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography variant="body2">{t('profiles.pcImport.noHermes')}</Typography>
        </AccordionSummary>
        <AccordionDetails>
          <Typography variant="body2" color="text.secondary">
            {t('profiles.pcImport.noHermesBody')}
          </Typography>
        </AccordionDetails>
      </Accordion>
      <Box
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        data-testid="pc-drop"
        sx={{
          border: '1px dashed',
          borderColor: drag ? 'text.primary' : 'divider',
          bgcolor: drag ? 'action.hover' : 'transparent',
          borderRadius: 1,
          p: 2,
          textAlign: 'center',
        }}
      >
        {prog ? (
          <Stack spacing={1} alignItems="stretch">
            <LinearProgress
              variant="determinate"
              value={pct}
              aria-label={t('profiles.pcImport.uploadAria')}
              sx={{ height: 4, bgcolor: 'divider', '& .MuiLinearProgress-bar': { bgcolor: 'text.primary' } }}
            />
            <Stack direction="row" alignItems="center" justifyContent="space-between">
              <Typography variant="body2" sx={{ fontFamily: MONO_FONT, fontSize: 12 }}>
                {`${mb(prog.loaded)} / ${mb(prog.total)}`}
              </Typography>
              <Button variant="outlined" color="inherit" sx={tall(tier2)} onClick={() => abort.current?.()}>
                {t('common.cancel')}
              </Button>
            </Stack>
          </Stack>
        ) : (
          <Stack direction="row" spacing={1} alignItems="center" justifyContent="center" useFlexGap flexWrap="wrap">
            <Typography variant="body2">{t('profiles.pcImport.drop', { name: archiveName(name) })}</Typography>
            {/* 막혀도 Tab 으로 닿고 이유를 읽는다(disabled 가 아니라 aria-disabled, DD6) */}
            <Button
              variant="outlined"
              color="inherit"
              sx={tall(tier1)}
              startIcon={<FileUploadOutlinedIcon />}
              aria-disabled={blocked ? true : undefined}
              aria-describedby={blocked ? whyId : undefined}
              onClick={() => !blocked && input.current?.click()}
            >
              {t('profiles.pcImport.pick')}
            </Button>
            {blocked && (
              <Box component="span" id={whyId} sx={visuallyHidden}>
                {t('profiles.pcImport.busyOtherWhy')}
              </Box>
            )}
            <input
              ref={input}
              type="file"
              accept=".tar.gz,.tgz"
              hidden
              data-testid="pc-file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) send(f);
              }}
            />
          </Stack>
        )}
      </Box>
      {wrongType && (
        <Alert severity="warning" role="status">
          {t('profiles.pcImport.wrongType')}
        </Alert>
      )}
      {err && <ErrAlert err={err} onRetry={last.current ? () => last.current && send(last.current) : undefined} />}
    </Stack>
  );
}

// ---- 거절 ---------------------------------------------------------------------------------------------------
function Rejected({
  profile,
  reason,
  file,
  topNames,
  onAgain,
}: {
  profile: string;
  reason: string;
  file: string;
  topNames: string[];
  onAgain: () => void;
}) {
  const kind = rejectKind(reason);
  const [os, setOs] = useState<Os>(() => detectOs());
  return (
    <Stack spacing={1.5}>
      <Alert severity="warning" role="status">
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {t('profiles.pcImport.rejected', { name: profile })}
        </Typography>
        <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
          {t(`profiles.pcImport.reject.${kind}`, { names: topNames.slice(0, 3).join(' · ') })}
        </Typography>
      </Alert>
      {kind === 'size' && (
        <>
          <OsTabs value={os} onChange={setOs} />
          <CommandLine cmd={repackCommand(os, file)} />
          <Typography variant="caption" color="text.secondary">
            {t('profiles.pcImport.reject.sizeNote')}
          </Typography>
          <Box>
            <RequestAdminButton
              profile={profile}
              kind="other"
              label={t('profiles.pcImport.askLimit')}
              detail={t('profiles.pcImport.askLimitDetail')}
            />
          </Box>
        </>
      )}
      <Box>
        <Button variant="outlined" color="inherit" sx={tall(tier1)} startIcon={<FileUploadOutlinedIcon />} onClick={onAgain}>
          {t('profiles.pcImport.uploadAnother')}
        </Button>
      </Box>
    </Stack>
  );
}

// ---- ② 확인 -------------------------------------------------------------------------------------------------
function ListBlock({ id, title, items }: { id: string; title: string; items: ReactNode[] }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography id={id} variant="subtitle2" component="h3" sx={{ mb: 0.5 }}>
        {title}
      </Typography>
      <Box component="ul" aria-labelledby={id} sx={{ m: 0, pl: 2.5 }}>
        {items.filter(Boolean).map((x, i) => (
          <Typography key={i} component="li" variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            {x}
          </Typography>
        ))}
      </Box>
    </Box>
  );
}

/** 이름 목록 한 줄(DD21·DD22): 처음 3개, 「외 N개」를 누르면 모두. total 은 개수 필드 */
export function Names({ names, total }: { names: string[]; total: number }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const l = namesLine(names, total, open);
  if (!names.length && !total) return null;
  const toggle = l.more > 0 || (open && names.length > 3);
  return (
    <Typography component="span" variant="caption" sx={{ display: 'block', fontFamily: MONO_FONT, fontSize: 12, overflowWrap: 'anywhere' }}>
      <span id={id}>{l.shown.map(breakable).join(' · ')}</span>
      {l.omitted > 0 && ` · ${t('profiles.pcImport.namesOmitted', { n: l.omitted })}`}
      {toggle && (
        <>
          {' '}
          <DisclosureButton
            open={open}
            onToggle={() => setOpen(!open)}
            controls={id}
            label={open ? t('profiles.pcImport.namesLess') : t('profiles.pcImport.namesMore', { n: l.more })}
            sx={{ fontSize: 12, py: 0, minHeight: 0, verticalAlign: 'baseline' }}
          />
        </>
      )}
    </Typography>
  );
}

/** 인증 파일 수에서 옮기지 않는 채널 연결 파일을 뺀다(DD3). 서버가 이미 뺐으면 겹치는 이름이 없어 그대로다 */
export function secretFileCount(sec: { files: string[]; files_count: number } | undefined, skipped: string[]): number {
  if (!sec) return 0;
  const hit = (sec.files ?? []).filter((f) => skipped.some((x) => f === x || f.startsWith(`${x}/`))).length;
  return Math.max(0, (sec.files_count ?? 0) - hit);
}

function Confirm({
  pod,
  job,
  profile,
  main,
  busyOther,
  mcpLogins,
  onBack,
  onStarted,
  onBusy,
}: {
  pod: string;
  job: Job;
  profile: string;
  main: boolean;
  /** 가져오는 중인 다른 프로파일. 있으면 「{name} 내용 바꾸기」를 막는다(DD6) */
  busyOther: string;
  mcpLogins: number;
  onBack: () => void;
  onStarted: (j: Job) => void;
  onBusy: (other?: string) => void;
}) {
  const { closeDrawer } = useUi();
  const whyId = useId();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<PcError | null>(null);
  const s = job.summary;
  const c = s?.counts ?? { skills: 0, cron: 0, sessions: 0, memories: 0, soul: false };
  const keeps = { env: 0, channels: [], shared_with: [], ...job.keeps };   // 빈 keeps({})·저장 전 기록에도 화면이 그려지게(커밋 전 리뷰 1)
  const sec = s?.secrets;
  const dropped = s?.dropped;
  const plan = keeps.secrets_plan;
  const mode = secretsMode(job);
  const moving = mode === 'move' || mode === 'unknown';
  // main 이 아닌 대상은 채널 연결 파일을 옮기지 않는다(DD3·R8). main 은 서버가 이 칸을 보내지 않는다
  const skippedChannels = main ? [] : (s?.channel_files_skipped ?? []);
  const files = secretFileCount(sec, skippedChannels);
  const mcpMoved = moving && (sec?.mcp_files ?? 0) > 0;
  const channelMoved = moving && (sec?.channel_files ?? 0) > 0;   // 서버는 건너뛴 채널을 이 수에 넣지 않는다 — 실제로 옮기는 채널(예: Google Chat)은 보인다(리뷰 3)
  const others = keeps.others ?? [];
  const filtered = !!dropped && dropped.links + dropped.credential + dropped.other + dropped.secrets_off > 0;
  const shrink = keeps.skills_main != null && c.skills < keeps.skills_main;
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await startImport(pod, job.id);
      onStarted(r.job);
    } catch (e) {
      const pe = e as PcError;
      setErr(pe);
      setBusy(false);
      if (pe.code === 'busy_import' || pe.code === 'not_ready') onBusy(typeof pe.extra.profile === 'string' ? pe.extra.profile : undefined);
    }
  };
  const cancel = () => {
    void cancelImport(pod, job.id).catch(() => undefined);
    void closeDrawer();
  };
  const skills =
    keeps.skills_main != null ? (
      <>
        {t('profiles.pcImport.skillsChange', { a: keeps.skills_main, b: c.skills })}
        {shrink && (
          <>
            {' '}
            <WarningAmberIcon fontSize="inherit" sx={{ color: 'warning.main', verticalAlign: 'text-bottom' }} aria-hidden />
            <Typography component="span" variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              {t('profiles.pcImport.skillsShrink', { name: profile })}
            </Typography>
          </>
        )}
      </>
    ) : (
      t('profiles.pcImport.changeSkills', { n: c.skills })
    );
  const blocked = [...(plan?.env_blocked ?? []), ...(sec?.env_unreadable ?? [])];
  const short = shortName(profile);
  const replaceFull = t('profiles.pcImport.replace', { name: profile });
  return (
    <Stack spacing={1.5}>
      {/* 첫 낱말을 굵은 대상 이름으로(DD2) */}
      <Alert severity="warning">
        {withSlot(
          moving && files > 0 ? 'profiles.pcImport.replaceNoteSecrets' : 'profiles.pcImport.replaceNote',
          { n: files },
          'name',
          <Box component="strong" sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
            {profile}
          </Box>
        )}
      </Alert>
      {job.by_admin && <Alert severity="info">{t('profiles.pcImport.ownerNote', { name: job.owner_name || job.owner })}</Alert>}
      <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
        <Typography component="span" variant="body2" sx={{ fontFamily: MONO_FONT, wordBreak: 'break-all' }}>
          {job.name}
        </Typography>
        <Typography component="span" variant="body2" color="text.secondary">
          {filtered ? t('profiles.pcImport.bundleKept', { size: humanSize(job.size), kept: humanSize(s?.kept_size ?? 0) }) : humanSize(job.size)}
        </Typography>
        {filtered ? <Tag>{t('profiles.pcImport.bundleFiltered')}</Tag> : <Tag tone="good">{t('profiles.pcImport.checked')}</Tag>}
      </Stack>
      {/* 서랍 폭이 600px 미만이면 위아래로 쌓는다(D15). 서랍 폭은 화면 폭과 달라 컨테이너 질의로 본다 */}
      <Box
        data-testid="pc-columns"
        sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2, '@container (max-width: 599px)': { gridTemplateColumns: '1fr' } }}
      >
        <ListBlock
          id="pc-changes"
          title={t('profiles.pcImport.changes')}
          items={[
            t('profiles.pcImport.changeFiles'),
            t('profiles.pcImport.changeMemories', { n: c.memories }),
            skills,
            t('profiles.pcImport.cronPaused', { n: c.cron }),
            t('profiles.pcImport.changeSessions', { n: c.sessions }),
          ]}
        />
        <ListBlock
          id="pc-keeps"
          title={t('profiles.pcImport.keeps')}
          items={[
            t('profiles.pcImport.keepEnvAdd', { n: keeps.env, name: profile }),
            !mcpMoved && t('profiles.pcImport.keepMcp', { n: mcpLogins }),
            !channelMoved &&
              (keeps.channels.length ? t('profiles.pcImport.keepChannelsOf', { name: keeps.channels.join(', ') }) : t('profiles.pcImport.keepChannels')),
            skippedChannels.length > 0 && t('profiles.pcImport.keepChannelFiles', { n: skippedChannels.length, names: skippedChannels.join(', ') }),
            t('profiles.pcImport.keepSettings'),
          ]}
        />
      </Box>
      {mode === 'move' && plan && (
        <ListBlock
          id="pc-secrets"
          title={t('profiles.pcImport.secretsMoving')}
          items={[
            files > 0 && (
              <>
                {t('profiles.pcImport.secretsFiles', { a: plan.files_replace_count, b: plan.files_new_count })}
                <Names names={[...plan.files_replace, ...plan.files_new]} total={plan.files_replace_count + plan.files_new_count} />
                <Typography component="span" variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  {t('profiles.pcImport.secretsFilesNote', { days: job.backup_days })}
                </Typography>
              </>
            ),
            mcpMoved && t('profiles.pcImport.secretsMcp', { n: sec?.mcp_files ?? 0 }),
            channelMoved && t('profiles.pcImport.secretsChannel', { n: sec?.channel_files ?? 0 }),
            ((sec?.env_keys_count ?? 0) > 0 || blocked.length > 0) && (
              <>
                {t('profiles.pcImport.secretsEnv', { n: plan.env_add_count, m: plan.env_exists_count, k: blocked.length, name: profile })}
                <Names names={plan.env_add} total={plan.env_add_count} />
                {blocked.length > 0 && <Names names={blocked} total={plan.env_blocked_count + (sec?.env_unreadable?.length ?? 0)} />}
              </>
            ),
          ]}
        />
      )}
      {mode === 'unknown' && (
        <Alert severity="info" role="status">
          {t('profiles.pcImport.secretsPlanUnknown', { name: profile })}
          <Typography component="span" variant="body2" sx={{ display: 'block' }}>
            {t('profiles.pcImport.secretsBundleCount', { a: files, b: sec?.env_keys_count ?? 0 })}
          </Typography>
        </Alert>
      )}
      {mode === 'off' && dropped && (
        <Alert severity="info" role="status">
          {t('profiles.pcImport.secretsOff')}
          <Names names={dropped.secrets_off_names} total={dropped.secrets_off_count} />
        </Alert>
      )}
      {mode === 'unsupported' && (
        <Alert severity="info" role="status" action={<RequestAdminButton profile={job.profile} kind="other" detail={t('profiles.pcImport.todoSecretsSkippedDetail', { name: profile })} />}>
          {t('profiles.pcImport.secretsUnsupported')}
        </Alert>
      )}
      {(sec?.model_files?.length ?? 0) > 0 && (
        <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
          <Typography variant="body2">{t('profiles.pcImport.modelFilesSkipped')}</Typography>
          <RequestAdminButton profile={job.profile} kind="other" detail={t('profiles.pcImport.modelFilesDetail', { name: profile })} />
        </Stack>
      )}
      {dropped && dropped.links + dropped.credential_groups_count + dropped.other_groups_count > 0 && (
        <Box>
          <Fold
            title={t('profiles.pcImport.droppedSummary', {
              links: dropped.link_skills_count || dropped.links,
              cred: dropped.credential_groups_count,
              other: dropped.other_groups_count,
            })}
          >
            <Stack spacing={1}>
              {dropped.links > 0 && (
                <Box>
                  <Typography variant="body2">{t('profiles.pcImport.droppedLinkSkills')}</Typography>
                  <Names names={dropped.link_skills} total={dropped.link_skills_count} />
                  <Typography variant="caption" color="text.secondary">
                    {t('profiles.pcImport.droppedLinkSkillsNote')}
                  </Typography>
                </Box>
              )}
              {dropped.credential_groups_count > 0 && (
                <Box>
                  <Typography variant="body2">{t('profiles.pcImport.droppedCredential')}</Typography>
                  <Names
                    names={dropped.credential_groups.map((g) => t('profiles.pcImport.droppedItem', { name: g.name, n: g.files }))}
                    total={dropped.credential_groups_count}
                  />
                </Box>
              )}
              {dropped.other_groups_count > 0 && (
                <Box>
                  <Typography variant="body2">{t('profiles.pcImport.droppedOther')}</Typography>
                  <Names
                    names={dropped.other_groups.map((g) => t('profiles.pcImport.droppedItem', { name: g.name, n: g.files }))}
                    total={dropped.other_groups_count}
                  />
                </Box>
              )}
            </Stack>
          </Fold>
        </Box>
      )}
      {keeps.shared_with.length > 0 && (
        <Typography variant="body2">
          {t('profiles.pcImport.sharedSkills', { n: keeps.shared_with.length, name: keeps.shared_with.join(', ') })}
        </Typography>
      )}
      {/* 게이트웨이를 여러 프로파일이 함께 쓴다(쿠버네티스). 다른 프로파일이 있으면 그 채널·예약 작업도 잠깐 멈춘다(DD10) */}
      {others.length > 0 && (
        <Alert severity="info" role="status">
          {t('profiles.pcImport.gatewayRestart')}
        </Alert>
      )}
      {busyOther && <BusyOther name={busyOther} />}
      {err && !(err.code === 'busy_import' && busyOther) && <ErrAlert err={err} />}
      <Stack direction="row" spacing={1} justifyContent="flex-end" useFlexGap flexWrap="wrap">
        <Button variant="outlined" color="inherit" sx={tall(tier2)} disabled={busy} onClick={onBack}>
          {t('profiles.pcImport.back')}
        </Button>
        <Button variant="outlined" color="inherit" sx={tall(tier2)} disabled={busy} onClick={cancel}>
          {t('common.cancel')}
        </Button>
        {/* 이름이 길면 단추에서 줄이고 전체 이름은 툴팁과 읽는 이름에(DD2). 막히면 aria-disabled 와 이유(DD6) */}
        <Tooltip title={short !== profile ? replaceFull : ''}>
          <span>
          <Button
            variant="outlined"
            color="inherit"
            sx={tall(tier3)}
            disabled={busy}
            aria-label={replaceFull}
            aria-disabled={busyOther ? true : undefined}
            aria-describedby={busyOther ? whyId : undefined}
            onClick={() => !busyOther && void go()}
            startIcon={busy ? <CircularProgress size={14} color="inherit" /> : undefined}
          >
            {t('profiles.pcImport.replace', { name: short })}
          </Button>
          </span>
        </Tooltip>
        {busyOther && (
          <Box component="span" id={whyId} sx={visuallyHidden}>
            {t('profiles.pcImport.busyOtherWhy')}
          </Box>
        )}
      </Stack>
    </Stack>
  );
}

// ---- ③ 가져오는 중 ------------------------------------------------------------------------------------------
const rowWord: Record<RowState, string> = {
  done: 'profiles.pcImport.rowDone',
  now: 'profiles.pcImport.rowNow',
  wait: 'profiles.pcImport.rowWait',
};

function Running({ job }: { job: Job }) {
  const withSecrets = hasSecretStages(job);
  const labels = stageLabels(withSecrets);
  const rows = stageRows(job.stage, withSecrets);
  const now = labels.filter((_, i) => rows[i] === 'now').join(' · ');
  return (
    <Stack spacing={1.5}>
      <Box component="ol" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
        {labels.map((l, i) => (
          <Box
            component="li"
            key={l}
            data-state={rows[i]}
            sx={{ display: 'flex', alignItems: 'center', gap: 1, color: rows[i] === 'wait' ? 'text.disabled' : 'text.primary' }}
          >
            {rows[i] === 'done' ? (
              <CheckIcon fontSize="small" sx={{ color: 'success.main' }} aria-hidden />
            ) : rows[i] === 'now' ? (
              <CircularProgress size={16} color="inherit" aria-hidden />
            ) : (
              <RadioButtonUncheckedIcon fontSize="small" aria-hidden />
            )}
            <Typography variant="body2" sx={{ fontWeight: rows[i] === 'now' ? 700 : 400 }}>
              {l}
            </Typography>
            <Box component="span" sx={visuallyHidden}>
              {t(rowWord[rows[i]])}
            </Box>
          </Box>
        ))}
      </Box>
      <Box role="status" aria-live="polite" sx={visuallyHidden}>
        {t('profiles.pcImport.liveStage', { name: now })}
      </Box>
      <Typography variant="body2" color="text.secondary">
        {t('profiles.pcImport.keepsRunning')}
      </Typography>
    </Stack>
  );
}

// ---- ④ 결과 -------------------------------------------------------------------------------------------------
function Fold({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Accordion disableGutters variant="outlined" sx={{ '&:before': { display: 'none' } }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant="body2">{title}</Typography>
      </AccordionSummary>
      <AccordionDetails>{children}</AccordionDetails>
    </Accordion>
  );
}

/** PC 에서 비밀값을 찾아 옮기는 단계(§5-1). OS 탭 하나만 보인다 */
function SecretsGuide({ names, profile }: { names: string[]; profile: string }) {
  const [os, setOs] = useState<Os>(() => detectOs());
  const example = names[0] || 'OPENAI_API_KEY';
  const c = findCommands(os, example);
  return (
    <Stack spacing={1.5}>
      <OsTabs value={os} onChange={setOs} />
      <Steps
        steps={[
          { text: t('profiles.pcImport.find.1') },
          { text: t('profiles.pcImport.find.2'), cmd: c.config },
          { text: t('profiles.pcImport.find.3'), cmd: c.envPath },
          { text: t('profiles.pcImport.find.4', { name: example }), cmd: c.grep },
          { text: t('profiles.pcImport.find.4a'), cmd: c.open },
          { text: t('profiles.pcImport.find.5') },
          { text: t('profiles.pcImport.find.6', { name: profile }) },
          { text: t('profiles.pcImport.find.7') },
          { text: t('profiles.pcImport.find.8') },
          { text: t('profiles.pcImport.find.9') },
        ]}
      />
      <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
        {['p', 'note1', 'note2', 'note3', 'note4', 'note5'].map((k) => (
          <Typography key={k} component="li" variant="caption" color="text.secondary">
            {t(`profiles.pcImport.find.${k}`)}
          </Typography>
        ))}
      </Box>
    </Stack>
  );
}

function Result({ job, profile, onAgain }: { job: Job; profile: string; onAgain: () => void }) {
  const r = job.result ?? {};
  const secrets = secretsTodo(r);
  const failed = r.env_failed?.length ?? 0;
  const mcp = r.mcp_relogin ?? 0;
  const cron = r.paused_cron ?? 0;
  const pcJobs = r.pc_path_jobs ?? [];
  const osOnly = r.os_only_skills ?? [];
  const links = r.link_skills ?? [];
  const notMoved = !!r.secrets_unsupported;
  const bundle = !!job.summary?.secrets_bundle;
  const moved = bundle && !notMoved;
  const skipped = (r.env_skipped ?? []).filter((x) => x.reason === 'exists' || x.reason === 'blocked');
  // 옮기지 않은 채널 연결 파일 수 = 다시 연결할 채널(DD3)
  const channels = r.channels_to_reconnect ?? 0;
  // 내보내기 때 가려졌을 수 있는 기본 스킬(스펙 2026-10-27-011 D3·D12·D15): 할 일. 되돌린 수는 안내 한 줄
  const kept = r.bundled_kept ?? [];
  const repaired = r.bundled_repaired_n ?? 0;
  const todos = [secrets.length > 0, mcp > 0, cron > 0, links.length > 0, notMoved, channels > 0, kept.length > 0].filter(Boolean).length;
  const names = (xs?: string[]) => (xs ?? []).map(breakable).join(' · ');
  return (
    <Stack spacing={1.5}>
      {failed > 0 ? (
        <Alert severity="warning" role="status">
          {t('profiles.pcImport.doneWithFailures', { n: failed, name: profile })}
        </Alert>
      ) : (
        <Alert severity="success" role="status">
          {t('profiles.pcImport.done', { time: fmtTs(r.done_at || job.updated), name: profile })}
        </Alert>
      )}
      <RepairLines r={r} repaired={repaired} />
      {todos > 0 && (
        <Box>
          <Typography variant="subtitle2" component="h3" id="pc-todo" sx={{ mb: 0.5 }}>
            {t('profiles.pcImport.todo', { n: todos })}
          </Typography>
          <Box component="ul" aria-labelledby="pc-todo" sx={{ m: 0, pl: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 0.75 }}>
            {secrets.length > 0 && (
              <TodoRow text={t('profiles.pcImport.todoSecrets', { n: secrets.length })} pane="env" profile={profile}>
                <Typography variant="caption" sx={{ fontFamily: MONO_FONT, wordBreak: 'break-all' }}>
                  {secrets.join(', ')}
                </Typography>
              </TodoRow>
            )}
            {mcp > 0 && <TodoRow text={t('profiles.pcImport.todoMcp', { n: mcp })} pane="tools" profile={profile} />}
            {cron > 0 && (
              <TodoRow text={t('profiles.pcImport.todoCron', { n: cron })} pane="cron" profile={profile}>
                {pcJobs.length > 0 && (
                  <Typography variant="caption" color="text.secondary">
                    {t('profiles.pcImport.pcPathJobs', { n: pcJobs.length, name: pcJobs.join(', ') })}
                  </Typography>
                )}
              </TodoRow>
            )}
            {channels > 0 && <TodoRow text={t('profiles.pcImport.todoChannels', { n: channels })} pane="channels" profile={profile} />}
            {kept.length > 0 && (
              <TodoRow text={t('profiles.pcImport.todoKept', { n: kept.length })} profile={profile}>
                <KeptSkills paths={kept} />
              </TodoRow>
            )}
            {links.length > 0 && (
              <TodoRow text={t('profiles.pcImport.todoLinkSkills', { n: links.length })} pane="skills" profile={profile}>
                <Names names={links} total={links.length} />
              </TodoRow>
            )}
            {notMoved && (
              <TodoRow
                text={t('profiles.pcImport.todoSecretsSkipped')}
                profile={profile}
                action={<RequestAdminButton profile={profile} kind="other" detail={t('profiles.pcImport.todoSecretsSkippedDetail', { name: profile })} />}
              />
            )}
          </Box>
        </Box>
      )}
      {moved && (
        <Box>
          <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
            <Typography variant="subtitle2" component="h3" id="pc-moved">
              {t('profiles.pcImport.movedSecrets')}
            </Typography>
            {r.changed_after_confirm && <Tag tone="warn">{t('profiles.pcImport.changedAfterConfirm')}</Tag>}
          </Stack>
          <Box component="ul" aria-labelledby="pc-moved" sx={{ m: 0, pl: 2.5 }}>
            {r.secrets_list_unreadable ? (
              <Typography component="li" variant="body2">
                {t('profiles.pcImport.movedUnreadable', { days: job.backup_days })}
              </Typography>
            ) : (
              <>
                {(r.secrets_replaced?.length ?? 0) > 0 && (
                  <Typography component="li" variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                    {t('profiles.pcImport.movedReplaced', { names: names(r.secrets_replaced) })}
                  </Typography>
                )}
                {(r.secrets_added?.length ?? 0) > 0 && (
                  <Typography component="li" variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                    {t('profiles.pcImport.movedAdded', { names: names(r.secrets_added) })}
                  </Typography>
                )}
              </>
            )}
            {(r.env_added?.length ?? 0) > 0 && (
              <Typography component="li" variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                {t('profiles.pcImport.movedEnv', { names: names(r.env_added) })}
              </Typography>
            )}
          </Box>
          <Typography variant="caption" color="text.secondary">
            {t('profiles.pcImport.rulesDiffer', { name: profile })}
          </Typography>
        </Box>
      )}
      <Box>
        {skipped.length > 0 && (
          <Fold title={t('profiles.pcImport.skippedTitle', { n: skipped.length })}>
            <Stack spacing={1}>
              {(['exists', 'blocked'] as const).map((why) => {
                const xs = skipped.filter((x) => x.reason === why).map((x) => x.name);
                return xs.length ? (
                  <Box key={why}>
                    <Typography variant="body2">{t(`profiles.pcImport.skipReason.${why}`, { name: profile })}</Typography>
                    <Names names={xs} total={xs.length} />
                    {why === 'blocked' && (
                      <Typography variant="caption" color="text.secondary">
                        {t('profiles.pcImport.skipReason.blockedNote')}
                      </Typography>
                    )}
                  </Box>
                ) : null;
              })}
            </Stack>
          </Fold>
        )}
        {osOnly.length > 0 && (
          <Fold title={t('profiles.pcImport.osOnlySkills', { n: osOnly.length })}>
            <Typography variant="body2" sx={{ fontFamily: MONO_FONT, wordBreak: 'break-all' }}>
              {osOnly.join(', ')}
            </Typography>
          </Fold>
        )}
        <Fold title={t('profiles.pcImport.notImportedTitle')}>
          <Typography variant="body2">{t('profiles.pcImport.notImported')}</Typography>
        </Fold>
        <Fold title={t('profiles.pcImport.findTitle')}>
          <SecretsGuide names={secrets} profile={profile} />
        </Fold>
      </Box>
      <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap flexWrap="wrap">
        <Typography variant="body2" color="text.secondary">
          {bundle ? t('profiles.pcImport.keptDaysSecrets', { days: job.backup_days }) : t('profiles.pcImport.backupKept', { days: job.backup_days })}
        </Typography>
        <RequestAdminButton profile={profile} kind="archive_restore" />
      </Stack>
      <Box>
        <Button variant="outlined" color="inherit" sx={tall(tier2)} startIcon={<FileUploadOutlinedIcon />} onClick={onAgain}>
          {t('profiles.pcImport.uploadAnother')}
        </Button>
      </Box>
    </Stack>
  );
}

/** 기본 스킬 되돌리기 결과 줄(디자인 리뷰 D11·D12). 할 일이 없는 상태라 회색 caption 이다(호박색 아님) */
function RepairLines({ r, repaired }: { r: NonNullable<Job['result']>; repaired: number }) {
  const lines = [
    repaired > 0 && t('profiles.pcImport.repaired', { n: repaired }),
    r.bundled_list_unreadable && t('profiles.pcImport.repairListUnreadable'),
    r.bundled_repair_unsupported && t('profiles.pcImport.repairUnsupported'),
    r.bundled_repair_error && t('profiles.pcImport.repairError'),
  ].filter(Boolean) as string[];
  if (!lines.length) return null;
  return (
    <Stack spacing={0.25} data-testid="pc-repair-lines">
      {lines.map((x) => (
        <Typography key={x} variant="caption" color="text.secondary">
          {x}
        </Typography>
      ))}
    </Stack>
  );
}

/** 가려졌을 수 있는 기본 스킬: 앞 10개는 그 사본의 상세로 가는 링크(D15 — id 는 `<프로파일>:<상대경로>`, 이름만 넘기면 다른 프로파일의 같은 이름이 열린다) */
function KeptSkills({ paths }: { paths: string[] }) {
  const shown = paths.slice(0, 10);
  return (
    <Box sx={{ mt: 0.5 }}>
      {shown.map((p) => {
        const profile = p.split('/')[1] ?? '';
        return (
          <LinkChip key={p} to="skills" params={{ tab: 'all', open: `${profile}:${p}` }}>
            {p.split('/').pop()}
          </LinkChip>
        );
      })}
      {paths.length > shown.length && (
        <Typography component="span" variant="caption" color="text.secondary">
          {t('profiles.pcImport.keptMore', { n: paths.length - shown.length })}
        </Typography>
      )}
    </Box>
  );
}

function TodoRow({
  text,
  pane,
  profile,
  action,
  children,
}: {
  text: string;
  pane?: string;
  profile: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Box component="li" sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
      <RadioButtonUncheckedIcon fontSize="small" sx={{ mt: 0.25, color: 'warning.main' }} aria-hidden />
      <Box sx={{ minWidth: 0 }}>
        <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
          <Typography variant="body2">{text}</Typography>
          {pane && (
            <LinkChip to="profiles" params={{ name: profile, pane }}>
              {t(`profiles.pcImport.go.${pane}`)}
            </LinkChip>
          )}
          {action}
        </Stack>
        {children}
      </Box>
    </Box>
  );
}

// ---- 실패 ---------------------------------------------------------------------------------------------------
function Failed({ job, profile, onRetry }: { job: Job; profile: string; onRetry: () => void }) {
  const broken = job.state === 'rollback_failed';
  const first = broken
    ? t('profiles.pcImport.rollbackFailed', { name: profile })
    : job.state === 'rolled_back'
      ? t('profiles.pcImport.rolledBack', { name: profile })
      : t('profiles.pcImport.rejected', { name: profile });
  const next = broken
    ? t('profiles.pcImport.adminNotified', { time: fmtTs(job.updated) })
    : job.reason === 'interrupted'
      ? t('profiles.pcImport.interrupted')
      : t('profiles.pcImport.failedAt', { name: stageName(job.stage, hasSecretStages(job)) });
  return (
    <Stack spacing={1.5}>
      <Alert severity={broken ? 'error' : 'warning'} role="status">
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {first}
        </Typography>
        <Typography variant="body2">{next}</Typography>
        {job.result?.secrets_rolled_back && <Typography variant="body2">{t('profiles.pcImport.rolledBackSecrets')}</Typography>}
      </Alert>
      {job.error && (
        <Typography variant="caption" color="text.secondary" sx={{ wordBreak: 'break-word' }}>
          {job.error}
        </Typography>
      )}
      {!broken && (
        <Box>
          <Button variant="outlined" color="inherit" sx={tall(tier1)} startIcon={<RefreshIcon />} onClick={onRetry}>
            {t('profiles.pcImport.retry')}
          </Button>
        </Box>
      )}
    </Stack>
  );
}
