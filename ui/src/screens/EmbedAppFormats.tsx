/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 관리 › 임베드 앱 › 앱 서랍의 「답 저장 형식」 묶음(cogentai-aas-docs security/chat-embed-save-answer 2026-11-18-012 §6·§6-1·D15·D17·D20·D22).
// 서랍에는 ① 형식 목록(7일 통계)과 「형식 추가」 ② 「페이지가 형식을 넘길 수 있음」 스위치 ③ 페이지 개발자용 예시 코드만 둔다.
// 등록·수정은 전체 폭 대화 상자(스키마 편집기·「예시 JSON 으로 스키마 만들기」·「예시로 채워 보기」)로 연다.
// 서버: GET·POST …/formats, PUT·DELETE …/formats/<id>, POST …/formats-try, PUT …/formats-settings. 오류 본문은 {code, errors?, detail?}.
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Stack, Switch, Tab, Tabs, TextField, Typography } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useMemo, useState } from 'react';

import { monoFont } from '@/components/bits';
import { SchemaForm } from '@/components/chat/SaveAnswerFormat';
import { draftSchema } from '@/components/chat/schemaForm/draft';
import { checkSchema, checkValue, type SchemaError } from '@/components/chat/schemaForm/validate';
import { useConfirm } from '@/components/ConfirmDialog';
import { localeOf, t } from '@/i18n';
import { ApiError, apiFetch, del, post, put } from '@/lib/api';

export interface FormatStats {
  fills: number;
  failed: number;
  outcomes: number;
  saved: number;
  edited: number;
  saveRate: number | null;
  editedAvg: number | null;
}

export interface FormatView {
  id: string;
  label: { ko: string; en: string };
  schema: Record<string, unknown>;
  instructions: string;
  version: number;
  schemaHash: string;
  updated: number;
  updatedBy: string;
  warnings: SchemaError[];
  stats: FormatStats | null;
}

export interface FormatsResp {
  formats: FormatView[];
  page_schema: boolean;
  pageStats: FormatStats | null;
}

const base = (app: string) => `/api/admin/embed-apps/${encodeURIComponent(app)}`;
export const formatsKey = (app: string) => ['embed-formats', app];

/** 목록 읽기는 HTTP 로 한다. lib/api 의 get 은 웹소켓이 붙어 있으면 req 로 레거시 처리기를 부르는데, 이 경로는 Starlette 라우트라
 *  레거시가 404 를 낸다(로컬 실화면 2026-11-18). 쓰기(post·put·del)는 원래 HTTP 다 */
async function getFormats(url: string): Promise<FormatsResp> {
  const r = await apiFetch(url, { headers: { Accept: 'application/json' } });
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new ApiError(String(body.title ?? r.statusText), r.status, '', '', false, body);
  // 꼴이 다른 응답(옛 서버·프록시 오류 화면)이면 서랍 전체가 깨지지 않게 이 묶음만 오류로 보인다
  if (!Array.isArray(body.formats)) throw new ApiError(t('embedApps.format.unavailable'), r.status, '', '', false, body);
  return body as unknown as FormatsResp;
}

/** 서버 오류 → 사람이 읽는 문장(D22④). 모르는 코드는 서버 제목 */
export function formatError(e: unknown): string {
  if (e instanceof ApiError) {
    const code = String(e.data.code ?? '');
    const key = `embedApps.format.err.${code}`;
    const text = t(key);
    if (text !== key) return text;
    return String(e.data.title ?? e.message);
  }
  return (e as Error)?.message ?? String(e);
}

const dash = (v: number | null | undefined, f: (n: number) => string = String) => (v === null || v === undefined ? '—' : f(v));

/** 7일 통계 칸(D15·D20). 채우기가 0건이면 「—」 */
function StatsCells({ s }: { s: FormatStats | null }) {
  const has = !!s && (s.fills > 0 || s.outcomes > 0);
  return (
    <>
      <td>{has ? s!.fills : '—'}</td>
      <td>{has ? s!.failed : '—'}</td>
      <td>{has ? dash(s!.saveRate, (n) => `${Math.round(n * 100)}%`) : '—'}</td>
      <td>{has ? dash(s!.editedAvg) : '—'}</td>
    </>
  );
}

