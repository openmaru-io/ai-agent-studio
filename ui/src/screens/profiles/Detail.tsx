/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 프로파일 상세: 개요, 성격(SOUL), 작업 지침(AGENTS.md), 설정(config), 비밀값, 스킬, 도구묶음·MCP, 크론. 바꾸는 일은 모두 Hermes API 로 간다.
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import DoneAllIcon from '@mui/icons-material/DoneAll';
import DriveFileRenameOutlineOutlinedIcon from '@mui/icons-material/DriveFileRenameOutlineOutlined';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import FileUploadOutlinedIcon from '@mui/icons-material/FileUploadOutlined';
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import StopCircleOutlinedIcon from '@mui/icons-material/StopCircleOutlined';
import {
  Alert,
  Box,
  Button,
  NativeSelect,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { ReactNode, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { ChatChip, IssueList, KV, LinkChip, ScreenLoading, Section, Tag } from '@/components/bits';
import { useConfirm } from '@/components/ConfirmDialog';
import { DrawerAction, DrawerActions } from '@/components/DrawerActions';
import { DrawerBadges, DrawerNote } from '@/components/DrawerBadges';
import { GuideHint } from '@/components/help/GuideRunner';
import { TabCountBadge } from '@/components/TabCountBadge';
import { TeamTargetNote } from '@/components/TeamTargetNote';
import { TextEditor } from '@/components/TextEditor';
import { useUi } from '@/components/UiContext';
import { RequestAdminButton } from '@/features/requests/RequestAdminButton';
import { t } from '@/i18n';
import { ApiError, get, post } from '@/lib/api';
import { useMe } from '@/lib/data';
import { fmtTs } from '@/lib/format';
import { PANE_GUIDES } from '@/lib/guides';
import { versionApi } from '@/lib/textApi';
import { useFocusOnMount } from '@/lib/useFocusOnMount';
import { useTopic } from '@/lib/ws';

import { AgentChangedAlert, AgentRowValue, ChatDefaultValue, NotInAgent, useAgentScope } from './AgentScope';
import { AgentsBanner, AgentsEmpty, AgentsReadError, agentsWhy } from './AgentsNotices';
import { ChannelPane } from './ChannelPane';
import { busyImportText, canDelete, DeleteBody } from './DeleteProfile';
import { DoNotUseTag } from './DoNotUse';
import { CronPane, EnvPane, SkillsPane, ToolsPane, useCronJobs } from './Panes';
import { PcExport } from './PcExport';
import { PcImport } from './PcImport';
import { exportMain, TEMP_PREFIX, usePcImport } from './pcImportApi';
import {
  capWhy,
  ChannelTag,
  DEFAULT_MODEL_REF,
  detailRefetchMs,
  GatewayTag,
  mayManage,
  type McpLoginTopic,
  mergeMcpLogin,
  modelLabel,
  PaneUnreadable,
  profileFilePath,
  profileQuery,
  useProfileAct,
} from './shared';
import { SoulTemplateBar } from './SoulTemplateBar';
import { type ProfileSpot, ProfileSpotContext, useProfileSpot } from './spot';
import type { ProfileDetailData } from './types';

// 문장은 그릴 때 만든다(언어를 바꾸면 바뀌어야 한다)
const panes = (): [string, string][] => [
  ['overview', t('profiles.pane.overview')],
  ['soul', t('profiles.pane.soul')],
  // main 서랍에서 바로 보이게 성격 다음(2026-10-19-004 O8·D4)
  ['agents', t('profiles.pane.agents')],
  ['config', t('profiles.pane.config')],
  ['env', t('profiles.pane.env')],
  ['skills', t('profiles.skills')],
  ['tools', t('profiles.pane.tools')],
  ['cron', t('profiles.cron')],
  ['channels', t('profiles.pane.channels')],
];

type Dirty = (v: boolean) => void;

/** 주 모델 고르기 목록: 「AAS 기본 모델」 한 줄 + LiteLLM 대화용 모델. 기본 모델과 같은 이름은 빼서 두 번 나오지 않게 한다.
 * 「AAS 기본 모델」은 서버가 기본 모델 이름을 알거나 지금 값이 자리표시자일 때만 둔다 — 둘 다 아니면(자리표시자를 쓰지 않는
 * 로컬 시험 환경 등) 에이전트가 이 글자를 풀지 못할 수 있다. 지금 값이 목록에 없으면(이름으로 고정된 기본 모델·LiteLLM 에 없는 모델) 그대로 넣는다 */
function modelOptions(current: string | undefined, models: string[], defaultName?: string): string[] {
  const rest = models.filter((m) => m !== defaultName);
  const out = defaultName || current === DEFAULT_MODEL_REF ? [DEFAULT_MODEL_REF, ...rest] : [...models];
  if (current && !out.includes(current)) out.splice(current === defaultName ? 1 : out.length, 0, current);
  return out;
}

function Overview({ d, onDirty }: { d: ProfileDetailData; onDirty: Dirty }) {
  const p = d.profile;
  const edit = d.can_edit;
  const { act, refresh } = useProfileAct(p.name);
  const confirm = useConfirm();
  const { enqueueSnackbar } = useSnackbar();
  const [model, setModel] = useState(p.model ?? '');
  const stops = t('profiles.stops', { count: p.jobs_active });
  const agent = useMe().data?.pod;
  const scope = useAgentScope();

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      enqueueSnackbar(ok, { variant: 'success' });
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    }
    await refresh();
  };
  const ask = async (message: string, fn: () => Promise<unknown>, ok: string) => {
    if (await confirm(message)) await run(fn, ok);
  };
  const gateway = (op: string) => act('gateway', { op });
  const ackable = p.issues.filter((i) => i.ack && i.sig);

  return (
    <Box>
      {p.issues.length > 0 && (
        <Section
          title={t('profiles.issuesTitle')}
          action={
            // 「모두 확인」: 확인할 수 있는 주의·안내가 둘 이상일 때. 문제는 남는다(2026-10-30)
            ackable.length > 1 ? (
              <Button
                size="small"
                startIcon={<DoneAllIcon />}
                onClick={() =>
                  void ask(
                    t('common.issueAckAllConfirm', { n: ackable.length }),
                    () => post('/api/profile/issue/ack', { profile: p.name, sigs: ackable.map((i) => i.sig), code: 'all' }),
                    t('common.issueAckAllDone', { n: ackable.length })
                  )
                }
              >
                {t('common.issueAckAll')}
              </Button>
            ) : undefined
          }
        >
          {/* 주의·안내는 확인 버튼으로 뺀다. 값이 바뀌면 다시 나온다(2026-10-30, 스펙 2026-10-24-003 §13) */}
          <IssueList
            issues={p.issues}
            onAck={(i) => void run(() => post('/api/profile/issue/ack', { profile: p.name, sig: i.sig, code: i.code }), t('common.issueAckDone'))}
          />
        </Section>
      )}
      <KV
        stack
        hints={{ [t('profiles.agentRow')]: t('profiles.agentRowHint') }}
        pairs={[
          // 이 프로파일이 들어 있는 에이전트(2026-10-19-001 R4, 2026-10-19-011 A2·A3). 목록에 있으면 에이전트 화면의 그 줄을 연다
          ...(agent
            ? ([[t('profiles.agentRow'), <AgentRowValue key="a" inList={scope.inList} />]] as [string, ReactNode][])
            : []),
          // 채팅이 먼저 여는 프로파일인가(2026-10-19-018 C2). 숨긴 루트는 고를 수 없다
          ...(agent && scope.inList && !p.hidden_root
            ? ([[t('profiles.chatDefaultRow'), <ChatDefaultValue key="c" name={p.name} canChange={d.can_edit || mayManage(d)} />]] as [string, ReactNode][])
            : []),
          [t('profiles.gateway'), <GatewayTag key="g" r={p} short />],
          [
            t('profiles.channels'),
            p.channels.length ? p.channels.map((c) => <ChannelTag key={c.name} c={c} />) : t('profiles.noChannels'),
          ],
          [
            t('profiles.cron'),
            p.failed_jobs
              ? t('profiles.cronSummaryFailed', { total: p.jobs_total, active: p.jobs_active, failed: p.failed_jobs })
              : t('profiles.cronSummary', { total: p.jobs_total, active: p.jobs_active }),
          ],
          [
            t('profiles.skills'),
            d.skills
              ? t('profiles.skillsSummary', {
                  total: d.skills.length,
                  enabled: d.skills.filter((x) => x.enabled).length,
                  own: p.skills,
                })
              : t('profiles.count', { n: p.skills }),
          ],
          [t('profiles.mcpServers'), p.mcp.join(', ') || t('profiles.none')],
          [
            t('profiles.credentials'),
            p.creds_expiring
              ? t('profiles.countExpiring', { n: p.creds, expiring: p.creds_expiring })
              : t('profiles.count', { n: p.creds }),
          ],
          [
            t('profiles.last7d'),
            p.last_activity
              ? t('profiles.sessionsLast', { n: p.sessions_7d, ts: fmtTs(p.last_activity) })
              : t('profiles.sessions', { n: p.sessions_7d }),
          ],
        ]}
      />
      <Section title={t('profiles.about')}>
        <TextEditor
          label={t('profiles.about')}
          compact
          editable={edit}
          whyNot={t('profiles.adminOnlyEdit')}
          draftKey={`desc:${d.pod ?? ''}:${p.name}`}
          doc={{ lines: (p.description || '').split('\n'), sha: '', versions: 0 }}
          check={(c) => (c.length > 600 ? t('profiles.aboutTooLong') : '')}
          save={(c) => act('describe', { description: c.replace(/\s*\n\s*/g, ' ').trim() })}
          reload={refresh}
          onDirtyChange={onDirty}
        />
      </Section>
      <Section title={t('profiles.mainModel')}>
        {edit ? (
          <Stack direction="row" spacing={1} data-guide="profiles.model">
            <NativeSelect
              value={model}
              onChange={(e) => setModel(e.target.value)}
              inputProps={{ 'aria-label': t('profiles.mainModel') }}
            >
              {modelOptions(p.model, d.models, d.default_model).map((m) => (
                <option key={m} value={m}>
                  {m === DEFAULT_MODEL_REF
                    ? modelLabel(m, d.default_model)
                    : m +
                      (d.blocked_models?.includes(m)
                        ? ' ' + t('profiles.blockedRoute')
                        : d.models.includes(m)
                        ? ''
                        : ' ' + t('profiles.notInLitellm'))}
                </option>
              ))}
            </NativeSelect>
            <Button
              onClick={() =>
                model === p.model
                  ? enqueueSnackbar(t('profiles.sameModel'), { variant: 'info' })
                  : ask(
                      t('profiles.changeModelAsk', {
                        from: modelLabel(p.model, d.default_model) || t('profiles.none'),
                        to: modelLabel(model, d.default_model),
                      }),
                      () => act('model', { model }),
                      t('profiles.modelChanged', { name: p.name, model: modelLabel(model, d.default_model) })
                    )
              }
            >
              {t('profiles.changeModel')}
            </Button>
          </Stack>
        ) : (
          <Stack direction="row" spacing={1.5} alignItems="center">
            <code>{modelLabel(p.model, d.default_model) || t('profiles.none')}</code>
            {d.owner && (
              // 가이드가 강조하는 자리(OMAI-1274 user.change-model)
              <Box component="span" data-guide="profiles.request-model" sx={{ display: 'inline-flex' }}>
                <RequestAdminButton profile={p.name} kind="model_change" label={t('requests.askModel')} />
              </Box>
            )}
            {capWhy(d, 'model') && d.owner && (
              <Typography variant="caption" color="text.secondary">
                {capWhy(d, 'model')}
              </Typography>
            )}
          </Stack>
        )}
        <Typography variant="caption" color="text.secondary" component="p">
          {t('profiles.modelOnlyLitellm')}
        </Typography>
      </Section>
      <Section title={t('profiles.gateway')}>
        {d.gateway_shared && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {t('profiles.gwSharedNote')}
          </Typography>
        )}
        {edit ? (
          <Stack direction="row" spacing={1}>
            {d.gateway_shared ? (
              // 컨테이너 안 Hermes 는 프로파일별 시작·멈추기를 하지 않는다 — 기본(루트) 게이트웨이 다시 시작만(서버가 루트로 보낸다)
              <Button
                startIcon={<RestartAltIcon />}
                onClick={() =>
                  ask(t('profiles.gwSharedRestartAsk'), () => gateway('restart'), t('profiles.gwRestartRequested', { name: p.name }))
                }
              >
                {t('profiles.gwRestart')}
              </Button>
            ) : p.running ? (
              <>
                <Button
                  startIcon={<RestartAltIcon />}
                  onClick={() =>
                    ask(
                      t('profiles.gwRestartAsk', { stops }),
                      () => gateway('restart'),
                      t('profiles.gwRestartRequested')
                    )
                  }
                >
                  {t('profiles.gwRestart')}
                </Button>
                <Button
                  color="error"
                  startIcon={<StopCircleOutlinedIcon />}
                  onClick={() => ask(t('profiles.gwStopAsk', { stops }), () => gateway('stop'), t('profiles.gwStopRequested', { name: p.name }))}
                >
                  {t('profiles.gwStop')}
                </Button>
              </>
            ) : (
              <Button
                variant="contained"
                startIcon={<PlayArrowOutlinedIcon />}
                onClick={() =>
                  ask(
                    t('profiles.gwStartAsk'),
                    () => gateway('start'),
                    t('profiles.gwStartRequested', { name: p.name })
                  )
                }
              >
                {t('profiles.gwStart')}
              </Button>
            )}
          </Stack>
        ) : (
          <Typography variant="caption" color="text.secondary">
            {t('profiles.adminOnlyChange')}
          </Typography>
        )}
        <Typography variant="caption" color="text.secondary" component="p">
          {t('profiles.gwNote')}
        </Typography>
      </Section>
      <Section title={t('profiles.relatedTitle')}>
        <ChatChip agent={p.name}>{t('profiles.chat')}</ChatChip>
        <LinkChip to="cron" params={{ tab: 'jobs', profile: p.name }}>
          {t('profiles.cronHealth')}
        </LinkChip>
        <LinkChip to="flows" params={{ tab: 'cron', profile: p.name }}>
          {t('profiles.flowsFromCron')}
        </LinkChip>
        <LinkChip to="channels" params={{ tab: 'all', q: p.name }}>
          {t('profiles.channels')}
        </LinkChip>
        <LinkChip to="credentials" params={{ tab: 'all', profile: p.name }}>
          {t('profiles.credentials')}
        </LinkChip>
        <LinkChip to="profiles" params={{ name: p.name, pane: 'env' }}>
          {t('profiles.setSecrets')}
        </LinkChip>
        <LinkChip to="models" params={{ tab: 'profiles', q: p.name }}>
          {t('profiles.modelSettings')}
        </LinkChip>
        <LinkChip to="activity" params={{ tab: 'profiles', q: p.name }}>
          {t('profiles.activity')}
        </LinkChip>
      </Section>
    </Box>
  );
}

