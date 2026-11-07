/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 받은편지함 서랍(계획 007 P4, §3-3 G2·G4). 승인·되묻기는 여기서 바로 답하고, 카드·크론은 해당 화면으로 간다.
// 「답할 일」과 확인만 하면 되는 「알림」을 나눠 보이고, 알림은 줄 오른쪽 확인 단추와 머리줄 「모두 확인」으로 지운다(스펙 2026-10-30-001).
import type { SvgIconComponent } from '@mui/icons-material';
import BlockOutlinedIcon from '@mui/icons-material/BlockOutlined';
import CheckIcon from '@mui/icons-material/Check';
import ComputerOutlinedIcon from '@mui/icons-material/ComputerOutlined';
import DoneAllIcon from '@mui/icons-material/DoneAll';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import EventAvailableOutlinedIcon from '@mui/icons-material/EventAvailableOutlined';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import LinkOutlinedIcon from '@mui/icons-material/LinkOutlined';
import MarkEmailReadOutlinedIcon from '@mui/icons-material/MarkEmailReadOutlined';
import MemoryOutlinedIcon from '@mui/icons-material/MemoryOutlined';
import RateReviewOutlinedIcon from '@mui/icons-material/RateReviewOutlined';
import SendOutlinedIcon from '@mui/icons-material/SendOutlined';
import StorageOutlinedIcon from '@mui/icons-material/StorageOutlined';
import SupportAgentOutlinedIcon from '@mui/icons-material/SupportAgentOutlined';
import TaskAltOutlinedIcon from '@mui/icons-material/TaskAltOutlined';
import VerifiedUserOutlinedIcon from '@mui/icons-material/VerifiedUserOutlined';
import { Alert, Box, Button, IconButton, Skeleton, Stack, TextField, Tooltip, Typography } from '@mui/material';
import { useSnackbar } from 'notistack';
import { ReactNode, useState } from 'react';

import { LinkChip } from '@/components/bits';
import { useConfirm } from '@/components/ConfirmDialog';
import { DrawerActions } from '@/components/DrawerActions';
import { PanelEmpty } from '@/components/PanelEmpty';
import { InboxItem, useInbox } from '@/features/office/useInbox';
import { t } from '@/i18n';
import { agentLabel } from '@/lib/agentLabel';
import { useMe } from '@/lib/data';
import { fmtTs } from '@/lib/format';
import { MONO_FONT } from '@/lib/monoFont';
import { switchPod } from '@/lib/pod';
const KIND: Record<InboxItem['kind'], string> = {
  approval: 'office.inboxApproval',
  clarify: 'office.inboxClarify',
  review: 'office.inboxReview',
  blocked: 'office.inboxBlocked',
  cron_failed: 'office.inboxCron',
  cron_done: 'office.inboxCronDone',
  admin_request: 'office.inboxAdminRequest',
  admin_request_result: 'office.inboxAdminResult',
  mcp_login: 'profiles.mcp.inboxKind',
  retained_volume: 'office.inboxRetained',
  pc_import: 'profiles.pcImport.action',
  connection: 'conn.inboxKind',
  workspace_oom: 'office.inboxOom',
  size_failed: 'office.inboxSizeFailed',
  blocked_route: 'office.inboxBlockedRoute',
};

/** 줄 왼쪽의 종류 아이콘. 색은 실패한 예약 작업만 오류색이고 나머지는 무채색(DESIGN §1-1) */
const KIND_ICON: Record<InboxItem['kind'], SvgIconComponent> = {
  approval: VerifiedUserOutlinedIcon,
  clarify: HelpOutlineIcon,
  review: RateReviewOutlinedIcon,
  blocked: BlockOutlinedIcon,
  cron_failed: ErrorOutlineIcon,
  cron_done: EventAvailableOutlinedIcon,
  admin_request: SupportAgentOutlinedIcon,
  admin_request_result: MarkEmailReadOutlinedIcon,
  mcp_login: KeyOutlinedIcon,
  retained_volume: StorageOutlinedIcon,
  pc_import: ComputerOutlinedIcon,
  connection: LinkOutlinedIcon,
  workspace_oom: MemoryOutlinedIcon,
  size_failed: MemoryOutlinedIcon,
  blocked_route: BlockOutlinedIcon,
};