/** 페이지 개발자용 예시 코드(§6). 실제 형식 id·단추 이름을 채운다. 페이지 형식은 앱이 허용할 때만 보인다 */
export function snippets(aasUrl: string, f: FormatView | undefined, pageSchema: boolean): { id: string; label: string; code: string }[] {
  const q = (v: string) => JSON.stringify(v);
  const save = (guard = '') => `    onSave: async (r) => {
      // r: { format, version, schemaHash, source, payload, markdown, session, answerKey, agent, filledAt, attemptId }
${guard}      await fetch('/api/posts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': r.attemptId }, body: JSON.stringify(r.payload ?? { markdown: r.markdown }) });
      return { message: ${q(t('embedApps.format.snippetSaved'))} };
    },`;
  const head = `CogentAIAASWidget.init({\n  backendUrl: ${q(aasUrl)},\n  saveAnswer: {\n`;
  const label = `    label: { ko: ${q(t('embedApps.format.snippetLabelKo'))}, en: 'Save answer' },\n`;
  const out = [{ id: 'none', label: t('embedApps.format.snippetNone'), code: `${head}${label}${save()}\n  },\n});` }];
  if (f) {
    const note = t('embedApps.format.snippetNote', { label: f.label.ko, version: f.version, hash: f.schemaHash });
    const guard = `      if (r.schemaHash !== ${q(f.schemaHash)}) throw { message: ${q(t('embedApps.format.snippetChanged'))}, retryable: false };\n`;
    out.push({ id: 'registered', label: t('embedApps.format.snippetRegistered'), code: `${head}    format: ${q(f.id)},   // ${note}\n${save(guard)}\n  },\n});` });
  }
  if (pageSchema) {
    const schema = { type: 'object', properties: { title: { type: 'string', title: t('embedApps.format.snippetTitle'), maxLength: 80 } }, required: ['title'], additionalProperties: false };
    out.push({
      id: 'page',
      label: t('embedApps.format.snippetPage'),
      code: `${head}    schema: ${JSON.stringify(schema)},\n    instructions: ${q(t('embedApps.format.snippetInstructions'))},\n${label}${save()}\n  },\n});`,
    });
  }
  return out;
}

