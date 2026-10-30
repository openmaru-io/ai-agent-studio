/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 크론 작업 하나를 다루는 서랍: 지금 상태, 최근 실행, 주기 바꾸기, 켜기·끄기, 지금 실행, 전달 대상, 무시, 삭제.
// 바꾸는 일은 AAS 서버가 Hermes 대시보드 API 로 보낸다(Hermes 가 검증하고 저장한다).
import BoltOutlinedIcon from '@mui/icons-material/BoltOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import NotificationsActiveOutlinedIcon from '@mui/icons-material/NotificationsActiveOutlined';
import NotificationsOffOutlinedIcon from '@mui/icons-material/NotificationsOffOutlined';
import PauseCircleOutlineIcon from '@mui/icons-material/PauseCircleOutline';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutline';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  NativeSelect,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { ReactNode, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { ChatChip, KV, Labeled, LinkChip, Section, Tag } from '@/components/bits';
import { useConfirm } from '@/components/ConfirmDialog';
import { DrawerAction, DrawerActions } from '@/components/DrawerActions';
import { pageDrawer, type PageOf } from '@/components/drawerPages';
import { useDrawerHead, useDrawerPage } from '@/components/drawerScope';
import { Markdown } from '@/components/Markdown';
import { SkillPicker } from '@/components/SkillPicker';
import { TextEditor } from '@/components/TextEditor';
import { DrawerSpec, useUi } from '@/components/UiContext';
import { t } from '@/i18n';
import { get, post } from '@/lib/api';
import { describe, dowName, fmtNext, nextRuns } from '@/lib/cronmath';
import { confLabel } from '@/lib/flowLabels';
import { fmtTs } from '@/lib/format';
import { MONO_FONT } from '@/lib/monoFont';
import { buildExpr, initialSchedule, JobContext, ScheduleMode, ScheduleState, summaryLine } from '@/lib/schedule';
import { versionApi } from '@/lib/textApi';
import { useFocusOnMount } from '@/lib/useFocusOnMount';

import type { ExplainData, JobData } from './types';
const modes = (): [ScheduleMode, string][] => [
  ['daily', t('cronJob.modeDaily')],
  ['weekdays', t('cronJob.modeWeekdays')],
  ['weekly', t('cronJob.modeWeekly')],
  ['monthly', t('cronJob.modeMonthly')],
  ['minutes', t('cronJob.modeMinutes')],
  ['hours', t('cronJob.modeHours')],
  ['custom', t('cronJob.modeCustom')],
];

