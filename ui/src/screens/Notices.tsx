/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 관리 › 공지(스펙 공지 바 4-6, 디자인 리뷰 2B·2C·2D·2E·3A·3B·3C·5D·5E·5F·5G). 관리자가 모든 사람 화면 맨 위 띠에 보일 공지를
// 만들고 고치고 내린다. 목록은 보기 카드 4개(보이는 중·예정·끝남·내림), 만들기·고치기는 서랍이다.
// 날짜 고르개(@mui/x-date-pickers)와 dayjs 는 이 화면 묶음에만 들어간다. 띠(NoticeBar)는 Intl 로 시각을 적는다(9-14 E10).
import 'dayjs/locale/ko';
import 'dayjs/locale/en';

import { Alert, Box, Button, Checkbox, FormControlLabel, FormHelperText, Radio, RadioGroup, Stack, Switch, TextField, Typography } from '@mui/material';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DateTimePicker } from '@mui/x-date-pickers/DateTimePicker';
import { koKR } from '@mui/x-date-pickers/locales';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs, { Dayjs } from 'dayjs';
import { useSnackbar } from 'notistack';
import { ReactNode, useEffect, useId, useRef, useState } from 'react';

import { useConfirm } from '@/components/ConfirmDialog';
import { GridAction, GridColumn, Pill } from '@/components/DataGrid';
import { ListView } from '@/components/ListView';
import { NOTICE_ICONS, NoticeBarView, noticeLink, noticeRange, noticeWhen } from '@/components/NoticeBar';
import { useUi } from '@/components/UiContext';
import { getLang, t } from '@/i18n';
import { ApiError, get, post } from '@/lib/api';
import { Notice, NOTICE_KINDS, NoticeKind } from '@/lib/useNotices';
import { teamKey, useDepartments } from '@/screens/users/departments';

export type NoticeStatus = 'active' | 'scheduled' | 'ended' | 'deleted';

export interface AdminNotice extends Notice {
  audience: 'all' | string[];
  status: NoticeStatus;
  author: string;
  author_name?: string;
  ts: string;
  editor: string;
  deleted: boolean;
}

interface NoticeListResp {
  notices: AdminNotice[];
  limited: boolean;
  limit: number;
}

export const NOTICES_KEY = ['notices-admin'];
const TITLE_MAX = 80;
const BODY_MAX = 300;
const FIELDS = ['kind', 'title', 'body', 'link', 'starts_at', 'ends_at', 'audience'] as const;
type Field = (typeof FIELDS)[number];

const useNoticeList = () => useQuery<NoticeListResp>({ queryKey: NOTICES_KEY, queryFn: () => get<NoticeListResp>('/api/notices') });

const STATUS_TONE: Record<NoticeStatus, 'good' | 'info' | undefined> = { active: 'good', scheduled: 'info', ended: undefined, deleted: undefined };

/** 대상 부서가 하나도 남지 않은 공지(부서를 지움). 부서 목록을 아직 모르면 거짓 */
function orphan(x: AdminNotice, known: Set<string> | null): boolean {
  return !!known && Array.isArray(x.audience) && x.audience.length > 0 && x.audience.every((d) => !known.has(teamKey(d)));
}

const audienceText = (x: Pick<AdminNotice, 'audience'>) => (x.audience === 'all' ? t('notices.audienceAll') : x.audience.join(', '));

function KindCell({ kind }: { kind: NoticeKind }) {
  const Icon = NOTICE_ICONS[kind];
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
      <Icon aria-hidden sx={{ fontSize: 16, color: 'text.secondary' }} />
      {t(`notice.kind.${kind}`)}
    </Box>
  );
}

