/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 글 편집기: 보기 → 고치기(도구 줄·미리 보기·임시 저장) → 바뀐 줄 확인 → 저장(메모) → 이전 판 관리.
// 어디에 저장하는지는 부르는 쪽이 넘긴 함수가 정한다(모두 Hermes API 나 AAS 기록으로 간다).
// 고치는 칸은 COP Console 과 같은 Monaco 편집기다(CodeEditor, 번들해 폐쇄망에서도 동작). 찾기·바꾸기·줄 번호·색칠은 Monaco 가 한다.
// 아직 옮기지 않은 것: 나란히 미리 보기, 차례 이동, 전체 화면 (삭제된 옛 화면 aas/web/js/editor.js 에 있었다. 커밋 3e3319d).
import CompareArrowsOutlinedIcon from '@mui/icons-material/CompareArrowsOutlined';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import UndoOutlinedIcon from '@mui/icons-material/UndoOutlined';
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { visuallyHidden } from '@mui/utils';
import { useSnackbar } from 'notistack';
import { ReactNode, Suspense, useCallback, useEffect, useRef, useState } from 'react';

import { t } from '@/i18n';
import * as T from '@/lib/mdtools';
import { Edit, LineDiff } from '@/lib/mdtools';

import { Tag } from './bits';
import { type EditorHandle, type EditorKey, languageOf } from './codeLanguage';
import { CodeView } from './CodeView';
import { useConfirm } from './ConfirmDialog';
import { ItemList, ItemRow } from './ItemRow';
import { LazyCodeEditor } from './LazyCodeEditor';
import { Markdown } from './Markdown';
import { ActorChip } from './UserChip';
export interface Doc {
  lines: string[];
  sha: string;
  versions?: number;
  masked_lines?: number[];
}
export interface VersionInfo {
  id: number;
  sha: string;
  saved_at: string;
  by?: string;
  /** by 의 사람 이름(hermes:* 는 그대로, 2026-10-30) */
  by_name?: string;
  size: number;
  note?: string;
}
type DiffResult = LineDiff;

/** check 의 반환값: 문자열이면 저장을 막는 문제, 객체면 막는 문제(problem)와 막지 않는 경고(warnings)(2026-10-19-004 L2) */
export type CheckResult = string | void | null | { problem?: string; warnings?: string[] };

/** check 반환값을 { problem, warnings } 로 맞춘다. 문자열만 돌려주는 옛 호출처(GraphView·개요 소개 등)는 그대로 problem 이다 */
export function normalizeCheck(r: CheckResult): { problem: string; warnings: string[] } {
  if (!r) return { problem: '', warnings: [] };
  if (typeof r === 'string') return { problem: r, warnings: [] };
  return { problem: r.problem || '', warnings: (r.warnings ?? []).filter(Boolean) };
}