type TextKind = 'soul' | 'config' | 'agents';
const FILE_OF: Record<TextKind, string> = { soul: 'SOUL.md', config: 'config.yaml', agents: 'AGENTS.md' };

function TextPane({ d, kind, onDirty }: { d: ProfileDetailData; kind: TextKind; onDirty: Dirty }) {
  const name = d.profile.name;
  const { enqueueSnackbar } = useSnackbar();
  const { act, refresh } = useProfileAct(name);
  const doc = kind === 'soul' ? d.soul : kind === 'config' ? d.config : d.agents;
  const isRoot = !!d.profile.is_default;
  // SOUL·config 는 관리자와 에이전트 주인이 고친다. 주인의 config 는 잠글 키(모델·제공자 등)를 서버가 막는다(OMAI-1126, 스펙 2026-10-15-011 D4)
  const canWrite = kind === 'agents' && d.caps?.agents ? d.caps.agents.can : d.can_edit || mayManage(d);
  // 템플릿(SOUL)이나 예시(AGENTS.md)에서 시작하면 편집기를 그 글로 열고, SOUL 은 저장할 때 어느 템플릿 판을 적용했는지 함께 보낸다(009 D2)
  const [seed, setSeed] = useState<{ text: string; nonce: number; note: string } | undefined>();
  const [applied, setApplied] = useState<{ id: string; lang: string; rev: number } | null>(null);
  // 작업 지침: 저장 성공 안내(새 대화에서 확인 단추와 함께)와 고치는 중인지
  const [saved, setSaved] = useState(false);
  const [editingDirty, setEditingDirty] = useState(false);
  const agents = kind === 'agents' ? d.agents ?? null : null;
  const reason = agents?.readonly_reason ?? null;
  // 옛 서버(agents 없음)나 읽기 오류는 본문 없이 오류와 「다시 읽기」(D5·D15)
  if (kind === 'agents' && (!agents || reason === 'read_error'))
    return (
      <PaneUnreadable d={d}>
        <AgentsReadError onReload={refresh} />
      </PaneUnreadable>
    );
  if (!doc)
    return (
      <PaneUnreadable d={d}>
        <Alert severity="warning">{kind === 'soul' ? t('profiles.soulUnreadable') : t('profiles.configUnreadable')}</Alert>
      </PaneUnreadable>
    );
  const label =
    kind === 'soul'
      ? t('profiles.soulFile', { name })
      : kind === 'config'
      ? t('profiles.configFile', { name })
      : t('profiles.agentsFile', { name });
  const kindQ = kind === 'soul' ? '' : `&kind=${kind}`;
  // 저장하면 알림이 갈 열린 방(디자인 결정 9A). 이름은 내가 구성원인 방만, 나머지는 수만(재검토 H3)
  const rooms = kind === 'soul' ? d.rooms : null;
  const roomCount = rooms ? rooms.names.length + rooms.others : 0;
  const masked = !!doc.masked_lines?.length;
  const editable = canWrite && !masked && !reason;
  // 작업 지침의 읽기 전용 사유는 하나만, 탭 맨 위에 회색 글자로 보이고 본문과 꺼진 「고치기」에 aria-describedby 로 잇는다(D5·D13)
  const whyId = `agents-why-${name}`;
  const agentsWhyText = kind === 'agents' ? (reason ? agentsWhy(reason) : !canWrite ? agentsWhy('view_only') : '') : '';
  const lines = doc.lines ?? [];
  const blank = !lines.join('').trim();
  // 되돌리기는 파일을 쓰는 일이라 기능 꺼짐·너무 큼·링크면 서버도 거절한다(§10 M5). 「확인함」은 파일을 건드리지 않는다
  const canRevert = canWrite && !masked && !['unsupported', 'truncated', 'link', 'hidden_root', 'view_only'].includes(reason ?? '');
  const max = agents?.limit ?? 20000;
  const dirtyOf: Dirty = (v) => {
    onDirty(v);
    setEditingDirty(v);
    if (v) setSaved(false);
  };
  return (
    <>
      {agentsWhyText && (
        <Typography id={whyId} variant="body2" color="text.secondary" component="p" sx={{ mb: 1 }} data-agents-why={reason ?? 'view_only'}>
          {agentsWhyText}
        </Typography>
      )}
      {agents && (
        <AgentsBanner name={name} doc={agents} canAck={canWrite} canRevert={canRevert} act={act} refresh={refresh} />
      )}
      {roomCount > 0 && canWrite && (
        <Alert severity="info" sx={{ mb: 1 }}>
          {t('profiles.soulRooms', {
            count: roomCount,
            names: [...rooms!.names, ...(rooms!.others ? [t('profiles.soulRoomsOthers', { count: rooms!.others })] : [])].join(', '),
          })}
        </Alert>
      )}
      {kind === 'config' && mayManage(d) && !d.can_edit && (
        <Alert severity="info" sx={{ mb: 1 }}>
          {t('profiles.configLockedNote')}
        </Alert>
      )}
      {kind === 'soul' && canWrite && !masked && (
        <SoulTemplateBar
          name={name}
          hint={d.soul_template ?? null}
          onStart={(text, tpl) => {
            setApplied({ id: tpl.id, lang: tpl.lang, rev: tpl.rev });
            setSeed((s) => ({ text, nonce: (s?.nonce ?? 0) + 1, note: t('profiles.soulFromTemplateNote', { name: tpl.name, rev: tpl.rev }) }));
          }}
        />
      )}
      {agents && saved && (
        <Alert severity="success" role="status" sx={{ mb: 1 }} onClose={() => setSaved(false)}>
          {t('profiles.agents.saved')}{' '}
          <ChatChip agent={name}>{t('profiles.agents.checkInChat')}</ChatChip>
        </Alert>
      )}
      {agents && blank && !editingDirty && (
        <AgentsEmpty
          exists={!!agents.exists}
          onExample={
            editable
              ? () => setSeed((s) => ({ text: t('profiles.agents.example'), nonce: (s?.nonce ?? 0) + 1, note: t('profiles.agents.exampleNote') }))
              : undefined
          }
        />
      )}
    {/* 가이드가 강조하는 자리(OMAI-1274 user.change-soul) */}
    <Box data-guide={kind === 'soul' ? 'profiles.soul' : undefined}>
    <TextEditor
      seed={kind === 'config' ? undefined : seed}
      label={label}
      doc={{ ...doc, lines }}
      editable={editable}
      mode={kind === 'config' ? 'code' : 'markdown'}
      // 열쇠에 에이전트를 넣는다 — 이름만 쓰면 다른 에이전트의 같은 이름 프로파일에서 옛 글이 「이어쓰기」로 떴다(스펙 2026-10-19-011 디자인 D6)
      draftKey={`${d.pod ?? ''}:${kind}:${name}`}
      filename={kind === 'soul' ? `${name}-SOUL.md` : kind === 'config' ? `${name}-config.yaml` : `${name}-AGENTS.md`}
      // 실제 파일 위치(Hermes 데이터 폴더 기준). 기본 프로파일은 폴더 바로 아래, 이름 있는 프로파일은 profiles/<이름>/ 아래다(OKE 에서 확인, 2026-10-17-016)
      path={agents?.path || profileFilePath(name, isRoot, FILE_OF[kind])}
      whyNot={
        kind === 'agents'
          ? undefined
          : !canWrite
          ? t(kind === 'soul' ? 'profiles.ownerOrAdminEdit' : 'profiles.adminOnlyEdit')
          : t('profiles.maskedNoEdit')
      }
      hint={kind === 'soul' ? t('profiles.soulHint') : kind === 'config' ? t('profiles.configHint') : t('profiles.agents.hint')}
      check={async (c) => {
        const r = await act<{ problem: string; warnings?: string[] }>(`${kind}_preview`, { content: c });
        return { problem: r.problem, warnings: r.warnings };
      }}
      save={async (c, sha, note) => {
        const r = await act<{ notice?: { rooms: number; failed?: boolean } }>(kind, {
          content: c,
          base_sha: sha,
          note,
          ...(kind === 'soul' && applied ? { template: applied } : {}),
        });
        setApplied(null);
        if (kind === 'agents') setSaved(true);
        // 알림만 실패하면 저장은 성공이다 — 따로 알린다(디자인 결정 6A)
        if (r.notice?.failed) enqueueSnackbar(t('profiles.soulNoticeFailed'), { variant: 'info' });
        return r;
      }}
      savedMessage={(r) => {
        const n = (r as { notice?: { rooms: number } } | undefined)?.notice?.rooms ?? 0;
        return n > 0 ? t('profiles.savedNotified', { label, count: n }) : undefined;
      }}
      noteHelp={roomCount > 0 ? t('profiles.soulNoteHelp') : undefined}
      {...versionApi(`${kind}:${name}`)}
      diff={(id) => get(`/api/profile/soul/diff?name=${encodeURIComponent(name)}&id=${id}${kindQ}`)}
      revert={(id, sha) => act(`${kind}_revert`, { id, base_sha: sha })}
      reload={refresh}
      onDirtyChange={dirtyOf}
      {...(kind === 'agents'
        ? {
            // 작업 지침만: 도움말은 편집기 아래, 글자 수 한도, 기능 꺼짐에도 꺼진 「고치기」, 저장 성공은 위 안내로(D3·D6·D9·D14)
            hintBelow: true,
            limit: { max, warn: (n: number) => t('profiles.agents.sizeWarn', { n, max }) },
            editDisabled: reason === 'unsupported',
            describedBy: agentsWhyText ? whyId : undefined,
            conflictText: t('profiles.agents.conflict'),
            silentSave: true,
            agentChip: true,
            notice: agents?.warnings?.length ? (
              <Stack spacing={0.5} sx={{ mb: 1 }}>
                {agents.warnings.map((w) => (
                  <Alert key={w} severity="warning">
                    {w}
                  </Alert>
                ))}
              </Stack>
            ) : undefined,
          }
        : {})}
    />
    </Box>
    </>
  );
}