const COLUMNS = (known: Set<string> | null): GridColumn<AdminNotice>[] => [
  {
    id: 'status',
    label: t('notices.col.status'),
    value: (x) => t(`notices.status.${x.status}`),
    width: '150px',
    render: (x) => (
      <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center' }}>
        <Pill flush tone={STATUS_TONE[x.status]}>
          {t(`notices.status.${x.status}`)}
        </Pill>
        {orphan(x, known) && <Pill tone="warn">{t('notices.noDepartment')}</Pill>}
      </Box>
    ),
  },
  { id: 'kind', label: t('notices.col.kind'), value: (x) => t(`notice.kind.${x.kind}`), width: '120px', render: (x) => <KindCell kind={x.kind} /> },
  { id: 'title', label: t('notices.col.title'), value: (x) => x.title, width: 'minmax(200px, 3fr)', hideable: false },
  { id: 'audience', label: t('notices.col.audience'), value: audienceText, width: 'minmax(120px, 1fr)' },
  { id: 'period', label: t('notices.col.period'), value: (x) => x.starts_at, render: (x) => noticeRange(x), width: '250px' },
  { id: 'author', label: t('notices.col.author'), value: (x) => x.author_name || x.author, width: 'minmax(120px, 1fr)' },
];

interface Draft {
  id?: number;
  kind: NoticeKind;
  title: string;
  body: string;
  link: string;
  starts: Dayjs | null;
  ends: Dayjs | null;
  audience: 'all' | string[];
  dismissible: boolean;
  reshow: boolean;
}

/** 새 공지·복제·끝남 안내의 처음 값. 기간은 지금부터 1일(끝남 안내는 1시간) */
function seedDraft(from?: Partial<AdminNotice>, opts: { keepId?: boolean; ended?: boolean } = {}): Draft {
  const now = dayjs();
  const kind: NoticeKind = opts.ended ? 'info' : (from?.kind ?? 'info');
  const prefix = t('notices.endedPrefix');
  return {
    id: opts.keepId ? from?.id : undefined,
    kind,
    title: opts.ended ? (prefix + (from?.title ?? '')).slice(0, TITLE_MAX) : (from?.title ?? ''),
    body: opts.ended ? '' : (from?.body ?? ''),
    link: opts.ended ? '' : (from?.link ?? ''),
    starts: opts.keepId && from?.starts_at ? dayjs(from.starts_at) : now,
    ends: opts.keepId && from?.ends_at ? dayjs(from.ends_at) : opts.ended ? now.add(1, 'hour') : now.add(1, 'day'),
    audience: from?.audience ? (Array.isArray(from.audience) ? [...from.audience] : 'all') : 'all',
    dismissible: kind === 'outage' ? false : opts.keepId ? (from?.dismissible ?? true) : true,
    reshow: false,
  };
}

/** 저장 전 화면이 먼저 보는 것(2E): 글자 수·주소 형식·기간 순서·대상 */
export function checkDraft(d: Draft): Partial<Record<Field, string>> {
  const out: Partial<Record<Field, string>> = {};
  if (!d.title.trim()) out.title = t('notices.err.titleRequired');
  else if (d.title.length > TITLE_MAX) out.title = t('notices.err.tooLong', { n: TITLE_MAX });
  if (d.body.length > BODY_MAX) out.body = t('notices.err.tooLong', { n: BODY_MAX });
  if (d.link.trim() && !noticeLink(d.link)) out.link = t('notices.err.link');
  if (!d.starts || !d.starts.isValid()) out.starts_at = t('notices.err.time');
  if (!d.ends || !d.ends.isValid()) out.ends_at = t('notices.err.time');
  else if (d.starts?.isValid() && !d.ends.isAfter(d.starts)) out.ends_at = t('notices.err.order');
  if (Array.isArray(d.audience) && !d.audience.length) out.audience = t('notices.err.audience');
  return out;
}

const asNotice = (d: Draft): Notice => ({
  id: d.id ?? -1,
  kind: d.kind,
  title: d.title || t('notices.previewTitle'),
  body: d.body,
  link: d.link,
  starts_at: d.starts?.isValid() ? d.starts.toISOString() : new Date().toISOString(),
  ends_at: d.ends?.isValid() ? d.ends.toISOString() : new Date().toISOString(),
  dismissible: d.kind !== 'outage' && d.dismissible,
  updated_ts: '',
  reshow_ts: '',
});

const WIDE = 1280;
const NARROW = 375;