export interface TextEditorProps {
  label: string;
  doc: Doc;
  editable: boolean;
  whyNot?: string;
  hint?: string;
  mode?: 'markdown' | 'code';
  draftKey?: string;
  filename?: string;
  /** 이 글이 저장된 실제 파일(데이터 폴더 기준, 예: profiles/main/config.yaml). 줄·글자 수 앞에 보인다(2026-10-17-016) */
  path?: string;
  compact?: boolean;
  start?: 'edit' | 'history';
  check?: (content: string) => Promise<CheckResult> | CheckResult;
  save: (content: string, sha: string, note: string) => Promise<unknown>;
  reload: () => Promise<unknown>;
  refetch?: () => Promise<unknown>;
  versions?: () => Promise<VersionInfo[]>;
  version?: (id: number) => Promise<{ lines: string[] }>;
  diff?: (id: number) => Promise<DiffResult>;
  diff2?: (a: number, b: number) => Promise<DiffResult>;
  rename?: (id: number, note: string) => Promise<unknown>;
  revert?: (id: number, sha: string) => Promise<unknown>;
  onDirtyChange?: (dirty: boolean) => void;
  /** 이 글로 고치기를 연다(예: SOUL 템플릿에서 시작). nonce 가 바뀔 때마다 다시 연다. 저장은 평소처럼 바뀐 줄 확인을 거친다. */
  seed?: { text: string; nonce: number; note?: string };
  /** 저장 결과로 성공 안내 문장을 바꾼다(예: 알린 방 수). 없거나 빈 값이면 「저장했습니다」 */
  savedMessage?: (result: unknown) => string | undefined;
  /** 저장 메모 칸 아래 안내(예: 방 알림에 함께 보입니다) */
  noteHelp?: string;
  // ---- 아래는 작업 지침(AGENTS.md) 탭이 쓰는 선택 항목(2026-10-19-004). 넘기지 않으면 지금과 같다 ----
  /** 글자 수 한도. 고치는 동안 상태 줄에 「n / max자」를 보이고 넘으면 경고 색, 되돌리기 확인 창에도 warn 문장을 붙인다(D6·L2) */
  limit?: { max: number; warn: (n: number) => string };
  /** hint 를 단추 줄이 아니라 본문·편집기 아래 회색 글자로, 읽기 전용일 때도 보인다(D3·L3) */
  hintBelow?: boolean;
  /** 고칠 수 없을 때도 「고치기」 단추를 꺼진 채 보인다(D14) */
  editDisabled?: boolean;
  /** 읽기 전용 사유를 적은 요소의 id. 본문과 꺼진 「고치기」의 aria-describedby 로 잇는다(D13) */
  describedBy?: string;
  /** 저장 충돌(409) 문장. 없으면 공통 문장 */
  conflictText?: string;
  /** 저장 성공 스낵바를 띄우지 않는다(부르는 쪽이 따로 알린다). 되돌리기 성공은 그대로 알린다 */
  silentSave?: boolean;
  /** 판 목록의 작성자가 hermes:* 면 이름 대신 「에이전트」 칩으로 보인다(D9) */
  agentChip?: boolean;
  /** 보기 화면에서 임시 저장 안내 다음, 본문 앞에 둘 내용(예: 크기 경고) */
  notice?: ReactNode;
}

interface Draft {
  text: string;
  sha: string;
  ts: number;
}
const drafts = {
  get(key: string): Draft | null {
    try {
      return JSON.parse(localStorage.getItem('aas.draft.' + key) || 'null');
    } catch {
      return null;
    }
  },
  set(key: string, v: Draft): boolean {
    try {
      localStorage.setItem('aas.draft.' + key, JSON.stringify(v));
      return true;
    } catch {
      return false;
    }
  },
  del(key: string) {
    try {
      localStorage.removeItem('aas.draft.' + key);
    } catch {
      /* 저장소가 막혀 있어도 편집은 된다 */
    }
  },
};
const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 500);
}

export function DiffView({ d }: { d: DiffResult }) {
  if (d.same) return <Typography color="text.secondary">{t('editor.noDiff')}</Typography>;
  return (
    <Box
      component="pre"
      aria-label={t('editor.diffAria')}
      sx={{ overflow: 'auto', fontSize: 13, m: 0, p: 1, bgcolor: 'action.hover' }}
    >
      {d.lines.map((ln, i) => (
        <Box
          component="span"
          key={i}
          sx={{
            display: 'block',
            color: ln.startsWith('+')
              ? 'success.main'
              : ln.startsWith('-')
              ? 'error.main'
              : ln.startsWith('@@')
              ? 'info.main'
              : undefined,
          }}
        >
          {ln}
        </Box>
      ))}
    </Box>
  );
}

const tools = (): [string, string, (e: Edit) => Edit][] => [
  [t('editor.toolHeading'), 'H', (e) => T.linePrefix(e, '## ')],
  [t('editor.toolBold'), 'B', (e) => T.wrap(e, '**')],
  [t('editor.toolItalic'), 'I', (e) => T.wrap(e, '*')],
  [t('editor.toolList'), '•', (e) => T.linePrefix(e, '- ')],
  [t('editor.toolNumbered'), '1.', (e) => T.linePrefix(e, '', true)],
  [t('editor.toolTodo'), '☐', (e) => T.linePrefix(e, '- [ ] ')],
  [t('editor.toolQuote'), '❝', (e) => T.linePrefix(e, '> ')],
  [t('editor.toolCode'), '`', (e) => T.wrap(e, '`', '`', t('editor.codePlaceholder'))],
  [t('editor.toolCodeBlock'), '{ }', (e) => T.codeBlock(e)],
  [t('editor.toolLink'), '🔗', (e) => T.link(e)],
  [t('editor.toolTable'), '▦', (e) => T.table(e)],
  [t('editor.toolRule'), '―', (e) => T.block(e, '---')],
];