/** 확인만 하면 사라지는 알림. 서버는 답 없이({}) 보내면 지운다. 나머지는 답(승인·질문·요청 처리)을 해야 사라진다 */
const NOTICE: ReadonlySet<InboxItem['kind']> = new Set(['cron_done', 'pc_import', 'connection', 'admin_request_result', 'workspace_oom', 'size_failed', 'blocked_route']);
const GIB = 2 ** 30;
const gib = (n?: number) => (n ? `${Math.round((n / GIB) * 10) / 10}Gi` : '?');
export const isNotice = (i: InboxItem) => NOTICE.has(i.kind);

/** Claude Code 연결 알림 문장(스펙 2026-10-28-001 §3-7 ③, 디자인 D10·D19). 서버는 상태 코드만 준다 */
function connectionText(item: InboxItem): string {
  const name = item.name ?? '';
  if (item.status === 'revoked') return t('conn.inboxRevoked', { name, by: item.by_name || item.by || '', reason: item.reason || '—' });
  const date = item.expires ? fmtTs(new Date(item.expires * 1000).toISOString()).slice(0, 10) : '';
  return t(item.token_kind === 'oauth' ? 'conn.inboxExpiringOauth' : 'conn.inboxExpiringPat', { name, date });
}

/** PC 에서 가져오기 알림 문장(§10-5). 서버는 text 를 비워 보내고 상태 코드만 준다. 문장에 대상 프로파일 이름을 넣는다(OMAI-1444 DD12).
 * 그 프로파일을 지웠으면 기록의 profile 이 비어 온다 — 상태마다 「지운 프로파일의 …」 문장을 따로 쓴다(DD8, R2) */
function pcImportText(item: InboxItem): string {
  const name = item.profile ?? '';
  const time = item.at ? fmtTs(new Date(item.at * 1000).toISOString()) : '';
  if (!name) {
    if (item.status === 'by_admin') return t('profiles.pcImport.inboxDeletedByAdmin', { name: item.by_name || item.by || '', time });
    if (item.status === 'rollback_failed') return t('profiles.pcImport.inboxDeletedRollbackFailed');
    return t(item.status === 'rolled_back' ? 'profiles.pcImport.inboxDeletedRolledBack' : 'profiles.pcImport.inboxDeletedDone');
  }
  if (item.status === 'by_admin')
    return item.secrets
      ? t('profiles.pcImport.inboxByAdminSecrets', { admin: item.by_name || item.by || '', n: item.secrets.files, m: item.secrets.env, name })
      : t('profiles.pcImport.inboxByAdmin', { name: item.by_name || item.by || '', time, profile: name });
  if (item.status === 'rollback_failed') return t('profiles.pcImport.inboxRollbackFailed', { name });
  return t(item.status === 'rolled_back' ? 'profiles.pcImport.inboxRolledBack' : 'profiles.pcImport.inboxDone', { name });
}

function Clarify({ onAnswer }: { onAnswer: (a: string) => void }) {
  const [text, setText] = useState('');
  return (
    <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
      <TextField
        size="small"
        fullWidth
        label={t('office.inboxAnswer')}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <Button startIcon={<SendOutlinedIcon />} variant="outlined" disabled={!text.trim()} onClick={() => onAnswer(text.trim())}>
        {t('office.inboxSend')}
      </Button>
    </Stack>
  );
}