export function EmbedAppFormats({ appId, aasUrl }: { appId: string; aasUrl: string }) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const confirm = useConfirm();
  const q = useQuery<FormatsResp>({ queryKey: formatsKey(appId), queryFn: () => getFormats(`${base(appId)}/formats`) });
  const [editing, setEditing] = useState<FormatView | 'new' | null>(null);
  const [startFromExample, setStartFromExample] = useState(false);
  const [snippet, setSnippet] = useState('none');
  const refresh = () => qc.invalidateQueries({ queryKey: formatsKey(appId) });
  const data = q.data;

  const togglePage = async (on: boolean) => {
    try {
      await put(`${base(appId)}/formats-settings`, { page_schema: on });
      await refresh();
    } catch (e) {
      enqueueSnackbar(formatError(e), { variant: 'error' });
    }
  };

  const remove = async (f: FormatView) => {
    const ok = await confirm(t('embedApps.format.removeBody'), { title: t('embedApps.format.removeAsk', { name: f.label.ko }), confirmLabel: t('embedApps.format.remove'), danger: true });
    if (!ok) return;
    try {
      await del(`${base(appId)}/formats/${encodeURIComponent(f.id)}`);
      await refresh();
    } catch (e) {
      enqueueSnackbar(formatError(e), { variant: 'error' });
    }
  };

  const codes = snippets(aasUrl, data?.formats[0], !!data?.page_schema);
  const shown = codes.find((c) => c.id === snippet) ?? codes[0];
  const cell = { px: 1, py: 0.75, borderBottom: 1, borderColor: 'divider', textAlign: 'left', fontSize: 13 } as const;

  return (
    <Box component="section" aria-labelledby={`fmt-${appId}`} data-testid="embed-formats" sx={{ borderTop: 1, borderColor: 'divider', pt: 2 }}>
      <Typography id={`fmt-${appId}`} variant="subtitle1" component="h3" sx={{ fontWeight: 700 }}>
        {t('embedApps.format.title')}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {t('embedApps.format.lead')}
      </Typography>
      {q.error && <Alert severity="error">{formatError(q.error)}</Alert>}
      {data && data.formats.length === 0 && (
        <Alert
          severity="info"
          action={
            <Stack direction="row" spacing={1}>
              <Button size="small" onClick={() => (setStartFromExample(true), setEditing('new'))}>
                {t('embedApps.format.fromExample')}
              </Button>
              <Button size="small" onClick={() => (setStartFromExample(false), setEditing('new'))}>
                {t('embedApps.format.add')}
              </Button>
            </Stack>
          }
        >
          {t('embedApps.format.empty')}
        </Alert>
      )}
      {data && data.formats.length > 0 && (
        <Box sx={{ overflowX: 'auto' }}>
          <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse', '& th, & td': cell }}>
            <thead>
              <tr>
                <th>{t('embedApps.format.col.format')}</th>
                <th>{t('embedApps.format.col.label')}</th>
                <th>{t('embedApps.format.col.version')}</th>
                <th>{t('embedApps.format.col.fills')}</th>
                <th>{t('embedApps.format.col.failed')}</th>
                <th>{t('embedApps.format.col.saveRate')}</th>
                <th>{t('embedApps.format.col.edited')}</th>
                <th aria-label={t('embedApps.format.col.actions')} />
              </tr>
            </thead>
            <tbody>
              {data.formats.map((f) => (
                <tr key={f.id} data-testid={`embed-format-${f.id}`}>
                  <td>
                    <Box component="code" sx={{ fontFamily: monoFont }}>
                      {f.id}
                    </Box>
                    {f.warnings.length > 0 && (
                      <Typography variant="caption" color="warning.main" sx={{ display: 'block' }}>
                        {t('embedApps.format.warnings', { n: f.warnings.length })}
                      </Typography>
                    )}
                  </td>
                  <td>{localeOf().startsWith('en') ? f.label.en : f.label.ko}</td>
                  <td>{f.version}</td>
                  <StatsCells s={f.stats} />
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <Button size="small" onClick={() => (setStartFromExample(false), setEditing(f))}>
                      {t('embedApps.format.edit')}
                    </Button>
                    <Button size="small" color="error" onClick={() => void remove(f)}>
                      {t('embedApps.format.remove')}
                    </Button>
                  </td>
                </tr>
              ))}
              {data.page_schema && (
                <Box component="tr" sx={{ color: 'text.secondary' }}>
                  <td colSpan={3}>{t('embedApps.format.pageRow')}</td>
                  <StatsCells s={data.pageStats} />
                  <td />
                </Box>
              )}
            </tbody>
          </Box>
          <Button size="small" variant="outlined" sx={{ mt: 1 }} onClick={() => (setStartFromExample(false), setEditing('new'))}>
            {t('embedApps.format.add')}
          </Button>
        </Box>
      )}
      {data && (
        <Box sx={{ mt: 2 }}>
          <FormControlLabel
            control={<Switch checked={data.page_schema} onChange={(e) => void togglePage(e.target.checked)} />}
            label={t('embedApps.format.pageSchema')}
          />
          <Typography variant="caption" color="text.secondary" component="p">
            {t('embedApps.format.pageSchemaHelp')}
          </Typography>
        </Box>
      )}
      {data && (
        <Box sx={{ mt: 2 }}>
          <Typography variant="subtitle2">{t('embedApps.format.snippet')}</Typography>
          <Tabs value={shown.id} onChange={(_, v) => setSnippet(v)} sx={{ minHeight: 36 }}>
            {codes.map((c) => (
              <Tab key={c.id} value={c.id} label={c.label} sx={{ minHeight: 36 }} />
            ))}
          </Tabs>
          <Box component="pre" data-testid="embed-format-snippet" sx={{ m: 0, mt: 1, fontFamily: monoFont, fontSize: 12, p: 1.5, border: 1, borderColor: 'divider', borderRadius: 1, overflowX: 'auto', bgcolor: 'action.hover' }}>
            {shown.code}
          </Box>
          <Button size="small" variant="outlined" color="inherit" sx={{ mt: 0.5 }} onClick={() => void navigator.clipboard?.writeText(shown.code)}>
            {t('embedApps.copy')}
          </Button>
        </Box>
      )}
      {editing && (
        <FormatDialog
          appId={appId}
          current={editing === 'new' ? undefined : editing}
          fromExample={startFromExample}
          onClose={() => setEditing(null)}
          onSaved={async (f) => {
            setEditing(null);
            await refresh();
            enqueueSnackbar(t('embedApps.format.saved', { id: f.id, version: f.version }), { variant: 'success' });
          }}
        />
      )}
    </Box>
  );
}