type Step =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'review'; diff: DiffResult; problem: string; warnings: string[]; sha: string; rebase: boolean }
  | { kind: 'conflict' };

export function TextEditor(props: TextEditorProps) {
  const { label, doc, editable, mode = 'markdown', compact } = props;
  const isMd = mode === 'markdown';
  const narrow = useMediaQuery(useTheme().breakpoints.down('sm'));
  const confirm = useConfirm();
  const { enqueueSnackbar } = useSnackbar();
  const [stage, setStage] = useState<'view' | 'edit' | 'history'>(props.start ?? 'view');
  const [showRaw, setShowRaw] = useState(false);
  const [, bump] = useState(0);

  // ---- 고치기 상태 ----
  const [base, setBase] = useState('');
  const [baseSha, setBaseSha] = useState('');
  const [text, setText] = useState('');
  const [lastDraft, setLastDraft] = useState(0);
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [note, setNote] = useState('');
  const [saveError, setSaveError] = useState('');
  const [preview, setPreview] = useState(false);
  const [tabTrap, setTabTrap] = useState(true);
  const [tabHint, setTabHint] = useState(false);
  const ed = useRef<EditorHandle>(null);
  const pendingSel = useRef<[number, number] | null>(null);
  const dirty = stage === 'edit' && text !== base;

  useEffect(() => props.onDirtyChange?.(dirty), [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // 도구로 글을 바꾼 뒤 선택 범위를 되돌린다. 편집 칸이 새 값을 받은 뒤(자식 효과가 먼저 돈다)라 useEffect 다
  useEffect(() => {
    if (pendingSel.current && ed.current) {
      ed.current.select(...pendingSel.current);
      pendingSel.current = null;
    }
  }, [text]);

  // 임시 저장: 고친 뒤 0.6초 쉬면 이 브라우저에 남긴다
  useEffect(() => {
    if (stage !== 'edit' || !props.draftKey) return;
    const key = props.draftKey;
    const id = setTimeout(() => {
      if (text === base) {
        drafts.del(key);
        setLastDraft(0);
      } else if (drafts.set(key, { text, sha: baseSha, ts: Date.now() })) setLastDraft(Date.now());
    }, 600);
    return () => clearTimeout(id);
  }, [text, stage, base, baseSha, props.draftKey]);

  const startEdit = useCallback(
    (draft?: Draft | null) => {
      const orig = doc.lines.join('\n');
      setBase(orig);
      setBaseSha(doc.sha);
      setText(draft ? draft.text : orig);
      setLastDraft(draft ? draft.ts : 0);
      setStep({ kind: 'idle' });
      setNote('');
      setSaveError('');
      setPreview(false);
      setStage('edit');
    },
    [doc]
  );
  useEffect(() => {
    if (props.start === 'edit') startEdit();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!props.seed) return;
    startEdit({ text: props.seed.text, sha: doc.sha, ts: 0 });
    setNote(props.seed.note ?? '');
  }, [props.seed?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const leaveEdit = () => {
    setStage('view');
    bump((n) => n + 1);
  };
  const done = async (msg: string, quiet = false) => {
    if (props.draftKey) drafts.del(props.draftKey);
    if (!quiet) enqueueSnackbar(msg, { variant: 'success' });
    await props.reload();
    setStage('view');
  };

  // ---- 보기 ----
  if (stage === 'view') {
    const body = doc.lines.join('\n');
    const draft = props.draftKey ? drafts.get(props.draftKey) : null;
    return (
      <Box>
        <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap" sx={{ mb: 1 }}>
          {(editable || props.editDisabled) && (
            <Button
              variant="contained"
              size="small"
              startIcon={<EditOutlinedIcon />}
              disabled={!editable}
              aria-describedby={!editable ? props.describedBy : undefined}
              onClick={() => startEdit()}
            >
              {body ? t('editor.edit') : t('editor.write')}
            </Button>
          )}
          {!!doc.versions && (
            <Button startIcon={<HistoryOutlinedIcon />}
              size="small"
              variant="outlined"
              onClick={() => setStage('history')}
            >{t('editor.versionsBtn', { n: doc.versions })}</Button>
          )}
          {isMd && body && (
            <Button size="small" variant="outlined" aria-pressed={showRaw} onClick={() => setShowRaw((v) => !v)}>
              {showRaw ? t('editor.prettyView') : t('editor.rawView')}
            </Button>
          )}
          {body && (
            <Button startIcon={<ContentCopyOutlinedIcon />}
              size="small"
              variant="outlined"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(body);
                  enqueueSnackbar(t('editor.copied'), { variant: 'success' });
                } catch {
                  enqueueSnackbar(t('editor.copyFailed'), { variant: 'error' });
                }
              }}
            >
              {t('editor.copy')}
            </Button>
          )}
          {body && props.filename && (
            <Button startIcon={<DownloadOutlinedIcon />} size="small" variant="outlined" onClick={() => download(props.filename as string, body)}>
              {t('editor.download')}
            </Button>
          )}
          <Typography variant="caption" color="text.secondary">
            {editable ? (props.hintBelow ? null : props.hint) : props.whyNot}
          </Typography>
        </Stack>
        {draft && draft.text !== body && editable && (
          <Alert
            severity="info"
            sx={{ mb: 1 }}
            action={
              <>
                <Button size="small" onClick={() => startEdit(draft)}>
                  {t('editor.resume')}
                </Button>
                <Button
                  size="small"
                  onClick={() => {
                    drafts.del(props.draftKey as string);
                    bump((n) => n + 1);
                  }}
                >
                  {t('editor.discard')}
                </Button>
              </>
            }
          >
            {t('editor.unsavedDraft', { time: hhmm(draft.ts) })}
          </Alert>
        )}
        {props.notice}
        {!compact && (
          <Typography variant="caption" color="text.secondary" component="div">
            {props.path && (
              <>
                <Box component="code" data-file-path="" sx={{ color: 'text.primary' }}>
                  {props.path}
                </Box>
                {' · '}
              </>
            )}
            {t('editor.stats', { lines: doc.lines.length, chars: body.length }) +
              (doc.masked_lines?.length ? t('editor.maskedSuffix', { n: doc.masked_lines.length }) : '')}
          </Typography>
        )}
        <Box aria-describedby={props.describedBy}>
          {!body ? (
            <Typography color="text.secondary">{t('editor.empty')}</Typography>
          ) : isMd && !showRaw ? (
            <Markdown text={body} />
          ) : (
            <CodeView text={body} filename={props.filename} label={label} markdown={isMd} />
          )}
        </Box>
        {props.hintBelow && props.hint && (
          <Typography variant="caption" color="text.secondary" component="p" data-editor-hint="" sx={{ mt: 1 }}>
            {props.hint}
          </Typography>
        )}
      </Box>
    );
  }

  // ---- 이전 판 ----
  if (stage === 'history') return <History {...props} onBack={() => setStage('view')} done={done} />;

  // ---- 고치기 ----
  const apply = (fn: (e: Edit) => Edit | null) => {
    const el = ed.current;
    if (!el) return false;
    const [start, end] = el.selection();
    const r = fn({ value: text, start, end });
    if (!r) return false;
    pendingSel.current = [r.start, r.end];
    setText(r.value);
    el.focus();
    return true;
  };

  const review = async (rebase = false) => {
    if (!dirty && !rebase) {
      enqueueSnackbar(t('editor.noChanges'), { variant: 'info' });
      return;
    }
    setStep({ kind: 'checking' });
    const from = rebase ? doc.lines.join('\n') : base;
    const sha = rebase ? doc.sha : baseSha;
    let checked = normalizeCheck('');
    try {
      checked = normalizeCheck(props.check ? await props.check(text) : '');
    } catch (e) {
      checked = { problem: (e as Error).message, warnings: [] };
    }
    setSaveError('');
    setStep({ kind: 'review', diff: T.lineDiff(from, text), ...checked, sha, rebase });
  };

  const save = async (sha: string) => {
    try {
      const result = await props.save(text, sha, note.trim());
      await done(props.savedMessage?.(result) || t('editor.saved', { label: props.label }), props.silentSave);
    } catch (e) {
      const msg = (e as Error).message;
      if ((e as { status?: number }).status === 409) {
        await (props.refetch ?? props.reload)(); // 화면은 두고 지금 저장된 내용만 새로 받는다(고치던 글을 지키려고)
        setStep({ kind: 'conflict' });
      } else setSaveError(msg);
    }
  };

  const onKeyDown = (e: EditorKey) => {
    const mod = e.mod;
    const k = e.key.toLowerCase();
    if (mod && k === 's') {
      e.preventDefault();
      review();
    } else if (isMd && mod && k === 'b') {
      e.preventDefault();
      apply((x) => T.wrap(x, '**'));
    } else if (isMd && mod && k === 'i') {
      e.preventDefault();
      apply((x) => T.wrap(x, '*'));
    } else if (isMd && mod && k === 'k') {
      e.preventDefault(); // 명령 팔레트(⌘K)로 올라가지 않게 전파도 막는다
      apply(T.link);
    } else if (e.key === 'Escape') {
      setTabTrap(false);
      setTabHint(true);
    } else if (e.key === 'Tab' && tabTrap && !mod && !e.alt) {
      e.preventDefault();
      apply((x) => T.indent(x, e.shift));
    } else if (e.key === 'Enter' && !e.shift && !e.composing && isMd && ed.current) {
      const [start, end] = ed.current.selection();
      const r = T.enter({ value: text, start, end });
      if (r) {
        e.preventDefault();
        apply(() => r);
      }
    }
  };

  const lines = text.split('\n').length;
  const limit = props.limit;
  const over = !!limit && text.length > limit.max;
  const status =
    (dirty ? t('editor.statusDirty') : t('editor.statusClean')) +
    (lastDraft && dirty ? t('editor.statusDraft', { time: hhmm(lastDraft) }) : '') +
    (limit ? t('editor.statusLines', { lines }) : t('editor.statusCounts', { lines, chars: text.length }));

  const cancel = async () => {
    if (dirty && !(await confirm(t('editor.confirmCancel')))) return;
    leaveEdit();
  };
  const reset = async () => {
    if (text === base || !(await confirm(t('editor.confirmReset')))) return;
    setText(base);
    if (props.draftKey) drafts.del(props.draftKey);
    setLastDraft(0);
  };

  return (
    <Box>
      <Typography variant="caption" color="text.secondary" component="div">
        {t('editor.editing', { label })}
        {lastDraft || baseSha !== doc.sha
          ? baseSha !== doc.sha
            ? ' ' + t('editor.sourceChanged')
            : ''
          : ''}
      </Typography>
      <Stack
        direction="row"
        spacing={0.5}
        alignItems="center"
        useFlexGap
        flexWrap="wrap"
        role="toolbar"
        aria-label={t('editor.toolbarAria')}
        sx={{ my: 1 }}
      >
        {isMd ? (
          tools().map(([title, glyph, run]) => (
            <Button
              key={title}
              size="small"
              aria-label={title}
              title={title}
              onClick={() => apply(run)}
              sx={{ minWidth: 32 }}
            >
              {glyph}
            </Button>
          ))
        ) : (
          <Typography variant="caption" color="text.secondary">
            {t('editor.codeModeNote')}
          </Typography>
        )}
        <Box sx={{ flex: 1 }} />
        {isMd && !compact && (
          <ToggleButton
            value="preview"
            size="small"
            selected={preview}
            onChange={() => setPreview((v) => !v)}
            aria-pressed={preview}
          >
            {t('editor.preview')}
          </ToggleButton>
        )}
      </Stack>
      {preview ? (
        <Paper variant="outlined" aria-label={t('editor.preview')} sx={{ p: 1.5, minHeight: 200 }}>
          <Markdown text={text} />
        </Paper>
      ) : (
        <Suspense fallback={<Typography color="text.secondary">{t('editor.loading')}</Typography>}>
          <LazyCodeEditor
            handle={ed}
            value={text}
            onChange={setText}
            language={languageOf(props.filename, isMd)}
            ariaLabel={t('editor.textareaAria', { label })}
            minRows={compact ? 6 : 14}
            tabIndents={tabTrap}
            onKey={onKeyDown}
            onFocus={() => {
              setTabTrap(true);
              setTabHint(false);
            }}
          />
        </Suspense>
      )}
      {limit ? (
        // 글자 수는 상태 줄 옆(좁은 화면은 아래 줄). 넘으면 경고 색과 아이콘, 넘는 순간에만 한 번 읽어 준다(D6·D12·D13)
        <Stack direction={narrow ? 'column' : 'row'} spacing={narrow ? 0 : 1} useFlexGap sx={{ mt: 0.5 }}>
          <Typography variant="caption" color="text.secondary" component="div" aria-live="polite">
            {tabHint ? t('editor.tabHint') : status}
          </Typography>
          <Typography
            variant="caption"
            component="div"
            data-limit-count={over ? 'over' : 'ok'}
            sx={{ color: over ? 'warning.main' : 'text.secondary', display: 'inline-flex', alignItems: 'center', gap: 0.5 }}
          >
            {over && <WarningAmberRoundedIcon sx={{ fontSize: 14 }} aria-hidden />}
            {t('editor.limitCount', { n: text.length.toLocaleString(), max: limit.max.toLocaleString() })}
            {over && ' ' + t('editor.overLimitShort')}
          </Typography>
          <Box component="span" aria-live="polite" sx={visuallyHidden}>
            {over ? t('editor.overLimitLive') : ''}
          </Box>
        </Stack>
      ) : (
        <Typography variant="caption" color="text.secondary" component="div" aria-live="polite" sx={{ mt: 0.5 }}>
          {tabHint ? t('editor.tabHint') : status}
        </Typography>
      )}
      {props.hintBelow && props.hint && (
        <Typography variant="caption" color="text.secondary" component="p" data-editor-hint="" sx={{ mt: 0.5 }}>
          {props.hint}
        </Typography>
      )}

      <Box sx={{ mt: 1.5 }}>
        {step.kind === 'review' ? (
          <Stack spacing={1}>
            <Typography variant="caption" color="text.secondary">
              {t('editor.addedRemoved', { added: step.diff.added, removed: step.diff.removed }) +
                (step.rebase ? ' ' + t('editor.comparedToCurrent') : '')}
            </Typography>
            <DiffView d={step.diff} />
            {step.problem && <Alert severity="error">{step.problem}</Alert>}
            {/* 막지 않는 경고(크기 등): 보이기만 하고 저장 단추는 그대로 켜 둔다(R1) */}
            {step.warnings.map((w) => (
              <Alert key={w} severity="warning">
                {w}
              </Alert>
            ))}
            {saveError && <Alert severity="error">{saveError}</Alert>}
            <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
              <TextField
                size="small"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t('editor.notePlaceholder')}
                helperText={props.noteHelp}
                slotProps={{ htmlInput: { 'aria-label': t('editor.noteAria'), maxLength: 200 } }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !step.problem && !step.diff.same) save(step.sha);
                }}
                sx={{ flex: 1, minWidth: 200 }}
              />
              <Button variant="contained" disabled={!!step.problem || step.diff.same} onClick={() => save(step.sha)}>
                {step.rebase ? t('editor.saveMine') : t('editor.saveAsIs')}
              </Button>
              <Button onClick={() => setStep({ kind: 'idle' })}>{t('editor.keepEditing')}</Button>
            </Stack>
          </Stack>
        ) : step.kind === 'conflict' ? (
          <Stack spacing={1}>
            <Alert severity="warning">
              {props.conflictText ?? t('editor.conflict')}
            </Alert>
            <Stack direction="row" spacing={1}>
              <Button startIcon={<CompareArrowsOutlinedIcon />} variant="contained" onClick={() => review(true)}>
                {t('editor.showDiff')}
              </Button>
              <Button onClick={() => setStep({ kind: 'idle' })}>{t('editor.keepEditing')}</Button>
            </Stack>
          </Stack>
        ) : step.kind === 'checking' ? (
          <Typography color="text.secondary">{t('editor.checking')}</Typography>
        ) : (
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
            <Button variant="contained" disabled={!dirty} onClick={() => review()}>
              {t('editor.reviewBtn')}
            </Button>
            <Button onClick={cancel}>{t('editor.quit')}</Button>
            <Button startIcon={<UndoOutlinedIcon />} onClick={reset}>{t('editor.revertAll')}</Button>
          </Stack>
        )}
      </Box>
    </Box>
  );
}

