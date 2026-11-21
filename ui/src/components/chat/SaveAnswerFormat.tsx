/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 위젯 답 저장의 단추와 미리 보기 판(cogentai-aas-docs security/chat-embed-save-answer 2026-11-18-012 §6·§6-1).
// 형식이 있으면 단추가 판을 열고(서버가 채움 → 사람이 확인·고침 → 「저장」 → 페이지 onSave), 형식이 없으면 원문 답으로 onSave 를 바로 부른다.
// 값의 원본은 JSON 하나이고 양식은 그 값을 보이는 화면이다(D25④). 믿을 수 없는 글(스키마 title·description·enum, 채운 값, 페이지 문구)은
// 글자로만 그린다(D25③) — MUI 의 글자 칸·Typography 로만 그리고 마크다운·HTML 로 넣지 않는다.
import CheckIcon from '@mui/icons-material/Check';
import RefreshIcon from '@mui/icons-material/Refresh';
import SaveOutlinedIcon from '@mui/icons-material/SaveOutlined';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  FormControlLabel,
  IconButton,
  MenuItem,
  Skeleton,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import { getLang, t } from '@/i18n';
import { useEmbed } from '@/lib/embedContext';

import {
  callOnSave,
  fill,
  FillFailure,
  type FillResponse,
  newAttemptId,
  type SaveAnswerConfig,
  type SaveAnswerResult,
  type SaveOutcome,
  sendOutcome,
} from '../../embed/saveAnswer';
import type { SavePanelRequest, WidgetStore } from '../../embed/state';
import { useWidgetState } from '../../embed/state';
import { checkValue, type SchemaError } from './schemaForm/validate';

export const FORM_DEPTH_MAX = 4;
export const NARROW_PX = 400;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const labelOf = (l: { ko: string; en: string } | undefined) => (l ? (getLang() === 'en' ? l.en : l.ko) : '');

/** 칸 이름: title → description 첫 줄 → 키(§6-1) */
export function fieldName(schema: Obj, key: string): string {
  if (typeof schema.title === 'string' && schema.title.trim()) return schema.title;
  if (typeof schema.description === 'string' && schema.description.trim()) return schema.description.split('\n')[0];
  return key;
}

function fieldHelp(schema: Obj): string {
  if (typeof schema.description !== 'string') return '';
  const lines = schema.description.split('\n');
  return typeof schema.title === 'string' && schema.title.trim() ? schema.description : lines.slice(1).join('\n');
}

function mainType(schema: Obj): string {
  const types = (Array.isArray(schema.type) ? schema.type : [schema.type]).filter((x) => typeof x === 'string') as string[];
  return types.find((x) => x !== 'null') ?? (Array.isArray(schema.enum) ? 'enum' : 'string');
}

/** 판이 열려 있는 동안의 값 비교 — 고친 칸 수(D20) */
function leaves(v: unknown, path = '', out: Map<string, string> = new Map()): Map<string, string> {
  if (isObj(v)) for (const [k, x] of Object.entries(v)) leaves(x, `${path}/${k}`, out);
  else if (Array.isArray(v)) v.forEach((x, i) => leaves(x, `${path}/${i}`, out));
  else out.set(path, JSON.stringify(v));
  return out;
}

export function editedCount(before: unknown, after: unknown): number {
  const a = leaves(before);
  const b = leaves(after);
  let n = 0;
  for (const k of new Set([...a.keys(), ...b.keys()])) if (a.get(k) !== b.get(k)) n++;
  return n;
}

/** 오류 문구(사람이 읽는 말). 서버·화면 검사기의 영어 문구는 쓰지 않는다 */
function errorText(e: SchemaError, schema: Obj | undefined): string {
  const n = schema?.[e.keyword];
  return t(`embedFormat.err.${e.keyword}`, { n: typeof n === 'number' ? n : '' });
}