/** 주기 편집기. onSave 가 없으면 고르기만 하고(새 작업) 저장 줄은 그리지 않는다. */
export function ScheduleEditor({
  current,
  canEdit,
  onSave,
  onChange,
}: {
  current: string;
  canEdit: boolean;
  onSave?: (expr: string) => Promise<unknown>;
  onChange?: (expr: string) => void;
}) {
  const confirm = useConfirm();
  const [s, setS] = useState<ScheduleState>(() => initialSchedule(current));
  const expr = buildExpr(s);
  const runs = nextRuns(expr);
  const same = expr === (current || '').trim();
  useEffect(() => onChange?.(expr), [expr]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (p: Partial<ScheduleState>) => setS((cur) => ({ ...cur, ...p }));
  const showTime = ['daily', 'weekdays', 'weekly', 'monthly'].includes(s.mode);

  return (
    <Stack spacing={1.5}>
      <Labeled label={t('cronJob.mode')}>
        <NativeSelect
          value={s.mode}
          onChange={(e) => set({ mode: e.target.value as ScheduleMode })}
          inputProps={{ 'aria-label': t('cronJob.mode') }}
        >
          {modes().map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </NativeSelect>
      </Labeled>
      {showTime && (
        <TextField
          size="small"
          type="time"
          label={t('cronJob.time')}
          value={s.time}
          onChange={(e) => set({ time: e.target.value || '09:00' })}
          slotProps={{ inputLabel: { shrink: true } }}
        />
      )}
      {s.mode === 'weekly' && (
        <Stack direction="row" component="fieldset" sx={{ border: 0, p: 0, m: 0 }}>
          <legend>{t('cronJob.weekdayLegend')}</legend>
          {[1, 2, 3, 4, 5, 6, 0].map((d) => (
            <FormControlLabel
              key={d}
              label={dowName(d)}
              control={
                <Checkbox
                  size="small"
                  checked={s.days.includes(d)}
                  onChange={(e) => set({ days: e.target.checked ? [...s.days, d] : s.days.filter((x) => x !== d) })}
                />
              }
            />
          ))}
        </Stack>
      )}
      {s.mode === 'monthly' && (
        <TextField
          size="small"
          type="number"
          label={t('cronJob.date')}
          value={s.dom}
          onChange={(e) => set({ dom: Math.max(1, Math.min(31, Number(e.target.value) || 1)) })}
          slotProps={{ htmlInput: { min: 1, max: 31 } }}
          sx={{ width: 120 }}
        />
      )}
      {(s.mode === 'minutes' || s.mode === 'hours') && (
        <TextField
          size="small"
          type="number"
          label={s.mode === 'minutes' ? t('cronJob.everyMinutesLabel') : t('cronJob.everyHoursLabel')}
          value={s.n}
          onChange={(e) => set({ n: Number(e.target.value) || 1 })}
          slotProps={{ htmlInput: { min: 1, max: s.mode === 'minutes' ? 59 : 23 } }}
          sx={{ width: 140 }}
        />
      )}
      {s.mode === 'custom' && (
        <TextField
          size="small"
          label={t('cronJob.period')}
          value={s.custom}
          onChange={(e) => set({ custom: e.target.value })}
          placeholder="0 9 * * 1-5"
          slotProps={{ htmlInput: { spellCheck: false, style: { fontFamily: MONO_FONT } } }}
        />
      )}
      <Box aria-live="polite">
        <div>
          <code>{expr || '—'}</code>
          {describe(expr) && <Typography component="span" color="text.secondary">{` · ${describe(expr)}`}</Typography>}
        </div>
        <Typography variant="caption" color="text.secondary" component="div">
          {runs && runs.length
            ? t('cronJob.nextRuns', { list: runs.map(fmtNext).join(' → ') })
            : expr
            ? t('cronJob.noPreview')
            : t('cronJob.enterPeriod')}
        </Typography>
      </Box>
      {onSave &&
        (!canEdit ? (
          <Typography variant="caption" color="text.secondary">
            {t('cronJob.adminOnlyChange')}
          </Typography>
        ) : (
          <Box>
            <Button
              variant="contained"
              disabled={same || !expr}
              onClick={async () => {
                if (await confirm(t('cronJob.confirmChange', { from: current || t('cronJob.none'), to: expr }))) await onSave(expr);
              }}
            >
              {same ? t('cronJob.samePeriod') : t('cronJob.changePeriod')}
            </Button>
          </Box>
        ))}
    </Stack>
  );
}

// ---- 이 작업이 하는 일: 흐름 그래프에서 뽑은 설명 ----
const level = (k: string): [string, 'good' | 'warn' | 'bad'] =>
  (
    ({
      ok: [t('cronJob.levelOk'), 'good'],
      warn: [t('cronJob.levelWarn'), 'warn'],
      bad: [t('cronJob.levelBad'), 'bad'],
    }) as Record<string, [string, 'good' | 'warn' | 'bad']>
  )[k];
const ORDER = { bad: 0, warn: 1, ok: 2 };

function ExplainView({ d, ctx }: { d: ExplainData; ctx: JobContext }) {
  const checks = [...d.checks].sort((a, b) => ORDER[a.level] - ORDER[b.level]);
  const blocked = checks.filter((c) => c.level === 'bad').length;
  return (
    <>
      <Typography fontWeight={600}>{summaryLine(ctx)}</Typography>
      {d.skill && (
        <Box sx={{ my: 1, p: 1, border: 1, borderColor: 'divider', borderRadius: 1 }}>
          <div>
            <strong>{d.skill.name}</strong>{' '}
            <Typography component="span" variant="caption" color="text.secondary">
              {d.skill.where}
            </Typography>
          </div>
          {d.skill.description && <Markdown text={d.skill.description} />}
          {d.skill.outline.length > 0 && (
            <details>
              <summary>{t('cronJob.outline', { n: d.skill.outline.length })}</summary>
              <ul>
                {d.skill.outline.map((o, i) => (
                  <li key={i} style={{ marginLeft: (o.level - 1) * 14 }}>
                    {o.text}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            <LinkChip to="flows" params={{ root: d.skill.id }} page={{ kind: 'skillMap', root: d.skill.id }}>
              {t('cronJob.viewFlow')}
            </LinkChip>
            {d.root && d.root !== d.skill.id && (
              <LinkChip to="flows" params={{ root: d.root }} page={{ kind: 'skillMap', root: d.root }}>
                {t('cronJob.flowFromJob')}
              </LinkChip>
            )}
          </Stack>
        </Box>
      )}
      <Section title={blocked ? t('cronJob.conditionsBlocked', { n: blocked }) : t('cronJob.conditions')}>
        <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
          {checks.map((c, i) => (
            <li key={i}>
              <Tag tone={level(c.level)[1]}>{level(c.level)[0]}</Tag> {c.text}
            </li>
          ))}
        </Box>
      </Section>
      {d.groups.length > 0 && (
        <Section title={t('cronJob.calls')}>
          {d.groups.map((g) => (
            <Box key={g.title} sx={{ mb: 1 }}>
              <Typography variant="subtitle2" component="h4">{`${g.title} ${g.items.length}`}</Typography>
              <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
                {g.items.map((i, n) => (
                  <li key={n}>
                    <code>{i.label}</code>
                    {i.badges
                      .filter((b) => /만료|비어|없음|실패/.test(b))
                      .map((b) => (
                        <Tag key={b} tone={/만료됨|비어|실패/.test(b) ? 'bad' : 'warn'}>
                          {b}
                        </Tag>
                      ))}
                    <Tag
                      tone={
                        i.conf === 'mention' ? 'warn' : i.conf === 'doc' || i.conf === 'observed' ? undefined : 'good'
                      }
                    >
                      {confLabel(i.conf)?.[0] ?? i.conf}
                    </Tag>
                    {i.observed ? <Tag>{t('cronJob.observedTag', { count: i.observed })}</Tag> : null}
                    <Typography variant="caption" color="text.secondary" component="div">
                      {[
                        i.summary || i.sub,
                        i.by ? t('cronJob.fromBy', { by: i.by }) : '',
                        i.evidence?.line
                          ? t('cronJob.atLine', { file: i.evidence.file.split('/').pop(), line: i.evidence.line })
                          : '',
                        i.tools.length ? t('cronJob.toolsList', { list: i.tools.slice(0, 6).join(', ') }) : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Typography>
                    {i.evidence?.text && <code>{i.evidence.text}</code>}
                  </li>
                ))}
              </Box>
            </Box>
          ))}
        </Section>
      )}
      {d.observed && !d.observed.error && (
        <Typography variant="caption" color="text.secondary" component="p">
          {d.observed.hint ||
            t('cronJob.observedNote', {
              days: d.observed.days,
              scope: d.observed.scope,
              runs: d.observed.runs,
              matched: d.observed.matched,
            })}
        </Typography>
      )}
      <Typography variant="caption" color="text.secondary" component="p">
        {t('cronJob.explainNote')}
      </Typography>
    </>
  );
}

export function Explain({ query, ctx }: { query: Record<string, string>; ctx: JobContext }) {
  const key = new URLSearchParams(query).toString();
  const q = useQuery<ExplainData>({
    queryKey: ['cron-explain', key],
    queryFn: () => get<ExplainData>('/api/cron/explain?' + key),
  });
  if (q.error) return <Alert severity="warning">{q.error.message}</Alert>;
  if (!q.data) return <Typography color="text.secondary">{t('cronJob.loading')}</Typography>;
  return <ExplainView d={q.data} ctx={ctx} />;
}

// ---- 편집 줄 ----
function ChangeRow({
  label,
  current,
  initial,
  same,
  onSave,
  canEdit,
  children,
  input,
}: {
  label: string;
  current: string;
  initial: string;
  same: string;
  onSave: (v: string) => Promise<unknown>;
  canEdit: boolean;
  children?: ReactNode;
  input: (v: string, set: (v: string) => void) => ReactNode;
}) {
  const confirm = useConfirm();
  const { enqueueSnackbar } = useSnackbar();
  const [v, setV] = useState(initial);
  return (
    <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
      {input(v, setV)}
      {canEdit && (
        <Button
          onClick={async () => {
            if (v === current) return void enqueueSnackbar(same, { variant: 'info' });
            if (await confirm(t('cronJob.confirmChange', { from: current || t('cronJob.none'), to: v || t('cronJob.none') })))
              await onSave(v);
          }}
        >
          {label}
        </Button>
      )}
      {children}
    </Stack>
  );
}

/** 「이 작업 무시」 대화 상자의 양식(이유는 선택) */
function MuteForm({ onMute }: { onMute: (note: string) => Promise<unknown> }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const first = useFocusOnMount<HTMLInputElement>();
  return (
    <Stack spacing={1.5}>
      <Typography variant="body2" color="text.secondary">
        {t('cronJob.muteNote')}
      </Typography>
      <Stack direction="row" spacing={1}>
        <TextField
          size="small"
          inputRef={first}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('cronJob.muteReasonPlaceholder')}
          slotProps={{ htmlInput: { 'aria-label': t('cronJob.muteReason') } }}
          sx={{ flex: 1, minWidth: 180 }}
        />
        <Button
          variant="contained"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onMute(note);
          }}
        >
          {t('cronJob.muteJob')}
        </Button>
      </Stack>
    </Stack>
  );
}

function DeleteRow({ name, onDelete }: { name: string; onDelete: (typed: string) => Promise<unknown> }) {
  const [typed, setTyped] = useState('');
  const first = useFocusOnMount<HTMLInputElement>();
  return (
    <Stack spacing={1}>
      <Typography
        variant="caption"
        color="text.secondary"
        component="p"
      >{t('cronJob.deleteNote', { name })}</Typography>
      <Stack direction="row" spacing={1}>
        <TextField
          size="small"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={name}
          inputRef={first}
          slotProps={{ htmlInput: { 'aria-label': t('cronJob.confirmName'), spellCheck: false } }}
          sx={{ flex: 1 }}
        />
        <Button startIcon={<DeleteOutlineIcon />} color="error" variant="contained" disabled={typed !== name} onClick={() => onDelete(typed)}>
          {t('cronJob.delete')}
        </Button>
      </Stack>
    </Stack>
  );
}

const when = (ts?: number | string) => {
  const d = new Date(Number(ts) * 1000);
  return Number.isNaN(d.getTime())
    ? String(ts || '')
        .slice(0, 16)
        .replace('T', ' ')
    : fmtNext(d);
};
const secs = (r: JobData['runs'][number]) => {
  const a = Number(r.started_at);
  const b = Number(r.ended_at || r.finished_at);
  return a && b ? t('cronJob.seconds', { n: Math.round(b - a) }) : '';
};

export function JobDrawer({ profile, id, label }: { profile: string; id: string; label?: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { closeDrawer, drawerBack } = useUi();
  // 서랍 안에서 옮겨 온 페이지면 지운 뒤 이전 페이지로 돌아간다(스펙 2026-10-26-003 §5-8). 첫 페이지면 지금처럼 닫고 작업 목록으로
  const at = useDrawerPage()?.index ?? 0;
  const { enqueueSnackbar } = useSnackbar();
  const url = `/api/cron/job?profile=${encodeURIComponent(profile)}&id=${encodeURIComponent(id)}`;
  const q = useQuery<JobData>({ queryKey: ['cron-job', profile, id], queryFn: () => get<JobData>(url) });
  const d = q.data;
  if (!d)
    return q.error ? (
      <Alert severity="error">{q.error.message}</Alert>
    ) : (
      <Typography color="text.secondary">{t('cronJob.loading')}</Typography>
    );

  const j = d.job;
  const on = j.enabled && !j.paused_at && j.state !== 'paused';
  const sched = j.schedule_display || '';
  const name = j.name || j.id;
  const reload = async () => {
    await qc.invalidateQueries({ queryKey: ['cron-job', profile, id] });
  };
  const act = async (action: string, extra: Record<string, unknown>, done: string) => {
    try {
      // 주소(?open=)로 연 작업은 label 이 없다 — 받은 작업 이름을 보낸다
      await post('/api/cron/action', { profile, id, action, job_name: label || name, ...extra });
      enqueueSnackbar(done, { variant: 'success' });
      await qc.invalidateQueries({ queryKey: ['flows'] });
      await qc.invalidateQueries({ queryKey: ['health'] });
      await reload();
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    }
  };
  const mute = async (on: boolean, note: string) => {
    try {
      await post('/api/cron/mute', { profile, id, job_name: name, mute: on, note });
      enqueueSnackbar(on ? t('cronJob.muted', { name }) : t('cronJob.unmuted', { name }), { variant: 'success' });
      await reload();
      await qc.invalidateQueries({ queryKey: ['health'] });
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    }
  };
  // 서랍 머리의 동작 단추(COP Drawer 처럼 닫기 앞, OMAI-1135). 예전에는 본문의 「켜기·끄기·실행」·「무시」·「작업 삭제」 섹션이었다.
  // 누르면 대화 상자에서 확인한다(켜기·끄기·실행·무시 풀기는 확인/취소, 무시는 이유 입력, 삭제는 이름 다시 입력)
  const actions: DrawerAction[] = d.can_edit
    ? [
        on
          ? {
              id: 'pause',
              label: t('cronJob.turnOff'),
              description: t('cronJob.askPause'),
              icon: PauseCircleOutlineIcon,
              confirm: { message: t('cronJob.askPause'), okLabel: t('cronJob.turnOff'), onConfirm: () => act('pause', {}, t('cronJob.donePause', { name })) },
            }
          : {
              id: 'resume',
              label: t('cronJob.turnOn'),
              description: t('cronJob.askResume'),
              icon: PlayCircleOutlineIcon,
              confirm: { message: t('cronJob.askResume'), okLabel: t('cronJob.turnOn'), onConfirm: () => act('resume', {}, t('cronJob.doneResume', { name })) },
            },
        {
          id: 'trigger',
          label: t('cronJob.runOnce'),
          description: t('cronJob.askTrigger'),
          icon: BoltOutlinedIcon,
          confirm: { message: t('cronJob.askTrigger'), okLabel: t('cronJob.runOnce'), onConfirm: () => act('trigger', {}, t('cronJob.doneTrigger', { name })) },
        },
        d.muted
          ? {
              id: 'unmute',
              label: t('cronJob.unmute'),
              description: t('cronJob.unmuteTip'),
              icon: NotificationsActiveOutlinedIcon,
              confirm: { message: t('cronJob.unmuteTip'), okLabel: t('cronJob.unmute'), onConfirm: () => mute(false, '') },
            }
          : {
              id: 'mute',
              label: t('cronJob.muteJob'),
              description: t('cronJob.muteNote'),
              icon: NotificationsOffOutlinedIcon,
              dialog: { render: (close) => <MuteForm onMute={(note) => mute(true, note).then(close)} /> },
            },
        {
          id: 'delete',
          label: t('cronJob.delete'),
          description: t('cronJob.deleteTip'),
          icon: DeleteOutlineIcon,
          danger: true,
          dialog: {
            render: (close) => (
              <DeleteRow
                name={name}
                onDelete={async (typed) => {
                  try {
                    await post('/api/cron/action', { profile, id, action: 'delete', job_name: name, confirm: typed });
                    enqueueSnackbar(t('cronJob.deleted', { name }), { variant: 'success' });
                    await qc.invalidateQueries({ queryKey: ['flows'] });
                    close();
                    if (at > 0) return void drawerBack();
                    closeDrawer();
                    navigate(`/cron?tab=jobs&profile=${encodeURIComponent(profile)}`);
                  } catch (e) {
                    enqueueSnackbar((e as Error).message, { variant: 'error' });
                  }
                }}
              />
            ),
          },
        },
      ]
    : [];
  const skill = (j.skills || [])[0] || j.skill || '';
  const deliver = j.deliver || 'local';
  const targets = d.targets ?? [];
  const opts = targets.some((x) => x.id === deliver)
    ? targets
    : [{ id: deliver, name: t('cronJob.currentValue', { deliver }), ready: true }, ...targets];

  return (
    <>
      <DrawerActions actions={actions} />
      {!d.can_edit && (
        <Typography variant="caption" color="text.secondary" component="p">
          {t('cronJob.adminOnlyChange')}
        </Typography>
      )}
      <Section title={t('cronJob.whatItDoes')}>
        <Explain
          query={{ profile, job: id, deliver }}
          ctx={{ profile, schedule: sched, skill, script: j.script || '', deliver: j.deliver, noAgent: j.no_agent }}
        />
      </Section>
      <KV
        pairs={[
          [
            t('cronJob.status'),
            <span key="s">
              {on ? <Tag tone="good">{t('cron.on')}</Tag> : <Tag>{t('cron.off')}</Tag>}
              {j.last_status ? (
                <Tag tone={j.last_status === 'ok' ? 'good' : 'bad'}>{t('cronJob.lastRunStatus', { status: j.last_status })}</Tag>
              ) : (
                <Tag>{t('cronJob.neverRun')}</Tag>
              )}
              {j.failure_streak ? <Tag tone="bad">{t('cronJob.failStreak', { count: j.failure_streak })}</Tag> : null}
            </span>,
          ],
          [
            t('cronJob.period'),
            <span key="p">
              <code>{sched || t('cronJob.none')}</code>
              {describe(sched) ? ` · ${describe(sched)}` : ''}
            </span>,
          ],
          [t('cronJob.nextRun'), on ? fmtTs(j.next_run_at) : t('cronJob.offNoRun')],
          [t('cron.lastRun'), fmtTs(j.last_run_at)],
          [
            t('cron.deliverLabel'),
            <span key="d">
              {deliver}
              {deliver === 'local' && <Tag tone="warn">{t('cronJob.noNoticeOnFail')}</Tag>}
            </span>,
          ],
          [
            t('cronJob.runsWhat'),
            <span key="r">
              {(j.skills || (j.skill ? [j.skill] : [])).map((s) => (
                <LinkChip key={s} to="skills" params={{ tab: 'all', profile, q: String(s).split('/').pop() }}>
                  {t('cron.skillsList', { list: s })}
                </LinkChip>
              ))}
              {j.script && (
                <LinkChip to="tools" params={{ tab: 'all', q: String(j.script).split('/').pop() }}>
                  {t('cron.scriptsList', { list: j.script })}
                </LinkChip>
              )}
              {j.no_agent ? t('cronJob.noAgent') : ''}
            </span>,
          ],
          [t('cron.jobId'), <code key="i">{j.id}</code>],
          [
            t('cronJob.mute'),
            d.muted ? (
              <span key="m">
                <Tag>{t('cronJob.muting')}</Tag>
                {` ${(d.muted.ts || '').slice(0, 10)} · ${d.muted.by_name || d.muted.by || ''}` + (d.muted.note ? ` · ${d.muted.note}` : '')}
              </span>
            ) : (
              ''
            ),
          ],
        ]}
      />
      {j.last_error && (
        <Section title={t('cronJob.lastError')}>
          <Box component="pre" sx={{ whiteSpace: 'pre-wrap', fontFamily: MONO_FONT, fontSize: 13 }}>
            {j.last_error}
          </Box>
        </Section>
      )}
      <Section title={t('cronJob.changePeriodTitle')}>
        <ScheduleEditor
          current={sched}
          canEdit={d.can_edit}
          onSave={(expr) => act('schedule', { schedule: expr }, t('cronJob.periodChanged', { name }))}
        />
      </Section>
      <Section title={t('cronJob.deliverTarget')}>
        <ChangeRow
          label={t('cronJob.changeTarget')}
          current={deliver}
          initial={deliver}
          same={t('cronJob.sameTarget')}
          canEdit={d.can_edit}
          onSave={(v) => act('deliver', { deliver: v }, t('cronJob.targetChanged', { name }))}
          input={(v, set) => (
            <NativeSelect
              value={v}
              disabled={!d.can_edit}
              onChange={(e) => set(e.target.value)}
              inputProps={{ 'aria-label': t('cronJob.deliverTarget') }}
            >
              {opts.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name +
                    (o.ready ? '' : t('cronJob.targetNotReady')) +
                    (o.id === 'local' ? t('cronJob.targetLocalNote') : '')}
                </option>
              ))}
            </NativeSelect>
          )}
        />
        <Typography variant="caption" color="text.secondary" component="p">
          {deliver.split(':')[0] === 'local'
            ? t('cronJob.localNote')
            : t('cronJob.remoteNote')}
        </Typography>
      </Section>
      <Section title={t('cronJob.recentRuns', { n: d.runs.length })}>
        {d.runs.length ? (
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {d.runs.map((r, i) => (
              <li key={i}>
                {when(r.started_at)}
                {secs(r) && (
                  <Typography component="span" variant="caption" color="text.secondary">
                    {' · ' + secs(r)}
                  </Typography>
                )}
                {r.status && <Tag tone={r.status === 'ok' ? 'good' : 'bad'}>{r.status}</Tag>}
                {r.tool_call_count != null && (
                  <Typography
                    component="span"
                    variant="caption"
                    color="text.secondary"
                  >{t('cronJob.toolCalls', { count: r.tool_call_count })}</Typography>
                )}
              </li>
            ))}
          </Box>
        ) : (
          <Typography color="text.secondary">
            {t('cronJob.noRuns')}
          </Typography>
        )}
      </Section>
      {d.note_doc && (
        <Section title={t('cronJob.note')}>
          <TextEditor
            label={t('cronJob.note')}
            compact
            doc={d.note_doc}
            editable={d.can_edit}
            whyNot={t('cronJob.adminOnlyEdit')}
            draftKey={`jobnote:${profile}/${id}`}
            hint={t('cronJob.noteHint')}
            save={(c, sha, note) => post('/api/cron/note', { profile, id, content: c, base_sha: sha, note })}
            reload={reload}
            {...versionApi(`jobnote:${profile}/${id}`)}
          />
        </Section>
      )}
      <Section title={t('cronJob.prompt')}>
        <TextEditor
          label={t('cronJob.prompt')}
          compact
          doc={d.prompt_doc}
          editable={d.can_edit && !d.prompt_doc.masked_lines?.length}
          whyNot={!d.can_edit ? t('cronJob.adminOnlyEdit') : t('cronJob.maskedNoEdit')}
          draftKey={`jobprompt:${profile}/${id}`}
          hint={t('cronJob.promptHint')}
          save={(c, sha, note) =>
            post('/api/cron/action', { profile, id, action: 'prompt', content: c, base_sha: sha, note })
          }
          reload={reload}
          {...versionApi(`jobprompt:${profile}/${id}`)}
        />
      </Section>
      {d.can_edit && (
        <Section title={t('cronJob.skillToRun')}>
          <ChangeRow
            label={t('cronJob.changeSkill')}
            current={skill}
            initial={skill}
            same={t('cronJob.sameSkill')}
            canEdit
            onSave={(v) => act('skill', { skill: v.trim() }, v ? t('cronJob.skillChanged', { name }) : t('cronJob.skillRemoved', { name }))}
            input={(v, set) => (
              <SkillPicker value={v} onChange={set} profile={profile} sx={{ flex: 1, minWidth: 220 }} />
            )}
          />
        </Section>
      )}
      <Section title={t('cron.alsoSee')}>
        <LinkChip to="flows" params={{ root: `cron:${profile}/${id}` }} page={{ kind: 'skillMap', root: `cron:${profile}/${id}` }}>
          {t('cron.flowPicture')}
        </LinkChip>
        <ChatChip agent={profile}>{t('cron.chatWith', { profile })}</ChatChip>
      </Section>
      <Typography variant="caption" color="text.secondary" component="p">
        {t('cronJob.footer')}
      </Typography>
    </>
  );
}

/** 작업 서랍. 페이지 서랍이라 그 안의 「스킬 연결도 보기」가 같은 서랍에서 열린다(스펙 2026-10-26-003 외부 검토 H2) */
export const jobDrawerSpec = (profile: string, id: string, label?: string): DrawerSpec =>
  pageDrawer(
    { kind: 'cronJob', profile, id, label },
    { title: label || id, sub: t('cronJob.drawerSub', { profile }), body: <JobDrawer profile={profile} id={id} label={label} /> }
  );

/** 서랍 안에서 연 작업(스펙 2026-10-26-003 D5 1단계). 머리는 jobDrawerSpec 과 같다 */
export function JobPage({ page }: { page: PageOf<'cronJob'> }) {
  // 주소(?open=)로 연 작업은 보이는 이름(label)이 없다 — 받은 작업 이름을 제목으로 쓴다(JobDrawer 와 같은 조회, 스펙 2026-10-28-014)
  const url = `/api/cron/job?profile=${encodeURIComponent(page.profile)}&id=${encodeURIComponent(page.id)}`;
  const q = useQuery<JobData>({ queryKey: ['cron-job', page.profile, page.id], queryFn: () => get<JobData>(url) });
  useDrawerHead({ title: page.label || q.data?.job.name || page.id, sub: t('cronJob.drawerSub', { profile: page.profile }) });
  return <JobDrawer profile={page.profile} id={page.id} label={page.label} />;
}