/** 미리 보기 두 줄(5F): 넓은 화면(1280px 배치를 서랍 폭에 줄여 그림)과 좁은 화면(375px 규칙). 띠와 같은 부품이다 */
function NoticePreview({ draft }: { draft: Draft }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);
  const n = asNotice(draft);
  const scale = width ? Math.min(1, width / WIDE) : 0.4;
  return (
    <Stack spacing={1} ref={box} data-testid="notice-preview">
      <Typography variant="caption" color="text.secondary">
        {t('notices.previewWide')}
      </Typography>
      <Box sx={{ height: 37 * scale, overflow: 'hidden' }} aria-hidden>
        <Box sx={{ width: WIDE, transform: `scale(${scale})`, transformOrigin: 'left top' }}>
          <NoticeBarView items={[n]} preview />
        </Box>
      </Box>
      <Typography variant="caption" color="text.secondary">
        {t('notices.previewNarrow')}
      </Typography>
      <Box sx={{ width: NARROW, maxWidth: '100%' }} aria-hidden>
        <NoticeBarView items={[n]} preview narrow />
      </Box>
    </Stack>
  );
}

/** 칸 아래 줄: 왼쪽 오류(또는 도움말), 오른쪽 글자 수 「N/80」(5E) */
function Helper({ error, help, count, max }: { error?: string; help?: ReactNode; count?: number; max?: number }) {
  if (!error && !help && max === undefined) return null;
  return (
    <Box component="span" sx={{ display: 'flex', gap: 1 }}>
      <Box component="span" sx={{ flex: 1 }}>
        {error || help}
      </Box>
      {max !== undefined && (
        <Box component="span" data-counter="" sx={{ color: (count ?? 0) > max ? 'error.main' : undefined, fontVariantNumeric: 'tabular-nums' }}>
          {`${count ?? 0}/${max}`}
        </Box>
      )}
    </Box>
  );
}

/** 대상 사람 수(R9). 로그인을 끈 실행은 null 이라 수를 숨긴다 */
function Reach({ audience }: { audience: Draft['audience'] }) {
  const ok = audience === 'all' || audience.length > 0;
  const q = useQuery<{ reach: number | null }>({
    queryKey: ['notice-reach', audience],
    queryFn: () => post<{ reach: number | null }>('/api/notices', { action: 'reach', audience }),
    enabled: ok,
    staleTime: 30_000,
  });
  const n = q.data?.reach;
  if (!ok || n === null || n === undefined) return null;
  return (
    <Typography variant="caption" color="text.secondary" data-testid="notice-reach">
      {t('notices.reach', { n })}
    </Typography>
  );
}

export interface NoticeEditorProps {
  /** 고칠 공지. 없으면 새 공지 */
  x?: AdminNotice;
  /** 새 공지의 처음 값(복제·끝남 안내) */
  seed?: Draft;
}