function schemaAt(root: Obj, path: string): Obj | undefined {
  let s: unknown = root;
  for (const seg of path.split('/').slice(1).map((x) => x.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (!isObj(s)) return undefined;
    if (isObj(s.properties) && seg in s.properties) s = s.properties[seg];
    else if (isObj(s.items) && /^\d+$/.test(seg)) s = s.items;
    else return undefined;
  }
  return isObj(s) ? s : undefined;
}

// ---- 날짜·시간 칸: 사람이 고르는 지역 시간 ↔ 오프셋 붙은 RFC 3339 ------------------------------------------------
const pad = (n: number) => String(n).padStart(2, '0');

export function toLocalInput(iso: unknown): string {
  if (typeof iso !== 'string' || !iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(v: string): string {
  const d = new Date(v);
  if (!v || Number.isNaN(d.getTime())) return '';
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${v.length === 16 ? `${v}:00` : v}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

// ---- 양식 ---------------------------------------------------------------------------------------------------
interface FieldProps {
  schema: Obj;
  name: string;
  value: unknown;
  path: string;
  depth: number;
  required: boolean;
  errors: Map<string, SchemaError>;
  root: Obj;
  onChange: (v: unknown | undefined) => void;
  disabled: boolean;
}

function Field({ schema, name, value, path, depth, required, errors, root, onChange, disabled }: FieldProps): ReactNode {
  const err = errors.get(path);
  const helper = err ? errorText(err, schemaAt(root, path)) : fieldHelp(schema);
  const label = required ? `${name} *` : name;
  // id 는 TextField 에 준다 — htmlInput 으로 넘기면 MUI 가 label 의 htmlFor 와 잇지 못해 칸에 이름이 없어진다(시험 게시판 실화면 2026-11-18)
  const fid = `f${path.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const common = { 'data-path': path };
  if (depth > FORM_DEPTH_MAX) {
    return (
      <Alert severity="info" sx={{ py: 0 }}>
        {name}: {t('embedFormat.tooDeep')}
      </Alert>
    );
  }
  if (Array.isArray(schema.enum)) {
    const opts = schema.enum;
    const idx = opts.findIndex((o) => JSON.stringify(o) === JSON.stringify(value));
    return (
      <TextField
        id={fid}
        select
        size="small"
        fullWidth
        label={label}
        value={idx < 0 ? '' : String(idx)}
        error={!!err}
        helperText={helper || undefined}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === '' ? undefined : opts[Number(e.target.value)])}
        slotProps={{ htmlInput: common }}
      >
        {!required && <MenuItem value="">{t('embedFormat.empty')}</MenuItem>}
        {opts.map((o, i) => (
          <MenuItem key={i} value={String(i)}>
            {o === null ? t('embedFormat.empty') : String(o)}
          </MenuItem>
        ))}
      </TextField>
    );
  }
  const type = mainType(schema);
  if (type === 'object') {
    const props = isObj(schema.properties) ? schema.properties : {};
    const req = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
    const v = isObj(value) ? value : {};
    return (
      <Box component="fieldset" sx={{ border: 1, borderColor: err ? 'error.main' : 'divider', borderRadius: 1, px: 1.5, pb: 1.5, pt: 0.5, m: 0 }} {...common}>
        <Typography component="legend" variant="caption" sx={{ px: 0.5 }}>
          {label}
        </Typography>
        <Stack spacing={1.5}>
          {Object.entries(props).map(([k, sub]) => (
            <Field
              key={k}
              schema={(isObj(sub) ? sub : {}) as Obj}
              name={fieldName((isObj(sub) ? sub : {}) as Obj, k)}
              value={v[k]}
              path={`${path}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`}
              depth={depth + 1}
              required={req.has(k)}
              errors={errors}
              root={root}
              disabled={disabled}
              onChange={(x) => {
                const next = { ...v };
                if (x === undefined) delete next[k];
                else next[k] = x;
                onChange(Object.keys(next).length || required ? next : undefined);
              }}
            />
          ))}
        </Stack>
        {err && (
          <Typography variant="caption" color="error">
            {helper}
          </Typography>
        )}
      </Box>
    );
  }
  if (type === 'array') {
    const items = (isObj(schema.items) ? schema.items : {}) as Obj;
    const list = Array.isArray(value) ? value : [];
    return (
      <Box {...common}>
        <Typography variant="caption" color={err ? 'error' : 'text.secondary'}>
          {label}
        </Typography>
        <Stack spacing={1} sx={{ mt: 0.5 }}>
          {list.map((x, i) => (
            <Stack key={i} direction="row" spacing={0.5} alignItems="flex-start">
              <Box sx={{ flex: 1 }}>
                <Field
                  schema={items}
                  name={`${name} ${i + 1}`}
                  value={x}
                  path={`${path}/${i}`}
                  depth={depth + 1}
                  required
                  errors={errors}
                  root={root}
                  disabled={disabled}
                  onChange={(nx) => onChange(list.map((y, j) => (j === i ? (nx === undefined ? '' : nx) : y)))}
                />
              </Box>
              <Button size="small" color="inherit" disabled={disabled} onClick={() => onChange(list.filter((_, j) => j !== i))}>
                {t('embedFormat.removeItem')}
              </Button>
            </Stack>
          ))}
          <Box>
            <Button size="small" disabled={disabled} onClick={() => onChange([...list, mainType(items) === 'object' ? {} : mainType(items) === 'boolean' ? false : ''])}>
              {t('embedFormat.addItem')}
            </Button>
          </Box>
        </Stack>
        {helper && (
          <Typography variant="caption" color={err ? 'error' : 'text.secondary'} sx={{ display: 'block', whiteSpace: 'pre-line' }}>
            {helper}
          </Typography>
        )}
      </Box>
    );
  }
  if (type === 'boolean') {
    return (
      <FormControlLabel
        control={<Switch checked={value === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} slotProps={{ input: common }} />}
        label={label}
      />
    );
  }
  if (type === 'number' || type === 'integer') {
    return (
      <TextField
        id={fid}
        size="small"
        fullWidth
        type="number"
        label={label}
        value={typeof value === 'number' ? String(value) : ''}
        error={!!err}
        helperText={helper || undefined}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        slotProps={{ htmlInput: { ...common, step: type === 'integer' ? 1 : 'any' } }}
      />
    );
  }
  if (schema.format === 'date-time') {
    return (
      <TextField
        id={fid}
        size="small"
        fullWidth
        type="datetime-local"
        label={label}
        value={toLocalInput(value)}
        error={!!err}
        helperText={helper || undefined}
        disabled={disabled}
        onChange={(e) => onChange(fromLocalInput(e.target.value) || undefined)}
        slotProps={{ inputLabel: { shrink: true }, htmlInput: common }}
      />
    );
  }
  const max = typeof schema.maxLength === 'number' ? schema.maxLength : Infinity;
  return (
    <TextField
      id={fid}
      size="small"
      fullWidth
      multiline={max > 120}
      minRows={max > 120 ? 3 : undefined}
      maxRows={12}
      label={label}
      value={typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)}
      error={!!err}
      helperText={helper || undefined}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === '' && !required ? undefined : e.target.value)}
      slotProps={{ htmlInput: common, formHelperText: { sx: { whiteSpace: 'pre-line' } } }}
    />
  );
}

export function SchemaForm({ schema, value, errors, onChange, disabled = false }: { schema: Obj; value: unknown; errors: SchemaError[]; onChange: (v: unknown) => void; disabled?: boolean }) {
  const map = useMemo(() => new Map(errors.map((e) => [e.path, e])), [errors]);
  const props = isObj(schema.properties) ? schema.properties : {};
  const req = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const v = isObj(value) ? value : {};
  return (
    <Stack spacing={1.75}>
      {Object.entries(props).map(([k, sub]) => (
        <Field
          key={k}
          schema={(isObj(sub) ? sub : {}) as Obj}
          name={fieldName((isObj(sub) ? sub : {}) as Obj, k)}
          value={v[k]}
          path={`/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`}
          depth={1}
          required={req.has(k)}
          errors={map}
          root={schema}
          disabled={disabled}
          onChange={(x) => {
            const next = { ...v };
            if (x === undefined) delete next[k];
            else next[k] = x;
            onChange(next);
          }}
        />
      ))}
    </Stack>
  );
}

// ---- 판 -----------------------------------------------------------------------------------------------------
type Phase =
  | { k: 'filling'; slow: boolean }
  | { k: 'fill_error'; code: string; retryAt: number; guardrail: boolean }
  | { k: 'ready' }
  | { k: 'saving'; since: number }
  | { k: 'save_failed'; message: string; retryable: boolean; timedOut: boolean }
  | { k: 'config_changed' };

export function SaveAnswerPanel({ store }: { store: WidgetStore }) {
  const st = useWidgetState(store);
  const req = st.savePanel;
  if (!req) return null;
  return <Panel key={`${req.answerKey}-${req.gen}`} store={store} req={req} />;
}

function Panel({ store, req }: { store: WidgetStore; req: SavePanelRequest }) {
  const st = useWidgetState(store);
  const cfg = st.config.saveAnswer as SaveAnswerConfig;
  const runtime = st.saveAnswer;
  const { enqueueSnackbar } = useSnackbar();
  const [phase, setPhase] = useState<Phase>({ k: 'filling', slow: false });
  const [filled, setFilled] = useState<FillResponse | null>(null);
  const [value, setValue] = useState<unknown>(null);
  const [tab, setTab] = useState<'form' | 'json'>('form');
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState('');
  const [showOriginal, setShowOriginal] = useState(false);
  const [confirm, setConfirm] = useState<'' | 'refill' | 'close'>('');
  const [now, setNow] = useState(Date.now());
  const abort = useRef<AbortController | null>(null);
  const attempt = useRef<string>('');
  const reported = useRef(false);
  const lastOutcome = useRef<'saved' | 'cancelled' | 'save_failed'>('cancelled');

  const panelRef = useRef<HTMLDivElement | null>(null);
  // 위젯 폭 400px 미만이면 「새로 채우기」를 판 머리의 아이콘으로 옮기고 발에는 「취소」·「저장」만 둔다(§6-1)
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = panelRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth > 0 && el.clientWidth < NARROW_PX));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const schema: Obj = (filled?.schema as Obj | undefined) ?? {};
  const errors = useMemo(() => (value === null || !filled ? [] : checkValue(schema, value)), [value, filled]); // eslint-disable-line react-hooks/exhaustive-deps
  const edited = filled ? editedCount(filled.payload, value) : 0;
  const target = st.context?.title || (typeof location !== 'undefined' ? location.host : '');

  const run = async () => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setPhase({ k: 'filling', slow: false });
    const slowTimer = setTimeout(() => setPhase((p) => (p.k === 'filling' ? { k: 'filling', slow: true } : p)), 10_000);
    try {
      const ctx = st.context && st.contextOff !== st.context.pageId ? { source: st.context.source, title: st.context.title, url: st.context.url, pageId: st.context.pageId } : null;
      const out = await fill(cfg, { pod: req.pod, profile: req.profile, markdown: req.markdown, question: req.question, context: ctx }, ac.signal);
      if (ac.signal.aborted) return;
      setFilled(out);
      setValue(out.payload);
      setJsonText(JSON.stringify(out.payload, null, 2));
      attempt.current = '';
      setPhase({ k: 'ready' });
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return;
      const f = e instanceof FillFailure ? e : new FillFailure(0, { code: 'network' });
      const code = f.body.code ?? 'network';
      const wait = Number(f.body.retry_after ?? 0);
      if (f.body.requestId) console.warn(`[AAS saveAnswer] ${code} req=${f.body.requestId}`); // D22①
      setPhase({ k: 'fill_error', code, retryAt: wait ? Date.now() + wait * 1000 : 0, guardrail: code === 'format.fill_guardrail' });
    } finally {
      clearTimeout(slowTimer);
    }
  };

  useEffect(() => {
    void run();
    return () => abort.current?.abort();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 남은 초·저장 중 초를 그린다
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // 설정이 바뀌면 판을 닫는다(D18)
  useEffect(() => {
    if (runtime.gen !== req.gen && phase.k !== 'config_changed') setPhase({ k: 'config_changed' });
  }, [runtime.gen, req.gen, phase.k]);

  const close = (outcome: 'saved' | 'cancelled' | 'save_failed' = lastOutcome.current) => {
    abort.current?.abort();
    if (!reported.current && filled) {
      reported.current = true;
      sendOutcome(req.pod, { format: filled.format, source: filled.source, outcome, edited });
    } else if (!reported.current && phase.k === 'filling') {
      reported.current = true;
      sendOutcome(req.pod, { format: cfg.format ?? null, source: cfg.format ? 'registered' : 'page', outcome: 'cancelled', edited: 0 });
    }
    if (store.get().savePanel?.answerKey === req.answerKey) store.set({ savePanel: null });
  };

  const save = async () => {
    if (!filled || value === null) return;
    if (!attempt.current) attempt.current = newAttemptId();
    const gen = req.gen;
    const result: SaveAnswerResult = {
      format: filled.format,
      version: filled.version,
      schemaHash: filled.schemaHash,
      source: filled.source,
      payload: value,
      markdown: req.markdown,
      session: req.session,
      answerKey: req.answerKey,
      agent: req.agent,
      filledAt: filled.filledAt,
      attemptId: attempt.current,
    };
    setPhase({ k: 'saving', since: Date.now() });
    const done = (o: SaveOutcome, late: boolean) => {
      if (store.get().saveAnswer.gen !== gen) return; // 설정이 바뀐 뒤의 결과는 무시한다(D18·D25⑥)
      if (o.ok) {
        lastOutcome.current = 'saved';
        store.set({ savedKeys: [...new Set([...store.get().savedKeys, req.answerKey])] });
        enqueueSnackbar(o.message || t('embedFormat.saved'), { variant: 'success', autoHideDuration: 5000 });
        if (!late) close('saved');
        return;
      }
      if (late) return; // 판을 닫은 뒤 늦게 거부되면 아무것도 보이지 않는다(§6-1)
      lastOutcome.current = 'save_failed';
      setPhase({ k: 'save_failed', message: o.message, retryable: o.retryable, timedOut: o.timedOut });
    };
    const o = await callOnSave(cfg, result, (late) => done(late, true));
    done(o, false);
  };

  const errorsN = errors.length;
  const shownErrors = errors;
  const busy = phase.k === 'saving';
  const label = labelOf(runtime.label);
  const preview = req.markdown.split('\n').filter((l) => l.trim()).slice(0, 2).join('\n');

  const switchTab = (next: 'form' | 'json') => {
    if (next === tab) return;
    if (next === 'form') {
      try {
        setValue(JSON.parse(jsonText));
        setJsonError('');
      } catch (e) {
        setJsonError((e as Error).message);
        return; // 읽을 수 없는 JSON 이면 양식 탭으로 옮기지 못한다(§6-1)
      }
    } else setJsonText(JSON.stringify(value, null, 2));
    setTab(next);
  };

  const footer = (() => {
    if (phase.k === 'filling')
      return (
        <Button color="inherit" onClick={() => close('cancelled')}>
          {t('embedFormat.cancel')}
        </Button>
      );
    if (phase.k === 'config_changed')
      return (
        <Button variant="contained" onClick={() => close('cancelled')}>
          {t('embedFormat.close')}
        </Button>
      );
    if (phase.k === 'fill_error') {
      const wait = Math.max(0, Math.ceil((phase.retryAt - now) / 1000));
      return (
        <>
          <Button color="inherit" onClick={() => close('cancelled')}>
            {t('embedFormat.close')}
          </Button>
          {!phase.guardrail && !['format.not_found', 'format.page_schema_off', 'format.forbidden', 'format.schema_invalid', 'format.too_large'].includes(phase.code) && (
            <Button variant="contained" disabled={wait > 0} onClick={() => void run()}>
              {t('embedFormat.refill')}
            </Button>
          )}
        </>
      );
    }
    if (phase.k === 'save_failed')
      return (
        <>
          <Button color="inherit" onClick={() => close('save_failed')}>
            {t('embedFormat.close')}
          </Button>
          {phase.retryable && (
            <Button variant="contained" onClick={() => void save()}>
              {t('embedFormat.saveAgain')}
            </Button>
          )}
        </>
      );
    return (
      <>
        <Button color="inherit" disabled={busy} onClick={() => (edited ? setConfirm('close') : close('cancelled'))}>
          {t('embedFormat.cancel')}
        </Button>
        <Box sx={{ flex: 1 }} />
        {!narrow && (
          <Button color="inherit" disabled={busy} onClick={() => (edited ? setConfirm('refill') : void run())}>
            {t('embedFormat.refill')}
          </Button>
        )}
        <Button variant="contained" disabled={busy || errorsN > 0 || !!jsonError} onClick={() => void save()}>
          {errorsN > 0 ? t('embedFormat.saveWithErrors', { n: errorsN }) : t('embedFormat.save')}
        </Button>
      </>
    );
  })();

  const codeText = (code: string, retryAt: number) => {
    const key = code === 'format.busy' ? 'format.rate_limited' : code === 'format.too_deep' || code === 'format.text_too_long' ? 'format.schema_invalid' : code === 'format.bad_request' ? 'format.too_large' : code;
    const known = ['format.not_found', 'format.page_schema_off', 'format.forbidden', 'format.schema_invalid', 'format.too_large', 'format.rate_limited', 'format.fill_llm', 'format.fill_timeout', 'format.fill_guardrail', 'network'];
    return t(`embedFormat.code.${known.includes(key) ? key : 'format.fill_llm'}`, { n: Math.max(1, Math.ceil((retryAt - now) / 1000)) });
  };

  return (
    <Box
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      data-testid="aas-save-answer-panel"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) {
          e.stopPropagation();
          if (edited && phase.k === 'ready') setConfirm('close');
          else close('cancelled');
        }
      }}
      sx={{ position: 'absolute', inset: '40px 0 0 0', zIndex: 4, bgcolor: 'background.default', display: 'flex', flexDirection: 'column' }}
    >
      <Box sx={{ px: 2, pt: 1.5, pb: 1, borderBottom: 1, borderColor: 'divider' }}>
        <Stack direction="row" alignItems="center" spacing={0.5}>
          <Typography variant="subtitle2" component="h3" noWrap sx={{ flex: 1, minWidth: 0 }}>
            {t('embedFormat.sendTo', { label, target })}
          </Typography>
          {narrow && (phase.k === 'ready' || phase.k === 'save_failed') && (
            <Tooltip title={t('embedFormat.refill')}>
              <IconButton size="small" aria-label={t('embedFormat.refill')} disabled={busy} onClick={() => (edited ? setConfirm('refill') : void run())}>
                <RefreshIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', whiteSpace: 'pre-line', ...(showOriginal ? { maxHeight: 160, overflow: 'auto' } : { overflow: 'hidden', maxHeight: '2.8em' }) }}>
          {showOriginal ? req.markdown : preview}
        </Typography>
        <Button size="small" color="inherit" onClick={() => setShowOriginal((x) => !x)} sx={{ px: 0, minWidth: 0 }}>
          {showOriginal ? t('embedFormat.hideOriginal') : t('embedFormat.showOriginal')}
        </Button>
      </Box>
      <Box aria-live="polite" sx={{ flex: 1, overflow: 'auto', px: 2, py: 1.5 }}>
        {phase.k === 'filling' && (
          <Stack spacing={1.5} aria-busy="true">
            <Typography variant="body2">{t('embedFormat.filling')}</Typography>
            {phase.slow && <Typography variant="caption">{t('embedFormat.slow')}</Typography>}
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} variant="rounded" height={40} />
            ))}
          </Stack>
        )}
        {phase.k === 'fill_error' && <Alert severity={phase.guardrail ? 'warning' : 'error'}>{codeText(phase.code, phase.retryAt)}</Alert>}
        {phase.k === 'config_changed' && <Alert severity="info">{t('embedFormat.configChanged')}</Alert>}
        {(phase.k === 'ready' || phase.k === 'saving' || phase.k === 'save_failed') && filled && (
          <Stack spacing={1.5}>
            {filled.truncated && <Alert severity="warning">{t('embedFormat.truncated')}</Alert>}
            {phase.k === 'save_failed' && (
              <Alert severity="error">
                {phase.timedOut ? t('embedFormat.noAnswer') : phase.message || t('embedFormat.saveFailed')}
                {phase.timedOut && (
                  <Typography variant="caption" sx={{ display: 'block' }}>
                    {t('embedFormat.maybeSaved')}
                  </Typography>
                )}
              </Alert>
            )}
            {shownErrors.length > 0 && (
              <Alert severity="warning">
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {t('embedFormat.errorsTitle', { n: shownErrors.length })}
                </Typography>
                {shownErrors.slice(0, 10).map((e, i) => (
                  <Button
                    key={i}
                    size="small"
                    color="inherit"
                    sx={{ display: 'block', textAlign: 'left', px: 0, textTransform: 'none' }}
                    onClick={() => {
                      const el = panelRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(e.path)}"]`);
                      el?.scrollIntoView({ block: 'center' });
                      el?.focus();
                    }}
                  >
                    {e.path || '/'}: {errorText(e, schemaAt(schema, e.path))}
                  </Button>
                ))}
              </Alert>
            )}
            <Tabs value={tab} onChange={(_, v) => switchTab(v)} variant="fullWidth" sx={{ minHeight: 36 }}>
              <Tab value="form" label={t('embedFormat.tabForm')} sx={{ minHeight: 36 }} />
              <Tab value="json" label={t('embedFormat.tabJson')} sx={{ minHeight: 36 }} />
            </Tabs>
            {tab === 'form' ? (
              <SchemaForm schema={schema} value={value} errors={errors} onChange={setValue} disabled={busy} />
            ) : (
              <TextField
                multiline
                minRows={10}
                fullWidth
                value={jsonText}
                disabled={busy}
                error={!!jsonError}
                helperText={jsonError ? t('embedFormat.jsonInvalid', { msg: jsonError }) : undefined}
                onChange={(e) => {
                  setJsonText(e.target.value);
                  try {
                    setValue(JSON.parse(e.target.value));
                    setJsonError('');
                  } catch (err) {
                    setJsonError((err as Error).message);
                  }
                }}
                slotProps={{ htmlInput: { spellCheck: false, style: { fontFamily: 'ui-monospace, monospace', fontSize: 12 } } }}
              />
            )}
          </Stack>
        )}
      </Box>
      {confirm && (
        <Alert
          severity="warning"
          sx={{ borderRadius: 0 }}
          action={
            <>
              <Button color="inherit" size="small" onClick={() => setConfirm('')}>
                {t('embedFormat.keep')}
              </Button>
              <Button
                color="inherit"
                size="small"
                onClick={() => {
                  const c = confirm;
                  setConfirm('');
                  if (c === 'refill') void run();
                  else close('cancelled');
                }}
              >
                {t('embedFormat.discard')}
              </Button>
            </>
          }
        >
          {t('embedFormat.discardConfirm', { n: edited })}
        </Alert>
      )}
      <Stack direction="row" spacing={1} alignItems="center" sx={{ px: 2, py: 1, borderTop: 1, borderColor: 'divider', justifyContent: 'flex-end' }}>
        {phase.k === 'saving' && (
          <Typography variant="caption" sx={{ mr: 'auto' }}>
            {t('embedFormat.saving', { n: Math.floor((now - phase.since) / 1000) })}
          </Typography>
        )}
        {footer}
      </Stack>
    </Box>
  );
}