/** 관리자 항목: 누가 무엇을 부탁했는지, 며칠째 기다리는지, 처리했습니다·거절(사유). 7일을 넘기면 강조한다(글자색은 그대로, 앰버 표시) */
function AdminRequestActions({
  item,
  busy,
  run,
}: {
  item: InboxItem;
  busy: boolean;
  run: (b: { choice?: string; reason?: string }) => void;
}) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  return (
    <Box sx={{ mt: 0.5 }}>
      <Typography
        variant="caption"
        component="p"
        sx={item.stale ? { borderLeft: '3px solid', borderColor: 'warning.main', pl: 0.75 } : undefined}
        title={item.requester}
      >
        {t('office.inboxAdminWho', { who: item.requester_name || item.requester || '', kind: t(`requests.title.${item.req_kind ?? 'other'}`) })}
        {' · '}
        {t('office.inboxAdminDays', { days: item.waiting_days ?? 0 })}
      </Typography>
      {declining ? (
        <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
          <TextField
            size="small"
            fullWidth
            label={t('office.inboxAdminReason')}
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, 300))}
          />
          <Button variant="outlined" disabled={busy} onClick={() => run({ choice: 'declined', reason: reason.trim() })}>
            {t('office.inboxAdminDecline')}
          </Button>
        </Stack>
      ) : (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1 }}>
          {item.req_kind === 'workspace_size' ? (
            // 메모리 늘리기(D14·D15): 크기 구역으로 바로 보내고 「처리했습니다」는 두지 않는다 — 크기 롤아웃이 끝나면 자동으로 닫힌다(R10)
            <LinkChip to="agents" params={{ open: item.pod ?? '', focus: 'size' }} page>
              {t('office.inboxSizeOpen')}
            </LinkChip>
          ) : (
            <>
              {item.profile && (
                <LinkChip to="profiles" params={{ name: item.profile }} page>
                  {t('office.inboxAdminOpen')}
                </LinkChip>
              )}
              <Button size="small" variant="outlined" disabled={busy} onClick={() => run({ choice: 'handled' })}>
                {t('office.inboxAdminDone')}
              </Button>
            </>
          )}
          <Button size="small" disabled={busy} onClick={() => setDeclining(true)}>
            {t('office.inboxAdminDecline')}
          </Button>
        </Stack>
      )}
    </Box>
  );
}

/** 지운 에이전트의 남은 데이터 볼륨(OMAI-1291). 지우기는 화면에서 하지 않고 운영자가 명령으로 한다 — 명령을 보이고, 처리했습니다로 다음 기간까지 조용히 한다 */
function RetainedVolumes({ item, busy, run }: { item: InboxItem; busy: boolean; run: (b: { choice?: string }) => void }) {
  return (
    <Box sx={{ mt: 0.5 }}>
      <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
        {(item.volumes ?? []).map((v) => (
          <Typography key={v.pvc} component="li" variant="caption" sx={{ wordBreak: 'break-word' }}>
            {[
              // 「옛 주인 · 에이전트 이름」. 이름을 적기 전에 지운 것은 이메일 · id(스펙 2026-10-19-003)
              agentLabel({ id: v.agent, name: v.agent_name, owner_name: v.owner_name, owner: v.owner }),
              t(v.known ? 'office.retainedDeletedAgo' : 'office.retainedSeenAgo', { days: v.days }),
              v.size,
              v.export ? t('office.retainedExport', { file: v.export }) : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </Typography>
        ))}
      </Box>
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.75 }}>
        {t('office.retainedHowTo')}
      </Typography>
      <Typography variant="caption" component="pre" sx={{ fontFamily: MONO_FONT, whiteSpace: 'pre-wrap', wordBreak: 'break-all', m: 0, p: 0.75, bgcolor: 'action.hover' }}>
        {item.command}
      </Typography>
      <Button size="small" variant="outlined" disabled={busy} onClick={() => run({ choice: 'handled' })} sx={{ mt: 0.75 }}>
        {t('office.inboxAdminDone')}
      </Button>
    </Box>
  );
}