function RenameBody({ name, bundle, onDone }: { name: string; /** 확인 단계의 PC 가져오기 묶음 파일 이름(함께 취소된다, DD7) */ bundle?: string; onDone?: () => void }) {
  const { act } = useProfileAct(name);
  const { closeDrawer } = useUi();
  const { enqueueSnackbar } = useSnackbar();
  const spot = useProfileSpot();
  const [value, setValue] = useState(name);
  const first = useFocusOnMount<HTMLInputElement>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await act<{ name: string }>('rename', { new_name: value.trim() });
      (onDone ?? closeDrawer)(); // 대화 상자에서 열었으면 대화 상자만 닫는다
      enqueueSnackbar(t('profiles.renamed', { from: name, to: r.name }), { variant: 'success' });
      spot.patch({ name: r.name });
    } catch (e) {
      setError(busyImportText(e));
      setBusy(false);
    }
  };
  return (
    // 위 여백: 대화 상자 제목 바로 아래라 칸의 떠 있는 라벨이 잘렸다(사용자 보고 2026-10-17, 2026-10-17-016)
    <Stack spacing={1.5} sx={{ pt: 1 }}>
      <TextField
        size="small"
        inputRef={first}
        label={t('profiles.newNameLabel')}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        slotProps={{ htmlInput: { spellCheck: false } }}
      />
      {bundle && <Typography variant="body2">{t('profiles.pcImport.cancelsBundle', { file: bundle })}</Typography>}
      {error && <Alert severity="error">{error}</Alert>}
      <Box>
        <Button variant="contained" disabled={busy} onClick={go}>
          {t('profiles.rename')}
        </Button>
      </Box>
      <Typography variant="caption" color="text.secondary">
        {t('profiles.renameNote')}
      </Typography>
    </Stack>
  );
}