/** 만들기·고치기 서랍 */
export function NoticeEditor({ x, seed }: NoticeEditorProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const { openDrawer, closeDrawer } = useUi();
  const confirm = useConfirm();
  const depts = useDepartments();
  const base = useId();
  const [d, setD] = useState<Draft>(() => seed ?? seedDraft(x, { keepId: !!x }));
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const readOnly = !!x?.deleted;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setD((p) => ({ ...p, [k]: v }));
    setErrors((e) => ({ ...e, [k === 'starts' ? 'starts_at' : k === 'ends' ? 'ends_at' : k]: undefined }));
  };
  const fieldId = (f: Field) => `${base}-${f}`;
  const focusField = (f: Field) => setTimeout(() => document.getElementById(fieldId(f))?.focus(), 0);
  const refresh = () => qc.invalidateQueries({ queryKey: NOTICES_KEY });
  const names = (depts.data?.departments ?? []).map((r) => r.name);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const save = async () => {
    const found = checkDraft(d);
    setErrors(found);
    setError('');
    const first = FIELDS.find((f) => found[f]);
    if (first) {
      focusField(first);
      return;
    }
    setBusy(true);
    try {
      const r = await post<{ ok: boolean; notice: AdminNotice; reach: number | null }>('/api/notices', {
        action: 'save',
        ...(d.id ? { id: d.id } : {}),
        kind: d.kind,
        title: d.title.trim(),
        body: d.body.trim(),
        link: d.link.trim(),
        starts_at: d.starts!.toISOString(),
        ends_at: d.ends!.toISOString(),
        audience: d.audience,
        dismissible: d.kind !== 'outage' && d.dismissible,
        ...(d.id ? { reshow: d.reshow } : {}),
      });
      // 저장 결과(2C): 보이는 중이면 대상 사람 수, 예약이면 시작 시각
      const n = r.notice;
      const msg =
        n.status === 'scheduled'
          ? t('notices.savedScheduled', { at: noticeWhen(new Date(n.starts_at)) })
          : r.reach === null || r.reach === undefined
            ? t('notices.savedActiveNoCount')
            : t('notices.savedActive', { n: r.reach });
      enqueueSnackbar(msg, { variant: 'success' });
      await refresh();
      closeDrawer();
    } catch (e) {
      const f = e instanceof ApiError ? (e.field as Field) : '';
      if (f && (FIELDS as readonly string[]).includes(f)) {
        setErrors({ [f]: (e as Error).message });
        focusField(f);
      } else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!x) return;
    let makeEnd = false;
    const ok = await confirm(t('notices.removeBody'), {
      title: t('notices.removeAsk', { title: x.title }),
      confirmLabel: t('notices.removeOk'),
      danger: true,
      check: { label: t('notices.makeEnded'), onChange: (v) => (makeEnd = v) },
    });
    if (!ok) return;
    try {
      await post('/api/notices', { action: 'remove', id: x.id });
      enqueueSnackbar(t('notices.removed', { title: x.title }), { variant: 'success' });
      await refresh();
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
      return;
    }
    // 끝남 안내는 내리기가 성공한 뒤에만 연다(E8). 대상은 원래 공지를 그대로 옮긴다
    if (makeEnd) openDrawer({ title: t('notices.newTitle'), body: <NoticeEditor seed={seedDraft(x, { ended: true })} /> });
    else closeDrawer();
  };

  const quick = (kind: 'hour' | 'today' | 'week') => {
    const now = dayjs();
    if (kind === 'hour') {
      set('starts', now);
      set('ends', now.add(1, 'hour'));
      return;
    }
    const from = d.starts?.isValid() ? d.starts : now;
    set('ends', kind === 'today' ? from.add(1, 'day').startOf('day') : from.add(7, 'day'));
  };

  return (
    <LocalizationProvider
      dateAdapter={AdapterDayjs}
      adapterLocale={getLang() === 'en' ? 'en' : 'ko'}
      {...(getLang() === 'en' ? {} : { localeText: koKR.components.MuiLocalizationProvider.defaultProps.localeText })}
    >
      <Stack spacing={2} component="form" noValidate onSubmit={(e) => (e.preventDefault(), void save())}>
        <NoticePreview draft={d} />
        {readOnly && <Alert severity="info">{t('notices.deletedNote')}</Alert>}
        {error && <Alert severity="error">{error}</Alert>}
        <Box>
          <Typography id={`${base}-kind-label`} variant="subtitle2" sx={{ mb: 0.5 }}>
            {t('notices.col.kind')}
          </Typography>
          <RadioGroup
            aria-labelledby={`${base}-kind-label`}
            value={d.kind}
            onChange={(e) => {
              const k = e.target.value as NoticeKind;
              setD((p) => ({ ...p, kind: k, dismissible: k !== 'outage' }));
            }}
          >
            {NOTICE_KINDS.map((k) => {
              const Icon = NOTICE_ICONS[k];
              return (
                <FormControlLabel
                  key={k}
                  value={k}
                  disabled={readOnly}
                  control={<Radio size="small" {...(k === 'outage' ? { id: fieldId('kind') } : {})} />}
                  label={
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Icon aria-hidden sx={{ fontSize: 16, color: k === 'outage' ? 'error.main' : 'text.secondary' }} />
                      <Box component="span" sx={{ fontWeight: 500 }}>
                        {t(`notice.kind.${k}`)}
                      </Box>
                      <Typography component="span" variant="caption" color="text.secondary">
                        {t(`notices.kindUse.${k}`)}
                      </Typography>
                    </Box>
                  }
                />
              );
            })}
          </RadioGroup>
          {errors.kind && <FormHelperText error>{errors.kind}</FormHelperText>}
        </Box>
        <TextField
          size="small"
          id={fieldId('title')}
          label={t('notices.col.title')}
          value={d.title}
          disabled={readOnly}
          onChange={(e) => set('title', e.target.value.replace(/\n/g, ' '))}
          error={!!errors.title || d.title.length > TITLE_MAX}
          helperText={<Helper error={errors.title} count={d.title.length} max={TITLE_MAX} />}
        />
        <TextField
          size="small"
          id={fieldId('body')}
          label={t('notices.body')}
          value={d.body}
          disabled={readOnly}
          multiline
          minRows={2}
          onChange={(e) => set('body', e.target.value.replace(/\n/g, ' '))}
          error={!!errors.body || d.body.length > BODY_MAX}
          helperText={<Helper error={errors.body} count={d.body.length} max={BODY_MAX} />}
        />
        <TextField
          size="small"
          id={fieldId('link')}
          label={t('notice.go')}
          placeholder="#/skills · https://"
          value={d.link}
          disabled={readOnly}
          onChange={(e) => set('link', e.target.value)}
          error={!!errors.link}
          helperText={<Helper error={errors.link} help={t('notices.linkHelp')} />}
        />
        <Stack spacing={1}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <DateTimePicker
              label={t('notices.start')}
              value={d.starts}
              onChange={(v) => set('starts', v)}
              ampm={false}
              disabled={readOnly}
              format="YYYY-MM-DD HH:mm"
              slotProps={{ textField: { size: 'small', fullWidth: true, id: fieldId('starts_at'), error: !!errors.starts_at, helperText: errors.starts_at } }}
            />
            <DateTimePicker
              label={t('notices.end')}
              value={d.ends}
              onChange={(v) => set('ends', v)}
              ampm={false}
              disabled={readOnly}
              format="YYYY-MM-DD HH:mm"
              slotProps={{ textField: { size: 'small', fullWidth: true, id: fieldId('ends_at'), error: !!errors.ends_at, helperText: errors.ends_at } }}
            />
          </Stack>
          <Typography variant="caption" color="text.secondary">
            {t('notices.tz', { tz })}
          </Typography>
          {!readOnly && (
            <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
              <Button size="small" variant="outlined" onClick={() => quick('hour')}>
                {t('notices.quickHour')}
              </Button>
              <Button size="small" variant="outlined" onClick={() => quick('today')}>
                {t('notices.quickToday')}
              </Button>
              <Button size="small" variant="outlined" onClick={() => quick('week')}>
                {t('notices.quickWeek')}
              </Button>
            </Stack>
          )}
        </Stack>
        <Box>
          <Typography id={`${base}-aud-label`} variant="subtitle2" sx={{ mb: 0.5 }}>
            {t('notices.col.audience')}
          </Typography>
          <RadioGroup
            row
            aria-labelledby={`${base}-aud-label`}
            value={d.audience === 'all' ? 'all' : 'dept'}
            onChange={(e) => set('audience', e.target.value === 'all' ? 'all' : [])}
          >
            <FormControlLabel value="all" disabled={readOnly} control={<Radio size="small" id={fieldId('audience')} />} label={t('notices.audienceAll')} />
            <FormControlLabel value="dept" disabled={readOnly} control={<Radio size="small" />} label={t('notices.audienceDept')} />
          </RadioGroup>
          {Array.isArray(d.audience) && (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 1, pl: 1 }}>
              {names.length === 0 && (
                <Typography variant="caption" color="text.secondary">
                  {depts.isLoading ? t('notices.deptLoading') : t('notices.deptNone')}
                </Typography>
              )}
              {names.map((name) => {
                const list = d.audience as string[];
                const on = list.some((a) => teamKey(a) === teamKey(name));
                return (
                  <FormControlLabel
                    key={name}
                    disabled={readOnly}
                    control={
                      <Checkbox
                        size="small"
                        checked={on}
                        onChange={(e) => set('audience', e.target.checked ? [...list, name] : list.filter((a) => teamKey(a) !== teamKey(name)))}
                      />
                    }
                    label={name}
                  />
                );
              })}
            </Box>
          )}
          {errors.audience && <FormHelperText error>{errors.audience}</FormHelperText>}
          <Reach audience={d.audience} />
        </Box>
        <Box>
          <FormControlLabel
            control={<Switch checked={d.kind !== 'outage' && d.dismissible} disabled={readOnly || d.kind === 'outage'} onChange={(e) => set('dismissible', e.target.checked)} />}
            label={t('notices.dismissible')}
          />
          {d.kind === 'outage' && <FormHelperText>{t('notices.outageNoClose')}</FormHelperText>}
        </Box>
        {x && !readOnly && (
          <Box>
            <FormControlLabel control={<Checkbox checked={d.reshow} onChange={(e) => set('reshow', e.target.checked)} />} label={t('notices.reshow')} />
            <FormHelperText>{t('notices.reshowHelp')}</FormHelperText>
          </Box>
        )}
        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
          {!readOnly && (
            <Button type="submit" variant="contained" disabled={busy}>
              {busy ? t('notices.saving') : t('notices.save')}
            </Button>
          )}
          {x && (x.status === 'active' || x.status === 'scheduled') && (
            <Button variant="outlined" onClick={() => void remove()}>
              {t('notices.remove')}
            </Button>
          )}
          {x && (
            <Button onClick={() => openDrawer({ title: t('notices.newTitle'), body: <NoticeEditor seed={seedDraft(x)} /> })}>{t('notices.duplicate')}</Button>
          )}
        </Stack>
      </Stack>
    </LocalizationProvider>
  );
}