function Row({
  item,
  answer,
}: {
  item: InboxItem;
  answer: Answer;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const confirm = useConfirm();
  // 승인 답은 에이전트가 명령을 실행할지를 정하므로 확인한다. 확인 창에 명령을 함께 보인다(OMAI-1135)
  const choose = async (c: string) => {
    const key = `office.choiceConfirm.${c}`;
    const name = item.label || item.alias;
    const m = t(key, { alias: name, choice: c });
    const ask = (m === key ? t('office.choiceConfirm.other', { alias: name, choice: c }) : m) + (item.command ? '\n' + item.command : '');
    if (await confirm(ask)) run({ choice: c });
  };
  const run = (b: { choice?: string; answer?: string; reason?: string }) => {
    setBusy(true);
    setErr('');
    answer(item.id, b)
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  const Icon = KIND_ICON[item.kind];
  const notice = isNotice(item);
  return (
    <Box
      component="li"
      sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, px: 1, py: 1.25, mx: -1, borderRadius: 1, '&:hover': { bgcolor: 'action.hover' } }}
    >
      <Box
        aria-hidden
        sx={{
          width: 32,
          height: 32,
          flexShrink: 0,
          display: 'grid',
          placeItems: 'center',
          borderRadius: 1,
          border: '1px solid',
          borderColor: 'divider',
          color: item.kind === 'cron_failed' ? 'error.main' : 'text.secondary',
        }}
      >
        <Icon sx={{ fontSize: 18 }} />
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        {/* 문장을 먼저 읽게 한다: 굵은 본문, 그 아래 종류 · 에이전트 */}
        <Typography variant="body2" sx={{ fontWeight: 500, wordBreak: 'break-word' }}>
          {item.kind === 'mcp_login'
            ? t(item.reauth ? 'profiles.mcp.inboxReauth' : 'profiles.mcp.inboxLogin', { alias: item.label || item.alias, server: item.server ?? item.text })
            : item.kind === 'retained_volume'
              ? t('office.retainedTitle', { n: item.volumes?.length ?? 0, days: item.days ?? 0 })
              : item.kind === 'pc_import'
                ? pcImportText(item)
                : item.kind === 'connection'
                  ? connectionText(item)
                  : item.text || item.command}
        </Typography>
        <Typography variant="caption" color="text.secondary" component="p">
          {t(KIND[item.kind])}
          {item.alias ? ` · ${item.label || item.alias}` : ''}
        </Typography>
        {item.command && item.text && (
          <Typography
            variant="caption"
            component="pre"
            sx={{ fontFamily: MONO_FONT, whiteSpace: 'pre-wrap', wordBreak: 'break-all', m: 0, mt: 0.75, px: 0.75, py: 0.5, borderRadius: 0.5, bgcolor: 'action.hover' }}
          >
            {item.command}
          </Typography>
        )}
        {item.error && (
          <Typography variant="caption" color="text.secondary" component="p">
            {item.error}
          </Typography>
        )}
        {item.kind === 'approval' && (
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            {(item.choices?.length ? item.choices : ['once', 'deny']).map((c) => (
              <Button
                key={c}
                size="small"
                variant={c === 'deny' ? 'text' : 'outlined'}
                disabled={busy}
                onClick={() => void choose(c)}
              >
                {t(`office.choice.${c}`) === `office.choice.${c}` ? c : t(`office.choice.${c}`)}
              </Button>
            ))}
          </Stack>
        )}
        {item.kind === 'clarify' && <Clarify onAnswer={(a) => run({ answer: a })} />}
        {(item.kind === 'review' || item.kind === 'blocked') && (
          <Links>
            <LinkChip to="office" params={{ tab: 'kanban', board: item.board }}>
              {t('office.inboxOpenKanban')}
            </LinkChip>
          </Links>
        )}
        {(item.kind === 'cron_failed' || item.kind === 'cron_done') && (
          <Links>
            <CronLink item={item} />
          </Links>
        )}
        {item.kind === 'mcp_login' && (
          <Links>
            <McpLoginLink item={item} />
          </Links>
        )}
        {item.kind === 'admin_request' && <AdminRequestActions item={item} busy={busy} run={run} />}
        {item.kind === 'retained_volume' && <RetainedVolumes item={item} busy={busy} run={run} />}
        {item.kind === 'admin_request_result' && (
          <Typography variant="body2" sx={{ mt: 0.5 }}>
            {item.req_kind === 'workspace_size' && item.status === 'handled' && item.memory_to
              ? t('office.inboxSizeRaised', { from: gib(item.memory_from), to: gib(item.memory_to) })
              : t(item.status === 'declined' ? 'office.inboxAdminDeclined' : 'office.inboxAdminHandled')}
            {item.reason && !(item.req_kind === 'workspace_size' && item.memory_to) ? ` — ${item.reason}` : ''}
          </Typography>
        )}
        {item.kind === 'blocked_route' && (
          // 다음 할 일과 모델 화면 프로파일 탭(그 프로파일 서랍)으로 가는 길(D10)
          <>
            <Typography variant="body2" sx={{ mt: 0.5 }}>
              {t('office.inboxBlockedRouteText', { profile: item.profile ?? '', host: item.host ?? '', models: (item.models ?? []).join(', ') })}
            </Typography>
            <Links>
              <ProfileLink item={item} view="models" params={{ tab: 'profiles', open: item.profile ?? '' }} label={t('office.inboxBlockedRouteOpen')} />
            </Links>
          </>
        )}
        {(item.kind === 'workspace_oom' || item.kind === 'size_failed') && (
          <>
            <Typography variant="body2" sx={{ mt: 0.5 }}>
              {item.kind === 'workspace_oom' ? t('office.inboxOomText', { limit: item.limit_memory || '?' }) : t('office.inboxSizeFailedText', { reason: item.text })}
            </Typography>
            <Links>
              <LinkChip to="agents" params={{ open: item.pod ?? '' }} page>
                {t('office.inboxWorkspaceOpen')}
              </LinkChip>
            </Links>
          </>
        )}
        {item.kind === 'pc_import' && (
          <Links>
            {item.profile ? (
              <ProfileLink item={item} params={{ name: item.profile }} label={t('office.inboxAdminOpen')} />
            ) : (
              <Typography variant="caption" color="text.secondary">
                {t('profiles.pcImport.inboxDeleted')}
              </Typography>
            )}
          </Links>
        )}
        {item.kind === 'connection' && (
          <Links>
            <LinkChip to="connections">
              {item.status === 'expiring' && item.token_kind !== 'oauth' ? t('conn.inboxNewToken') : t('conn.inboxOpen')}
            </LinkChip>
          </Links>
        )}
        {err && (
          <Alert severity="error" sx={{ mt: 1 }}>
            {err}
          </Alert>
        )}
      </Box>
      {notice && (
        // 알림은 줄마다 같은 자리(오른쪽 위)의 확인 단추 하나로 지운다. 글자 단추가 줄마다 반복되던 것을 아이콘으로 줄였다
        <Tooltip title={t('office.inboxAck')}>
          <span>
            <IconButton aria-label={t('office.inboxAck')} size="small" disabled={busy} onClick={() => run({})} sx={{ mt: 0.25 }}>
              <CheckIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      )}
    </Box>
  );
}