/** 관리자나 주인이면 PC 에서 가져오기·내 PC 로 내보내기를 쓴다(OMAI-1136 §10-1, R3). 처음에는 main 만이었고, 이제 루트(default)와
 * 가져오기 임시 프로파일(pcimp-)이 아닌 프로파일 모두다(OMAI-1444 §4-3·OV10). pod 는 이 프로파일의 POD.
 * 상세를 받기 전에도 hook 순서를 지키도록 d 가 없을 수 있다. busy 는 가져오기가 진행 중인가, bundle 은 확인 단계 묶음 파일 이름 */
function usePcScope(d?: ProfileDetailData) {
  const me = useMe().data;
  const name = d?.profile.name ?? '';
  const can = !!d && !d.profile.is_default && !d.profile.hidden_root && !name.startsWith(TEMP_PREFIX) && (d.can_edit || mayManage(d));
  const pod = d?.pod || me?.pod?.id;
  const st = usePcImport(pod, name, can);
  const job = can ? st.data?.job : undefined;
  return { can, pod, busy: job?.state === 'running', bundle: job?.state === 'uploaded' ? job.name : '' };
}

/** 이 프로파일이 그 POD 의 main(주 프로파일)인가. 서버 caps 가 main_fixed 를 주면 그대로 따르고, 옛 응답이면 내 POD 의 주 프로파일 이름과 비교한다 */
const isMain = (d: ProfileDetailData, myPrimary?: string) => d.caps?.rename?.reason === 'main_fixed' || myPrimary === d.profile.name;