export function Notices() {
  const q = useNoticeList();
  const depts = useDepartments();
  const qc = useQueryClient();
  const { openDrawer } = useUi();
  const { enqueueSnackbar } = useSnackbar();
  const all = q.data?.notices ?? [];
  const known = depts.data ? new Set(depts.data.departments.map((r) => teamKey(r.name))) : null;
  const by = (s: NoticeStatus) => all.filter((x) => x.status === s);
  const openNew = () => openDrawer({ title: t('notices.newTitle'), body: <NoticeEditor /> });
  const openEdit = (x: AdminNotice) => openDrawer({ title: x.title, sub: t(`notices.status.${x.status}`), body: <NoticeEditor key={`${x.id}:${x.updated_ts}`} x={x} /> });

  // 「1시간 연장」(3A). 본 끝 시각을 함께 보내 그사이 바뀌었으면 409 — 알리고 목록을 다시 읽는다
  const extend = async (x: AdminNotice) => {
    try {
      const r = await post<{ ok: boolean; notice: AdminNotice }>('/api/notices', { action: 'extend', id: x.id, ends_at: x.ends_at });
      enqueueSnackbar(t('notices.extended', { at: noticeWhen(new Date(r.notice.ends_at)) }), { variant: 'success' });
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: e instanceof ApiError && e.status === 409 ? 'warning' : 'error' });
    } finally {
      await qc.invalidateQueries({ queryKey: NOTICES_KEY });
    }
  };

  const actions: GridAction<AdminNotice>[] = [
    { id: 'extend', label: t('notices.extend'), visible: (x) => x.status === 'active', onClick: (x) => void extend(x) },
    { id: 'duplicate', label: t('notices.duplicate'), onClick: (x) => openDrawer({ title: t('notices.newTitle'), body: <NoticeEditor seed={seedDraft(x)} /> }) },
  ];
  const emptyAll = q.data && !all.length ? t('notices.empty') : undefined;

  return (
    <ListView<AdminNotice>
      guide="notices.list"
      title={t('views.notices.label')}
      sub={t('views.notices.sub')}
      error={q.error?.message}
      banner={q.data?.limited ? { severity: 'info', message: t('notices.limited', { n: (q.data.limit ?? 1000).toLocaleString() }) } : null}
      tabs={[
        { id: 'active', label: t('notices.status.active'), items: by('active'), empty: emptyAll ?? t('notices.emptyActive'), card: {} },
        { id: 'scheduled', label: t('notices.status.scheduled'), items: by('scheduled'), empty: emptyAll ?? t('notices.emptyScheduled'), card: {} },
        { id: 'ended', label: t('notices.status.ended'), items: by('ended'), empty: emptyAll ?? t('notices.emptyEnded'), card: {} },
        { id: 'deleted', label: t('notices.status.deleted'), items: by('deleted'), empty: emptyAll ?? t('notices.emptyDeleted'), card: {} },
      ]}
      text={(x) => [x.title, x.body, audienceText(x), x.author_name, x.author, x.editor].join(' ')}
      gridAction={{ label: t('notices.new'), onClick: openNew, guide: 'notices.add' }}
      onRow={openEdit}
      actions={actions}
      id="notices"
      columns={COLUMNS(known)}
      rowId={(x) => String(x.id)}
      rowName={(x) => x.title}
      note={t('notices.note')}
    />
  );
}