// ---- 말풍선 단추 -----------------------------------------------------------------------------------------------
export interface SaveAnswerTarget {
  markdown: string;
  question: string;
  answerKey: string;
  session: string;
  agent: string;
  pod: string;
  profile: string;
}

export function SaveAnswerButton({ target }: { target: SaveAnswerTarget }) {
  const embed = useEmbed();
  const store = embed?.widgetStore as WidgetStore | undefined;
  if (!store) return null;
  return <SaveAnswerButtonInner store={store} target={target} />;
}

function SaveAnswerButtonInner({ store, target }: { store: WidgetStore; target: SaveAnswerTarget }) {
  const st = useWidgetState(store);
  const { enqueueSnackbar } = useSnackbar();
  const [busy, setBusy] = useState(false);
  const [askAgain, setAskAgain] = useState(false);
  const rt = st.saveAnswer;
  const cfg = st.config.saveAnswer as SaveAnswerConfig | null | undefined;
  if (!cfg || rt.state === 'disabled') return null;
  if (rt.state === 'pending') return <Box component="span" sx={{ display: 'inline-block', width: 28 }} aria-hidden />; // 조회 전에는 자리만(§6-1)
  const label = labelOf(rt.label);
  const saved = st.savedKeys.includes(target.answerKey);
  const open = () => {
    const cur = store.get();
    if (cur.savePanel) {
      store.set({ focusTick: cur.focusTick }); // 판은 한 번에 하나(D25⑤) — 열린 판을 그대로 둔다
      return;
    }
    if (rt.source !== 'none') {
      store.set({ savePanel: { ...target, gen: rt.gen } });
      return;
    }
    // 형식 없음: 서버를 부르지 않고 원문 답을 넘긴다(D2·§6-1)
    setBusy(true);
    const attemptId = newAttemptId();
    const result: SaveAnswerResult = {
      format: null, version: null, schemaHash: null, filledAt: null, source: 'none', payload: null,
      markdown: target.markdown, session: target.session, answerKey: target.answerKey, agent: target.agent, attemptId,
    };
    const gen = rt.gen;
    const done = (o: SaveOutcome) => {
      if (store.get().saveAnswer.gen !== gen) return;
      if (o.ok) {
        store.set({ savedKeys: [...new Set([...store.get().savedKeys, target.answerKey])] });
        enqueueSnackbar(o.message || t('embedFormat.saved'), { variant: 'success', autoHideDuration: 5000 });
      } else {
        enqueueSnackbar(o.timedOut ? t('embedFormat.noAnswer') : o.message || t('embedFormat.saveFailed'), { variant: 'error', persist: true });
      }
    };
    void callOnSave(cfg, result, done).then((o) => {
      setBusy(false);
      done(o);
    });
  };
  return (
    <>
      <Tooltip title={askAgain ? t('embedFormat.alreadySaved') : label}>
        <span>
          <IconButton
            size="small"
            aria-label={label}
            data-testid="aas-save-answer"
            disabled={busy}
            onClick={() => {
              if (saved && !askAgain) {
                setAskAgain(true);
                return;
              }
              setAskAgain(false);
              open();
            }}
            onBlur={() => setAskAgain(false)}
            sx={{ color: saved ? 'success.main' : 'text.secondary' }}
          >
            {busy ? <CircularProgress size={14} /> : saved ? <CheckIcon sx={{ fontSize: 16 }} /> : <SaveOutlinedIcon sx={{ fontSize: 16 }} />}
          </IconButton>
        </span>
      </Tooltip>
    </>
  );
}