// 서랍 머리의 동작 단추(COP Drawer 처럼 닫기 앞). 예전에는 본문 오른쪽 「더 보기」 메뉴였다.
// 누르면 대화 상자를 거친다: 내 PC 로 내보내기는 확인/취소, 이름 바꾸기·삭제는 입력 양식(새 이름, 이름 다시 입력)
export function ProfileActions({ d }: { d: ProfileDetailData }) {
  const p = d.profile;
  const primary = useMe().data?.primary;
  const { openDrawer, updateDrawer } = useUi();
  const pc = usePcScope(d);
  const main = isMain(d, primary?.profile);
  const busyWhy = pc.busy ? t('profiles.pcImport.busyWhy') : undefined;
  // 내 PC 로 내보내기: 작업 폴더 밖에 묶음을 만들고 내려받기 단추가 있는 서랍을 연다(§10-3). 실패하면 확인 창 안에 오류를 보인다
  const exportPc = async () => {
    const r = await exportMain(pc.pod ?? '', p.name);
    openDrawer({ title: t('profiles.pcExport.action'), sub: p.name, body: <PcExport pod={pc.pod ?? ''} initial={r} main={main} /> });
  };
  // 가져오기 서랍: 단계가 바뀌면 부제목(「main · 1/2 내보내고 올리기」)을 바꾼다(D12). 본문은 같은 요소라 상태가 지켜진다
  const openImport = () => {
    const title = t('profiles.pcImport.action');
    let key = 0;
    const body = (
      <PcImport
        pod={pc.pod}
        profile={p.name}
        main={main}
        mcpLogins={(d.mcp ?? []).filter((m) => m.auth === 'oauth').length}
        onStep={(step) => updateDrawer(key, { title, sub: `${p.name} · ${step}`, body })}
      />
    );
    key = openDrawer({ title, sub: p.name, body });
  };
  // 단추 순서(OMAI-1444 DD1): 내 PC 로 내보내기 → PC 에서 가져오기 → 이름 바꾸기 → 삭제. 작업 폴더 「내보내기」는 뺐다(2026-10-23, R7 바꿈)
  const actions: DrawerAction[] = [
    ...(pc.can
      ? [
          {
            id: 'pc-export',
            label: t('profiles.pcExport.action'),
            description: t('profiles.pcExport.tip'),
            icon: FileDownloadOutlinedIcon,
            disabled: busyWhy,
            confirm: { message: t('profiles.pcExport.confirm', { name: p.name }), okLabel: t('profiles.pcExport.action'), onConfirm: exportPc },
          },
          {
            id: 'pc-import',
            label: t('profiles.pcImport.action'),
            description: t('profiles.pcImport.tip'),
            icon: FileUploadOutlinedIcon,
            disabled: busyWhy,
            onClick: openImport,
          },
        ]
      : []),
    // 이름 바꾸기: main(주 프로파일)은 관리자도 바꾸지 못한다 — 단추는 보이되 누를 수 없고 이유를 읽는다(2026-10-17-016).
    // 서버도 main 이름 바꾸기를 거절한다(server.py rename 분기). 예전에는 관리자에게 단추가 열려 있어 누르면 오류가 났다
    ...((d.can_edit || mayManage(d)) && !p.is_default
      ? [
          {
            id: 'rename',
            label: t('profiles.renameTitle'),
            description: t('profiles.renameNote'),
            icon: DriveFileRenameOutlineOutlinedIcon,
            disabled: main ? t('profiles.renameMainWhy') : busyWhy,
            dialog: { render: (close: () => void) => <RenameBody name={p.name} bundle={pc.bundle} onDone={close} /> },
          },
        ]
      : []),
    ...(!canDelete(d) && mayManage(d) && !d.can_edit && !p.is_default && primary?.profile === p.name   // 주인 화면의 main: 단추는 보이되 누를 수 없고 이유를 읽는다(디자인 결정 7A)
      ? [
          {
            id: 'delete',
            label: t('profiles.deleteAction'),
            description: t('profiles.deleteTip'),
            icon: DeleteOutlineIcon,
            danger: true,
            disabled: t('profiles.deleteMainWhy'),
          },
        ]
      : []),
    ...(canDelete(d)
      ? [
          {
            id: 'delete',
            label: t('profiles.deleteAction'),
            description: t('profiles.deleteTip'),
            icon: DeleteOutlineIcon,
            danger: true,
            // 가져오는 중에는 이름 바꾸기처럼 막는다(OMAI-1444 DD7)
            disabled: busyWhy,
            dialog: { title: t('profiles.deleteTitle'), render: (close: () => void) => <DeleteBody name={p.name} bundle={pc.bundle} onDone={close} /> },
          },
        ]
      : []),
  ];
  return <DrawerActions actions={actions} />;
}