/** 줄 아래의 이동 링크 자리 */
function Links({ children }: { children: ReactNode }) {
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.75 }}>
      {children}
    </Stack>
  );
}

/** kinds 를 주면 그 종류만 보인다(QA 단말: 실패한 크론·막힌 카드, 계획 007 P5). */
/** 「크론 보기」 링크 값. alias 는 오피스 자리 이름이라 Cron 표의 검색 글(작업·프로파일·오류)에 없다. 프로파일·작업 id 가 있으면 그 작업의 서랍을 연다 */
function cronLinkParams(item: InboxItem): Record<string, string> {
  return item.profile && item.job_id ? { open: `${item.profile}/${item.job_id}` } : { q: item.alias };
}

/** Cron 화면은 지금 보고 있는 POD 의 작업만 보인다. 다른 POD 의 항목이면 그 POD 로 전환한 뒤 연다(전환은 화면 전체를 새로 고친다) */
function CronLink({ item }: { item: InboxItem }) {
  const me = useMe().data;
  const { enqueueSnackbar } = useSnackbar();
  const params = cronLinkParams(item);
  const other = !!item.pod && !!me?.pod?.id && me.pod.id !== item.pod;
  if (!other)
    return (
      <LinkChip to="cron" params={params} page>
        {t('office.viewCron')}
      </LinkChip>
    );
  const go = async () => {
    try {
      await switchPod(item.pod ?? '');
      window.location.hash = `#/cron?${new URLSearchParams(params)}`;
      window.location.reload();
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    }
  };
  return (
    <LinkChip view="cron" onClick={() => void go()}>
      {t('office.viewCron')}
    </LinkChip>
  );
}

/** 「MCP 탭 열기」: 그 프로파일의 MCP 탭에서 그 서버 행을 강조한다(V14). 다른 POD 의 항목이면 그 POD 로 전환한 뒤 연다 */
function McpLoginLink({ item }: { item: InboxItem }) {
  return (
    <ProfileLink item={item} params={{ name: item.profile ?? '', pane: 'tools', server: item.server ?? '' }} label={t('profiles.mcp.inboxOpen')} />
  );
}