/** 판 목록 한 줄의 설명. agentChip 이면 hermes:* 작성자를 「에이전트」 칩으로 바꾼다(문장 틀은 번역 그대로 쓴다) */
function versionLine(v: VersionInfo, agentChip: boolean): ReactNode {
  const time = v.saved_at.slice(0, 16).replace('T', ' ');
  if (!(agentChip && v.by?.startsWith('hermes:')))
    return t('editor.versionInfo', { time, by: v.by_name || v.by || t('editor.beforeEdit'), size: v.size });
  const [head, tail] = t('editor.versionInfo', { time, by: '\u0001', size: v.size }).split('\u0001');
  return (
    <>
      {head}
      <ActorChip kind="agent" label={t('editor.byAgent')} />
      {tail}
    </>
  );
}

// ---- 이전 판 ----
function History(props: TextEditorProps & { onBack: () => void; done: (msg: string) => Promise<void> }) {
  const { label, doc, editable } = props;
  const confirm = useConfirm();
  const { enqueueSnackbar } = useSnackbar();
  const [list, setList] = useState<VersionInfo[] | null>(null);
  const [error, setError] = useState('');
  const [out, setOut] = useState<ReactNode>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [draftName, setDraftName] = useState('');

  useEffect(() => {
    props
      .versions?.()
      .then(setList)
      .catch((e: Error) => setError(e.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <Alert severity="error">{error}</Alert>;
  if (!list) return <Typography color="text.secondary">{t('editor.loading')}</Typography>;

  const fail = (e: unknown) => enqueueSnackbar((e as Error).message, { variant: 'error' });
  const sorted = [...picked].sort((a, b) => a - b);

  const row = (v: VersionInfo) => {
    const current = v.sha === doc.sha;
    return (
      <ItemRow
        key={v.id}
        icon={HistoryOutlinedIcon}
        lead={props.diff2 ? (
          <Checkbox
            size="small"
            inputProps={{ 'aria-label': t('editor.pickVersionAria', { id: v.id }) }}
            checked={picked.includes(v.id)}
            onChange={(e) => setPicked((cur) => (e.target.checked ? [...cur, v.id] : cur.filter((x) => x !== v.id)))}
          />
        ) : undefined}
        name={t('editor.versionN', { id: v.id })}
        tags={
          <>
            {current && <Tag tone="good">{t('editor.current')}</Tag>}
            {renaming === v.id ? (
              <>
                <TextField
                  size="small"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  slotProps={{ htmlInput: { 'aria-label': t('editor.renameAria', { id: v.id }), maxLength: 200 } }}
                />
                <Button
                  size="small"
                  onClick={async () => {
                    try {
                      await props.rename?.(v.id, draftName.trim());
                      setList((cur) => cur && cur.map((x) => (x.id === v.id ? { ...x, note: draftName.trim() } : x)));
                      setRenaming(null);
                      enqueueSnackbar(t('editor.renamed', { id: v.id }), { variant: 'success' });
                    } catch (e) {
                      fail(e);
                    }
                  }}
                >
                  {t('editor.save')}
                </Button>
              </>
            ) : (
              v.note && <Tag>{v.note}</Tag>
            )}
          </>
        }
        description={versionLine(v, !!props.agentChip)}
        control={
          <>
          {!current && props.diff && (
            <Button
              size="small"
              onClick={async () => {
                try {
                  const x = await (props.diff as (id: number) => Promise<DiffResult>)(v.id);
                  setOut(
                    <>
                      <Typography variant="caption">
                        {t('editor.diffVersionToNow', { id: v.id, added: x.added, removed: x.removed })}
                      </Typography>
                      <DiffView d={x} />
                    </>
                  );
                } catch (e) {
                  fail(e);
                }
              }}
            >
              {t('editor.diffToNow')}
            </Button>
          )}
          {props.version && (
            <Button
              size="small"
              onClick={async () => {
                try {
                  const x = await (props.version as (id: number) => Promise<{ lines: string[] }>)(v.id);
                  const body = x.lines.join('\n');
                  setOut(
                    <>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <strong>{t('editor.versionN', { id: v.id })}</strong>
                        <Button startIcon={<ContentCopyOutlinedIcon />} size="small" onClick={() => navigator.clipboard.writeText(body)}>
                          {t('editor.copy')}
                        </Button>
                        {props.filename && (
                          <Button startIcon={<DownloadOutlinedIcon />}
                            size="small"
                            onClick={() =>
                              download((props.filename as string).replace(/(\.\w+)?$/, `.v${v.id}$1`), body)
                            }
                          >
                            {t('editor.download')}
                          </Button>
                        )}
                      </Stack>
                      <CodeView text={body} filename={props.filename} label={t('editor.versionN', { id: v.id })} markdown={props.mode === 'markdown'} />
                    </>
                  );
                } catch (e) {
                  fail(e);
                }
              }}
            >
              {t('editor.view')}
            </Button>
          )}
          {props.rename && editable && (
            <Button
              size="small"
              onClick={() => {
                setRenaming(v.id);
                setDraftName(v.note || '');
              }}
            >
              {t('editor.name')}
            </Button>
          )}
          {editable && props.revert && !current && (
            <Button startIcon={<UndoOutlinedIcon />}
              size="small"
              onClick={async () => {
                // 그 판이 한도를 넘으면 확인 창에도 크기 경고를 붙인다(2026-10-19-004 L2)
                const warn = props.limit && v.size > props.limit.max ? ' ' + props.limit.warn(v.size) : '';
                if (!(await confirm(t('editor.confirmRevert', { id: v.id }) + warn))) return;
                try {
                  await props.revert?.(v.id, doc.sha);
                  await props.done(t('editor.reverted', { label: props.label, id: v.id }));
                } catch (e) {
                  fail(e);
                }
              }}
            >
              {t('editor.revert')}
            </Button>
          )}
          </>
        }
      />
    );
  };

  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        <Button size="small" onClick={props.onBack}>
          {t('editor.back')}
        </Button>
        <strong>{t('editor.historyTitle', { label, n: list.length })}</strong>
        {props.diff2 && list.length > 1 && (
          <Button startIcon={<CompareArrowsOutlinedIcon />}
            size="small"
            disabled={picked.length !== 2}
            onClick={async () => {
              const [a, b] = sorted;
              try {
                const x = await (props.diff2 as (a: number, b: number) => Promise<DiffResult>)(a, b);
                setOut(
                  <>
                    <Typography variant="caption">
                      {t('editor.diffBetween', { a, b, added: x.added, removed: x.removed })}
                    </Typography>
                    <DiffView d={x} />
                  </>
                );
              } catch (e) {
                fail(e);
              }
            }}
          >
            {t('editor.compareTwo')}
          </Button>
        )}
      </Stack>
      <ItemList>{list.map(row)}</ItemList>
      <Box sx={{ mt: 1 }}>{out}</Box>
      <Typography variant="caption" color="text.secondary" component="p">
        {list.length ? t('editor.historyNote') : t('editor.noVersions')}
      </Typography>
    </Box>
  );
}