// 서버가 주는 "soul: <이유>" 꼴의 안내를 이유가 같은 것끼리 묶는다. 대시보드에 닿지 않으면 여섯 부분이 같은 이유로 실패한다.
function groupNotes(notes: string[]): string[] {
  const parts = new Map<string, string[]>();
  for (const note of notes) {
    const m = /^([\w.-]+): (.+)$/s.exec(note);
    const [part, reason] = m ? [m[1], m[2]] : ['', note];
    parts.set(reason, [...(parts.get(reason) ?? []), ...(part ? [part] : [])]);
  }
  return [...parts].map(([reason, names]) => (names.length ? `${names.join(' · ')}: ${reason}` : reason));
}

/** spot: 서랍 안 페이지로 그릴 때의 위치(탭·비밀값 등). 없으면 주소를 쓴다(스펙 2026-10-26-003 외부 검토 M2).
 *  탭·이름 바꾸기·삭제·「없음」 안내와 각 탭(비밀값 key·MCP server·인증 파일 file·채널 add)이 이 문맥으로 읽고 쓴다 */
export function ProfileDetail({ spot, ...rest }: Parameters<typeof DetailBody>[0] & { spot?: ProfileSpot }) {
  return spot ? (
    <ProfileSpotContext.Provider value={spot}>
      <DetailBody {...rest} />
    </ProfileSpotContext.Provider>
  ) : (
    <DetailBody {...rest} />
  );
}