interface TryResult {
  payload: unknown;
  errors: SchemaError[];
  truncated: boolean;
  elapsedMs: number;
}

function FormatDialog({ appId, current, fromExample, onClose, onSaved }: { appId: string; current?: FormatView; fromExample: boolean; onClose: () => void; onSaved: (f: FormatView) => void }) {
  const [id, setId] = useState(current?.id ?? '');
  const [ko, setKo] = useState(current?.label.ko ?? '');
  const [en, setEn] = useState(current?.label.en ?? '');
  const [schemaText, setSchemaText] = useState(current ? JSON.stringify(current.schema, null, 2) : '{\n  "type": "object",\n  "properties": {},\n  "additionalProperties": false\n}');
  const [instructions, setInstructions] = useState(current?.instructions ?? '');
  const [tab, setTab] = useState<'schema' | 'example' | 'try'>(fromExample ? 'example' : 'schema');
  const [example, setExample] = useState('');
  const [checks, setChecks] = useState<string[]>([]);
  const [tryText, setTryText] = useState('');
  const [tried, setTried] = useState<TryResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const parsed = useMemo(() => {
    try {
      return { schema: JSON.parse(schemaText) as Record<string, unknown> };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [schemaText]);
  const check = 'schema' in parsed ? checkSchema(parsed.schema) : null;
  const schemaErrors = check?.errors ?? [];
  const valid = 'schema' in parsed && !check?.code;

  const makeDraft = () => {
    const d = draftSchema(example);
    if ('error' in d) {
      setError(t('embedApps.format.exampleInvalid', { msg: d.error }));
      return;
    }
    setError('');
    setSchemaText(JSON.stringify(d.schema, null, 2));
    setChecks(d.checks);
    setTab('schema');
  };

  const tryFill = async () => {
    if (!valid) return;
    setBusy(true);
    setError('');
    try {
      setTried(await post<TryResult>(`${base(appId)}/formats-try`, { schema: (parsed as { schema: unknown }).schema, instructions, markdown: tryText }));
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!valid) return;
    setBusy(true);
    setError('');
    const body = { id, label: { ko, en }, schema: (parsed as { schema: unknown }).schema, instructions };
    try {
      const f = current ? await put<FormatView>(`${base(appId)}/formats/${encodeURIComponent(current.id)}`, body) : await post<FormatView>(`${base(appId)}/formats`, body);
      onSaved(f);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open fullWidth maxWidth="lg" onClose={() => !busy && onClose()} aria-labelledby="fmt-dialog-title">
      <DialogTitle id="fmt-dialog-title">{current ? t('embedApps.format.editTitle', { id: current.id }) : t('embedApps.format.newTitle')}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          {error && <Alert severity="error">{error}</Alert>}
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField
              size="small"
              id="fmt-id"
              label={t('embedApps.format.id')}
              value={id}
              disabled={!!current}
              onChange={(e) => setId(e.target.value.trim())}
              helperText={t('embedApps.format.idHelp')}
              sx={{ minWidth: 220 }}
            />
            <TextField size="small" id="fmt-ko" label={t('embedApps.format.labelKo')} value={ko} onChange={(e) => setKo(e.target.value)} slotProps={{ htmlInput: { maxLength: 40 } }} sx={{ flex: 1 }} />
            <TextField size="small" id="fmt-en" label={t('embedApps.format.labelEn')} value={en} onChange={(e) => setEn(e.target.value)} slotProps={{ htmlInput: { maxLength: 40 } }} sx={{ flex: 1 }} />
          </Stack>
          <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ minHeight: 36 }}>
            <Tab value="schema" label={t('embedApps.format.tabSchema')} sx={{ minHeight: 36 }} />
            <Tab value="example" label={t('embedApps.format.fromExample')} sx={{ minHeight: 36 }} />
            <Tab value="try" label={t('embedApps.format.try')} sx={{ minHeight: 36 }} />
          </Tabs>
          {tab === 'schema' && (
            <>
              <TextField
                id="fmt-schema"
                label="JSON Schema"
                multiline
                minRows={14}
                maxRows={28}
                value={schemaText}
                onChange={(e) => setSchemaText(e.target.value)}
                error={!valid}
                helperText={'error' in parsed ? t('embedApps.format.jsonInvalid', { msg: parsed.error }) : t('embedApps.format.schemaHelp')}
                slotProps={{ htmlInput: { spellCheck: false, style: { fontFamily: monoFont, fontSize: 12 } } }}
              />
              {schemaErrors.length > 0 && (
                <Alert severity="error">
                  {schemaErrors.slice(0, 12).map((e, i) => (
                    <Box key={i} component="div">
                      <Box component="code" sx={{ fontFamily: monoFont }}>
                        {e.path || '/'}
                      </Box>{' '}
                      ({e.keyword}): {e.message}
                    </Box>
                  ))}
                </Alert>
              )}
              {checks.length > 0 && <Alert severity="warning">{t('embedApps.format.checks', { paths: checks.join(', ') })}</Alert>}
              <TextField
                id="fmt-instructions"
                label={t('embedApps.format.instructions')}
                multiline
                minRows={3}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                helperText={t('embedApps.format.instructionsHelp', { n: Array.from(instructions).length })}
                slotProps={{ htmlInput: { maxLength: 4000 } }}
              />
            </>
          )}
          {tab === 'example' && (
            <>
              <TextField
                id="fmt-example"
                label={t('embedApps.format.exampleLabel')}
                multiline
                minRows={10}
                value={example}
                onChange={(e) => setExample(e.target.value)}
                helperText={t('embedApps.format.exampleHelp')}
                slotProps={{ htmlInput: { spellCheck: false, style: { fontFamily: monoFont, fontSize: 12 } } }}
              />
              <Box>
                <Button variant="outlined" onClick={makeDraft} disabled={!example.trim()}>
                  {t('embedApps.format.makeDraft')}
                </Button>
              </Box>
            </>
          )}
          {tab === 'try' && (
            <>
              <TextField id="fmt-try" label={t('embedApps.format.tryLabel')} multiline minRows={6} value={tryText} onChange={(e) => setTryText(e.target.value)} helperText={t('embedApps.format.tryHelp')} />
              <Box>
                <Button variant="outlined" onClick={() => void tryFill()} disabled={busy || !valid || !tryText.trim()}>
                  {t('embedApps.format.tryRun')}
                </Button>
              </Box>
              {tried && valid && (
                <Box data-testid="embed-format-try-result">
                  <Typography variant="caption" color="text.secondary">
                    {t('embedApps.format.tryElapsed', { s: (tried.elapsedMs / 1000).toFixed(1) })}
                  </Typography>
                  {tried.errors.length > 0 && <Alert severity="warning">{t('embedApps.format.tryErrors', { n: tried.errors.length })}</Alert>}
                  <Box sx={{ mt: 1 }}>
                    <SchemaForm schema={(parsed as { schema: Record<string, unknown> }).schema} value={tried.payload} errors={checkValue((parsed as { schema: Record<string, unknown> }).schema, tried.payload)} onChange={() => undefined} disabled />
                  </Box>
                </Box>
              )}
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          {t('common.cancel')}
        </Button>
        <Button variant="contained" onClick={() => void save()} disabled={busy || !valid || !id || !ko.trim() || !en.trim()}>
          {t('embedApps.format.save')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