/** 프로파일 상세로 가는 링크. 다른 POD 의 항목이면 그 POD 로 전환한 뒤 연다(MCP 로그인·PC 가져오기 알림이 함께 쓴다) */
function ProfileLink({ item, params, label, view = 'profiles' }: { item: InboxItem; params: Record<string, string>; label: string; view?: 'profiles' | 'models' }) {
  const me = useMe().data;
  const { enqueueSnackbar } = useSnackbar();
  const other = !!item.pod && !!me?.pod?.id && me.pod.id !== item.pod;
  if (!other)
    return (
      <LinkChip to={view} params={params} page>
        {label}
      </LinkChip>
    );
  const go = async () => {
    try {
      await switchPod(item.pod ?? '');
      window.location.hash = `#/${view}?${new URLSearchParams(params)}`;
      window.location.reload();
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    }
  };
  return (
    <LinkChip view={view} onClick={() => void go()}>
      {label}
    </LinkChip>
  );
}

/** 받은편지함 서랍 본문. 비어 있을 때도 가이드가 강조할 수 있게 바깥을 감싼다 */
export function InboxPanel(props: { kinds?: InboxItem['kind'][] } = {}) {
  return (
    <Box data-guide="inbox.panel">
      <InboxPanelInner {...props} />
    </Box>
  );
}

function InboxPanelInner({ kinds }: { kinds?: InboxItem['kind'][] } = {}) {
  const inbox = useInbox();
  const { error, loading, answer } = inbox;
  const items = kinds ? inbox.items.filter((i) => kinds.includes(i.kind)) : inbox.items;
  if (loading)
    return (
      <Stack spacing={1}>
        <Skeleton height={48} />
        <Skeleton height={48} />
        <Skeleton height={48} />
      </Stack>
    );
  if (error && !items.length) return <Alert severity="error">{t('office.inboxFailed')}</Alert>;
  if (!items.length)
    return (
      <PanelEmpty icon={TaskAltOutlinedIcon} title={t('office.inboxEmpty')} sub={kinds ? t('office.inboxEmptyQa') : undefined} />
    );
  const needs = items.filter((i) => !isNotice(i));
  const notices = items.filter(isNotice);
  return (
    <>
      {/* 「모두 확인」은 서랍 머리줄(닫기 앞)에 그린다. 종류를 거른 QA 단말에는 두지 않는다 */}
      {!kinds && notices.length > 0 && <AckAll notices={notices} answer={answer} />}
      <Section label={t('office.inboxNeeds')} items={needs} answer={answer} />
      <Section label={t('office.inboxNotices')} items={notices} answer={answer} />
    </>
  );
}

type Answer = (id: string, b: { choice?: string; answer?: string; reason?: string }) => Promise<unknown>;

/** 「답할 일」·「알림」 묶음. 비었으면 그리지 않는다 */
function Section({ label, items, answer }: { label: string; items: InboxItem[]; answer: Answer }) {
  if (!items.length) return null;
  return (
    <Box component="section" aria-label={label} sx={{ '& + &': { mt: 2.5 } }}>
      <Typography component="h3" variant="caption" color="text.secondary" sx={{ display: 'flex', gap: 0.75, fontWeight: 500, mb: 0.5 }}>
        {label}
        <Box component="span" sx={{ color: 'text.primary' }}>
          {items.length}
        </Box>
      </Typography>
      <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
        {items.map((it) => (
          <Row key={it.id} item={it} answer={answer} />
        ))}
      </Box>
    </Box>
  );
}

/** 알림 모두를 확인 처리한다. 하나라도 실패하면 확인 창에 몇 건이 남았는지 보인다(나머지는 이미 지워졌다) */
function AckAll({ notices, answer }: { notices: InboxItem[]; answer: Answer }) {
  return (
    <DrawerActions
      actions={[
        {
          id: 'inbox-ack-all',
          label: t('office.inboxAckAll'),
          description: t('office.inboxAckAllTip'),
          icon: DoneAllIcon,
          text: true,
          confirm: {
            message: t('office.inboxAckAllConfirm', { n: notices.length }),
            okLabel: t('office.inboxAckAll'),
            onConfirm: async () => {
              const r = await Promise.allSettled(notices.map((i) => answer(i.id, {})));
              const bad = r.filter((x) => x.status === 'rejected').length;
              if (bad) throw new Error(t('office.inboxAckAllFailed', { n: bad }));
            },
          },
        },
      ]}
    />
  );
}