function DetailBody({
  name,
  inDrawer = false,
  onGuard,
}: {
  name: string;
  /** 목록 위 서랍 안에 그린다: 목록으로 돌아가기 단추와 큰 제목을 빼고(서랍 머리가 대신한다) 닫기 전 확인을 서랍에 건다 */
  inDrawer?: boolean;
  onGuard?: (fn: (() => Promise<boolean>) | null) => void;
}) {
  const spot = useProfileSpot();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const dirty = useRef(false);
  const qc = useQueryClient();
  const ws = !!useMe().data?.ws;
  const cached = qc.getQueryData<ProfileDetailData>(['profile', name]);
  // OAuth MCP 서버가 있으면 로그인 상태를 웹소켓 토픽으로 받는다 — 서버가 바뀌면 보내므로 상세 전체를 3초마다 다시 읽지 않는다(14-22)
  const mcpTopic = ws && cached?.pod && (cached.mcp ?? []).some((m) => m.auth === 'oauth') ? `pod:${cached.pod}:mcp:${name}` : null;
  const mcpLive = useTopic<McpLoginTopic>(mcpTopic, (v) =>
    qc.setQueryData<ProfileDetailData>(['profile', name], (old) => mergeMcpLogin(old, v))
  );
  const q = useQuery<ProfileDetailData>({
    ...profileQuery(name),
    // 읽지 못한 부분이 있거나 MCP 로그인이 끝나 가는 중이면 다시 읽는다. 그러지 않으면 회복·연결된 뒤에도 앞 상태가 남는다.
    refetchInterval: (query) => detailRefetchMs(query.state.data, mcpLive),
  });
  // 조회 열쇠에 에이전트가 없으므로(['profile', name]) 다른 에이전트로 바꾼 직후에는 캐시에 옛 에이전트 값이 남아 있다.
  // 응답의 pod 가 지금 에이전트와 다르면 그 값을 쓰지 않고 다시 읽는다(스펙 2026-10-19-011 R1 ②)
  const pod = useMe().data?.pod?.id;
  const stale = !!(pod && q.data?.pod && q.data.pod !== pod);
  const d = stale ? undefined : q.data;
  useEffect(() => {
    if (stale && !q.isFetching) void q.refetch();
  }, [stale, q.isFetching]); // eslint-disable-line react-hooks/exhaustive-deps
  const pane = panes().some((x) => x[0] === spot.get('pane')) ? (spot.get('pane') as string) : 'overview';
  const onDirty: Dirty = (v) => {
    dirty.current = v;
  };
  const guard = async () => !dirty.current || (await confirm(t('profiles.discardAsk')));
  const guardRef = useRef(guard);
  guardRef.current = guard;
  useEffect(() => {
    if (!onGuard) return;
    // 가이드(OMAI-1274)처럼 탭 단추 밖에서 확인을 부를 때도, 통과하면 고친 표시를 지워 다음 이동에서 같은 확인이 다시 뜨지 않게 한다
    onGuard(async () => {
      const ok = await guardRef.current();
      if (ok) dirty.current = false;
      return ok;
    });
    return () => onGuard(null);
  }, [onGuard]);

  const cronJobs = useCronJobs(name);
  const primary = useMe().data?.primary;
  const pcBusy = usePcScope(d).busy;
  // 같은 이름 칩으로 왔는데 그 에이전트에 이 이름이 없다(그사이 지워짐 등). 서버가 404 로 알린다(R8, 디자인 D9)
  if (!d && q.error instanceof ApiError && q.error.status === 404) return <NotInAgent name={name} />;
  if (!d) return <ScreenLoading title={name} error={stale ? undefined : q.error?.message} />;
  const p = d.profile;
  const body: Record<string, ReactNode> = {
    overview: <Overview d={d} onDirty={onDirty} />,
    // 세 탭은 같은 자리의 같은 부품이라 key 가 없으면 React 가 편집 상태(고치는 중인 글·기준 sha)를 다음 탭에 넘긴다
    soul: <TextPane key={`soul:${name}`} d={d} kind="soul" onDirty={onDirty} />,
    agents: <TextPane key={`agents:${name}`} d={d} kind="agents" onDirty={onDirty} />,
    config: <TextPane key={`config:${name}`} d={d} kind="config" onDirty={onDirty} />,
    env: <EnvPane d={d} />,
    skills: <SkillsPane d={d} />,
    tools: <ToolsPane d={d} />,
    cron: <CronPane d={d} />,
    channels: <ChannelPane d={d} />,
  };
  const heading = p.title && p.title.toLowerCase() !== p.name ? p.title : p.name;
  // 팀 관리자는 주인과 같은 범위를 고치지만 「내 에이전트」가 아니라 「팀원 에이전트」라고 쓴다(스펙 2026-10-22-001)
  const scopeNote = d.owner
    ? t(canDelete(d) ? 'profiles.ownerScopeDelete' : 'profiles.ownerScope')
    : mayManage(d)
      ? t(canDelete(d) ? 'profiles.teamScopeDelete' : 'profiles.teamScope')
      : t('profiles.viewOnly');

  return (
    <Box>
      <AgentChangedAlert />
      {/* 팀원 에이전트의 프로파일이면 서랍 머리에 누구의 것을 바꾸는지(비밀값·스킬 탭도 이 서랍 안이다, 스펙 2026-10-22-001 DD5) */}
      <TeamTargetNote />
      {/* 서랍에서는 이 줄에 보일 것이 없다(제목·뱃지·단추는 서랍 머리로 간다) — 여백을 두지 않는다 */}
      <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap flexWrap="wrap" sx={{ mb: inDrawer ? 0 : 1 }}>
        {!inDrawer && (
          <Button
            size="small"
            onClick={async () => {
              if (await guard()) {
                dirty.current = false;
                navigate('/profiles');
              }
            }}
          >
            {t('profiles.backToList')}
          </Button>
        )}
        {!inDrawer && (
          <Typography variant="h5" component="h1">
            {heading}
          </Typography>
        )}
        {!inDrawer && <code>{p.name}</code>}
        {/* 프로파일 제목(이름과 다를 때)과 상태 뱃지: 서랍에서는 머리의 제목 줄(DrawerBadges), 화면에서는 이 줄 그대로 */}
        <DrawerBadges>
          {inDrawer && heading !== p.name && (
            <Typography component="span" variant="body2" color="text.secondary" noWrap sx={{ minWidth: 0 }}>
              {heading}
            </Typography>
          )}
          {p.hidden_root ? <Tag tone="warn">{t('profiles.hiddenRoot')}</Tag> : p.is_default && <Tag>{t('profiles.default')}</Tag>}
          {p.hidden_root && <DoNotUseTag />}
          {primary?.profile === p.name && <Tag tone="good">{t('profiles.primaryTag')}</Tag>}
          {/* 가져오는 중: 무채색 표시(OMAI-1444 DD4, 빨강·앰버를 쓰지 않는다) */}
          {pcBusy && <Tag>{t('profiles.pcImport.stepRunning')}</Tag>}
          {d.owner ? <Tag>{t('profiles.mineTag')}</Tag> : d.owner_name ? <Tag>{t('profiles.ownedByTag', { name: d.owner_name })}</Tag> : null}
          <GatewayTag r={p} />
        </DrawerBadges>
        <Box sx={{ flex: 1 }} />
        <ProfileActions d={d} />
      </Stack>
      {/* 작업공간이 다시 뜨는 중이면 URLError 목록 대신 안내 한 줄(스펙 2026-10-23-008). 장애가 아니라 1~5분 기다리면 되는 상태다 */}
      {d.restarting && d.notes.length > 0 ? (
        <Alert severity="info" role="status" sx={{ mb: 1 }}>
          {t('profiles.restartingNotice')}
        </Alert>
      ) : d.notes.length > 0 && (
        <Alert severity="warning" sx={{ mb: 1 }}>
          <span id="profile-notes">{t('profiles.notesPrefix')}</span>
          <Box component="ul" aria-labelledby="profile-notes" sx={{ m: 0, pl: 2.5 }}>
            {groupNotes(d.notes).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </Box>
        </Alert>
      )}
      <Stack direction="row" alignItems="center" sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Tabs
          value={pane}
          aria-label={t('profiles.panesLabel')}
          variant="scrollable"
          onChange={async (_, id: string) => {
            if (!(await guard())) return;
            dirty.current = false;
            spot.patch({ name, pane: id === 'overview' ? null : id }, { replace: true });
          }}
        >
          {panes().map(([id, label]) => (
            <Tab
              key={id}
              value={id}
              data-guide={`profiles.tab.${id}`}
              sx={{ textTransform: 'none' }}
              label={(() => {
                // 개수는 오피스·목록 탭과 같은 원형 배지로. 개수가 없는 탭은 글자만
                const n = id === 'skills' ? d.skills?.length : id === 'cron' ? (cronJobs.data ? cronJobs.data.jobs.length : p.jobs_total) : undefined;
                return n == null ? <span>{label}</span> : <TabCountBadge count={n}>{label}</TabCountBadge>;
              })()}
            />
          ))}
        </Tabs>
        {/* 지금 탭에서 할 수 있는 일의 가이드를 바로 시작한다(OMAI-1274 T4) */}
        {PANE_GUIDES[pane] && <GuideHint guide={(d.can_edit && PANE_GUIDES[pane].admin) || PANE_GUIDES[pane].user} />}
        {/* 권한 안내: 서랍에서는 머리의 「프로파일 상세」 옆(DrawerNote) — 탭 옆에 두면 탭이 다 보이지 않고 넘겼다 */}
        {!d.can_edit && !inDrawer && (
          <Typography variant="caption" color="text.secondary" sx={{ ml: 2 }}>
            {scopeNote}
          </Typography>
        )}
      </Stack>
      {!d.can_edit && inDrawer && <DrawerNote>{scopeNote}</DrawerNote>}
      {d.can_edit && !d.owner && d.owner_name && inDrawer && (
        <DrawerNote>
          {t('profiles.scopeOthers')} <LinkChip to="settings">{t('profiles.settingsLink')}</LinkChip>
        </DrawerNote>
      )}
      <Box sx={{ pt: 2 }}>{body[pane]}</Box>
    </Box>
  );
}
