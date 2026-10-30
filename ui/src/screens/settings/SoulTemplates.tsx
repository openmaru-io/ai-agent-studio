/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 설정 › SOUL 템플릿: 회사 역할별 SOUL 템플릿을 보고, 관리자는 더하고 고치고 지우고 되돌린다. 계획 2026-10-13-009.
// 템플릿 본문은 「## 역할」부터다(결정 D1). 회사 소개 문장은 적용·미리 보기 때 서버가 첫 줄로 붙인다.
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import RestartAltOutlinedIcon from '@mui/icons-material/RestartAltOutlined';
import UndoOutlinedIcon from '@mui/icons-material/UndoOutlined';
import { Alert, Box, Button, NativeSelect, Stack, TextField, Typography } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { Suspense, useEffect, useId, useState } from 'react';

import { monoFont, Section, Tag } from '@/components/bits';
import { useConfirm } from '@/components/ConfirmDialog';
import { GridColumn, nameColumn, Pill } from '@/components/DataGrid';
import { DisclosureButton } from '@/components/DisclosureButton';
import { DrawerAction, DrawerActions } from '@/components/DrawerActions';
import { LazyCodeEditor } from '@/components/LazyCodeEditor';
import { ListView } from '@/components/ListView';
import { useUi } from '@/components/UiContext';
import { useOpenParam, useParamPatch, useRouteDrawer } from '@/components/useRouteDrawer';
import { t } from '@/i18n';
import { get, post } from '@/lib/api';

export interface SoulTemplate {
  id: string;
  lang: string;
  name: string;
  body: string;
  keywords: string;
  builtin: boolean;
  modified: boolean;
  deleted: boolean;
  rev: number;
  updated_by: string;
  updated_by_name?: string;
  updated_at: string;
}
export interface SoulTemplateList {
  templates: SoulTemplate[];
  langs: string[];
  placeholders: string[];
  can_edit: boolean;
  identity_sentence: string;
  /** 부서에 맞는 템플릿이 없는 새 사용자에게 쓸 템플릿(「id.lang」, 비면 없음, 스펙 2026-10-14-003 리뷰 D9) */
  default_template?: string;
}
interface TemplateVersion {
  rev: number;
  name: string;
  body: string;
  by: string;
  by_name?: string;
  ts: string;
  note: string;
}

export const TEMPLATES_KEY = ['soul-templates'];
export const useSoulTemplates = () =>
  useQuery<SoulTemplateList>({ queryKey: TEMPLATES_KEY, queryFn: () => get<SoulTemplateList>('/api/soul-templates') });

/** 목록 행·서랍을 여는 주소 값. id 와 언어를 함께 쓴다(키가 (id, lang) 이다). */
// 공통 표의 열(OMAI-1127). 두 줄 목록의 언어·종류 태그 → 열, 둘째 줄 요약 → 요약, 오른쪽 고친 때·키워드 → 열
const COLUMNS = (): GridColumn<SoulTemplate>[] => [
  nameColumn<SoulTemplate>({ id: 'name', label: t('soulTpl.name'), value: (x) => x.name }),
  {
    id: 'lang',
    label: t('soulTpl.lang'),
    value: (x) => t(`soulTpl.langName.${x.lang}`),
    width: '88px',
    render: (x) => <Pill>{t(`soulTpl.langName.${x.lang}`)}</Pill>,
  },
  { id: 'kind', label: t('soulTpl.kind'), value: (x) => (x.builtin ? 'builtin' : 'custom'), width: '104px', render: (x) => kindTag(x) },
  { id: 'summary', label: t('soulTpl.summary'), value: (x) => summaryOf(x.body), width: 'minmax(200px, 3fr)' },
  { id: 'keywords', label: t('soulTpl.keywords'), value: (x) => x.keywords, width: 'minmax(120px, 1fr)', hidden: true },
  {
    id: 'updated',
    label: t('soulTpl.updated'),
    value: (x) => x.updated_at ?? '',
    render: (x) => (x.updated_at ? `${x.updated_at.slice(0, 10)} ${x.updated_by_name || x.updated_by || ''}` : ''),
    width: '168px',
  },
];

export const tplKey = (x: Pick<SoulTemplate, 'id' | 'lang'>) => `${x.id}.${x.lang}`;
const splitKey = (key: string): [string, string] => {
  const i = key.lastIndexOf('.');
  return i < 0 ? [key, ''] : [key.slice(0, i), key.slice(i + 1)];
};

/** 본문에서 「## 역할」 다음 첫 문장 — 목록의 둘째 줄. */
export const summaryOf = (body: string): string =>
  body
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s && !s.startsWith('#') && !s.startsWith('-')) ?? '';

const kindTag = (x: SoulTemplate) =>
  x.deleted ? (
    <Tag key="k" tone="bad">
      {t('soulTpl.deleted')}
    </Tag>
  ) : x.builtin ? (
    <Tag key="k">{x.modified ? t('soulTpl.builtinModified') : t('soulTpl.builtin')}</Tag>
  ) : (
    <Tag key="k" tone="good">
      {t('soulTpl.custom')}
    </Tag>
  );

interface Draft {
  id: string;
  lang: string;
  name: string;
  keywords: string;
  body: string;
  rev?: number;
}

function Preview({ draft }: { draft: Draft }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const id = setTimeout(() => {
      post<{ content: string }>('/api/soul-templates/render', {
        id: draft.id,
        lang: draft.lang,
        name: draft.name,
        body: draft.body,
      })
        .then((r) => live && (setText(r.content), setError('')))
        .catch((e: Error) => live && setError(e.message));
    }, 300);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [draft.id, draft.lang, draft.name, draft.body]);
  if (error) return <Alert severity="error">{error}</Alert>;
  return (
    <Box
      component="pre"
      data-testid="soul-template-preview"
      sx={{
        fontFamily: monoFont,
        fontSize: 12.5,
        whiteSpace: 'pre-wrap',
        m: 0,
        p: 1.5,
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        bgcolor: 'action.hover',
      }}
    >
      {text}
    </Box>
  );
}

function Versions({ x, canEdit, onReverted }: { x: SoulTemplate; canEdit: boolean; onReverted: () => void }) {
  const q = useQuery<{ versions: TemplateVersion[] }>({
    queryKey: ['soul-template-versions', x.id, x.lang, x.rev],
    queryFn: () => get(`/api/soul-templates?id=${encodeURIComponent(x.id)}&lang=${encodeURIComponent(x.lang)}`),
  });
  const confirm = useConfirm();
  const { enqueueSnackbar } = useSnackbar();
  const [open, setOpen] = useState<number | null>(null);
  const baseId = useId();
  const rows = q.data?.versions ?? [];
  const title = (rev: number) => (rev === 0 ? t('soulTpl.originalVersion') : t('soulTpl.versionN', { n: rev }));
  if (!rows.length) return <Typography color="text.secondary">{t('soulTpl.noVersions')}</Typography>;
  return (
    <Stack spacing={1}>
      {rows.map((v) => (
        <Box key={v.rev} sx={{ borderBottom: 1, borderColor: 'divider', pb: 1 }}>
          <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {title(v.rev)}
            </Typography>
            {v.rev === x.rev && <Tag tone="good">{t('soulTpl.current')}</Tag>}
            <Typography variant="caption" color="text.secondary">
              {[v.ts.slice(0, 16).replace('T', ' '), v.by_name || v.by, v.note].filter(Boolean).join(' / ')}
            </Typography>
            <Box sx={{ flex: 1 }} />
            {/* 목록 줄 머리 단추: 보이는 글자는 「보기/접기」, 대상은 접근 이름이 줄 제목으로 말한다(스펙 2026-10-19-005 G12·R15). 색은 지금처럼 기본색(R8) */}
            <DisclosureButton
              open={open === v.rev}
              onToggle={() => setOpen(open === v.rev ? null : v.rev)}
              controls={`${baseId}-${v.rev}`}
              color="primary"
              aria-label={t(open === v.rev ? 'soulTpl.hideAria' : 'soulTpl.showAria', { title: title(v.rev) })}
              label={open === v.rev ? t('soulTpl.hide') : t('soulTpl.show')}
            />
            {canEdit && v.rev !== x.rev && (
              <Button startIcon={<UndoOutlinedIcon />}
                size="small"
                onClick={async () => {
                  if (!(await confirm(t('soulTpl.revertAsk', { n: v.rev })))) return;
                  try {
                    await post('/api/soul-templates', { op: 'revert', id: x.id, lang: x.lang, rev: v.rev });
                    enqueueSnackbar(t('soulTpl.reverted', { name: x.name, n: v.rev }), { variant: 'success' });
                    onReverted();
                  } catch (e) {
                    enqueueSnackbar((e as Error).message, { variant: 'error' });
                  }
                }}
              >
                {t('soulTpl.revertTo')}
              </Button>
            )}
          </Stack>
          {open === v.rev && (
            <Box id={`${baseId}-${v.rev}`} component="pre" sx={{ fontFamily: monoFont, fontSize: 12, whiteSpace: 'pre-wrap', m: 0, mt: 1 }}>
              {v.body}
            </Box>
          )}
        </Box>
      ))}
    </Stack>
  );
}

/** 템플릿 하나를 보고 고친다. x 가 없으면 새 템플릿(from 은 복제할 원본). */
export function TemplateEditor({
  x,
  from,
  canEdit,
  langs,
}: {
  x?: SoulTemplate;
  from?: SoulTemplate;
  canEdit: boolean;
  langs: string[];
}) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const { openDrawer, closeDrawer } = useUi();
  const patch = useParamPatch();
  const seed = x ?? from;
  const [draft, setDraft] = useState<Draft>({
    id: x?.id ?? '',
    lang: seed?.lang ?? langs[0] ?? 'ko',
    name: x ? x.name : from ? t('soulTpl.copyName', { name: from.name }) : '',
    keywords: seed?.keywords ?? '',
    body: seed?.body ?? '## ',
    rev: x?.rev,
  });
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'edit' | 'preview' | 'versions'>('edit');
  const changed = !x || x.deleted || draft.name !== x.name || draft.keywords !== x.keywords || draft.body !== x.body;
  const set = (k: keyof Draft) => (v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const refresh = () => qc.invalidateQueries({ queryKey: TEMPLATES_KEY });

  const run = async (body: Record<string, unknown>, done: string, after?: (r: { template: SoulTemplate }) => void) => {
    setBusy(true);
    setError('');
    try {
      const r = await post<{ template: SoulTemplate }>('/api/soul-templates', body);
      enqueueSnackbar(done, { variant: 'success' });
      await refresh();
      after?.(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(
      {
        op: 'save',
        id: x?.id,
        lang: draft.lang,
        name: draft.name,
        keywords: draft.keywords,
        body: draft.body,
        note,
        ...(x ? { base_rev: x.rev } : {}),
      },
      t('soulTpl.saved', { name: draft.name }),
      (r) => {
        setNote('');
        if (!x) {
          closeDrawer();
          patch({ tpl: tplKey(r.template) });
        } else setDraft((d) => ({ ...d, rev: r.template.rev }));
      }
    );

  // 복제·처음으로 되돌리기·지우기는 서랍 머리의 아이콘 단추다(COP Drawer 처럼, OMAI-1135). 저장(복원)은 본문에 남는다
  const actions: DrawerAction[] =
    !canEdit || !x
      ? []
      : [
          ...(!x.deleted
            ? [
                {
                  id: 'duplicate',
                  label: t('soulTpl.duplicate'),
                  description: t('soulTpl.duplicateTip'),
                  icon: ContentCopyOutlinedIcon,
                  onClick: () =>
                    openDrawer({
                      title: t('soulTpl.newTitle'),
                      sub: t('soulTpl.copyOf', { name: x.name }),
                      body: <TemplateEditor from={x} canEdit={canEdit} langs={langs} />,
                    }),
                },
              ]
            : []),
          ...(x.builtin && (x.modified || x.deleted)
            ? [
                {
                  id: 'reset',
                  label: t('soulTpl.reset'),
                  description: t('soulTpl.resetTip'),
                  icon: RestartAltOutlinedIcon,
                  confirm: {
                    message: t('soulTpl.resetAsk', { name: x.name }),
                    okLabel: t('soulTpl.reset'),
                    onConfirm: () =>
                      run({ op: 'reset', id: x.id, lang: x.lang }, t('soulTpl.resetDone', { name: x.name }), (r) =>
                        setDraft((d) => ({ ...d, name: r.template.name, keywords: r.template.keywords, body: r.template.body }))
                      ),
                  },
                },
              ]
            : []),
          ...(!x.deleted
            ? [
                {
                  id: 'delete',
                  label: t('soulTpl.delete'),
                  description: t('soulTpl.deleteTip'),
                  icon: DeleteOutlineIcon,
                  danger: true,
                  confirm: {
                    message: t('soulTpl.deleteAsk', { name: x.name }),
                    okLabel: t('soulTpl.delete'),
                    onConfirm: () => run({ op: 'delete', id: x.id, lang: x.lang }, t('soulTpl.deletedDone', { name: x.name }), () => closeDrawer()),
                  },
                },
              ]
            : []),
        ];

  return (
    <Stack spacing={1.5}>
      <DrawerActions actions={actions} />
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
        {(['edit', 'preview', ...(x ? ['versions'] : [])] as const).map((k) => (
          <Button
            key={k}
            size="small"
            variant={tab === k ? 'contained' : 'outlined'}
            aria-pressed={tab === k}
            onClick={() => setTab(k as typeof tab)}
          >
            {t(`soulTpl.tab.${k}`)}
          </Button>
        ))}
      </Stack>
      {x?.deleted && <Alert severity="warning">{t('soulTpl.deletedNote')}</Alert>}
      {tab === 'edit' && (
        <>
          <Stack direction="row" spacing={1}>
            <TextField
              size="small"
              fullWidth
              label={t('soulTpl.name')}
              value={draft.name}
              disabled={!canEdit}
              onChange={(e) => set('name')(e.target.value)}
            />
            <NativeSelect
              value={draft.lang}
              disabled={!canEdit || !!x}
              onChange={(e) => set('lang')(e.target.value)}
              inputProps={{ 'aria-label': t('soulTpl.lang') }}
            >
              {langs.map((l) => (
                <option key={l} value={l}>
                  {t(`soulTpl.langName.${l}`)}
                </option>
              ))}
            </NativeSelect>
          </Stack>
          <TextField
            size="small"
            label={t('soulTpl.keywords')}
            value={draft.keywords}
            disabled={!canEdit}
            onChange={(e) => set('keywords')(e.target.value)}
            helperText={t('soulTpl.keywordsHelp')}
          />
          <Typography variant="caption" color="text.secondary">
            {t('soulTpl.bodyHelp')}
          </Typography>
          <Suspense fallback={<Typography color="text.secondary">{t('soulTpl.loadingEditor')}</Typography>}>
            <LazyCodeEditor
              value={draft.body}
              onChange={canEdit ? set('body') : () => undefined}
              language="markdown"
              ariaLabel={t('soulTpl.body')}
              minRows={16}
              tabIndents
            />
          </Suspense>
          {canEdit && (
            <TextField size="small" label={t('soulTpl.note')} value={note} onChange={(e) => setNote(e.target.value)} />
          )}
        </>
      )}
      {tab === 'preview' && (
        <>
          <Typography variant="caption" color="text.secondary">
            {t('soulTpl.previewHelp')}
          </Typography>
          <Preview draft={draft} />
        </>
      )}
      {tab === 'versions' && x && <Versions x={x} canEdit={canEdit} onReverted={() => void refresh()} />}
      {error && <Alert severity="error">{error}</Alert>}
      {canEdit && (
        <Box>
          <Button variant="contained" disabled={busy || !changed || !draft.name.trim()} onClick={() => void save()}>
            {x?.deleted ? t('soulTpl.restore') : t('soulTpl.save')}
          </Button>
        </Box>
      )}
      {!canEdit && (
        <Typography variant="caption" color="text.secondary">
          {t('soulTpl.viewOnly')}
        </Typography>
      )}
    </Stack>
  );
}

function TemplateDrawerBody({ value }: { value: string }) {
  const q = useSoulTemplates();
  const [id, lang] = splitKey(value);
  const x = q.data?.templates.find((it) => it.id === id && it.lang === lang);
  if (!q.data) return <Typography color="text.secondary">{t('soulTpl.loading')}</Typography>;
  if (!x) return <Alert severity="warning">{t('soulTpl.notFound')}</Alert>;
  return (
    <TemplateEditor key={`${tplKey(x)}:${x.rev}:${x.deleted}`} x={x} canEdit={q.data.can_edit} langs={q.data.langs} />
  );
}

/** 부서에 맞는 템플릿이 없는 새 사용자에게 쓸 템플릿. 비우면 Hermes 기본 문장 그대로(스펙 2026-10-14-003 리뷰 D9) */
function DefaultTemplatePicker({ value, items }: { value: string; items: SoulTemplate[] }) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const change = async (key: string) => {
    const [id, lang] = key ? splitKey(key) : ['', ''];
    try {
      await post('/api/soul-templates', { op: 'default', id, lang });
      const picked = key ? items.find((i) => tplKey(i) === key) : undefined;
      enqueueSnackbar(key ? t('soulTpl.defaultSaved', { name: picked?.name ?? id }) : t('soulTpl.defaultCleared'), { variant: 'success' });
      await qc.invalidateQueries({ queryKey: TEMPLATES_KEY });
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    }
  };
  return (
    <NativeSelect
      size="small"
      value={value}
      onChange={(e) => void change(e.target.value)}
      inputProps={{ 'aria-label': t('soulTpl.defaultLabel') }}
    >
      <option value="">{t('soulTpl.defaultNone')}</option>
      {items.map((x) => (
        <option key={tplKey(x)} value={tplKey(x)}>
          {`${x.name} (${t(`soulTpl.langName.${x.lang}`)})`}
        </option>
      ))}
    </NativeSelect>
  );
}

export function SoulTemplates() {
  const q = useSoulTemplates();
  const { openDrawer } = useUi();
  // 행을 눌러 여는 서랍은 기록을 한 칸 쌓고, 닫으면 그 칸을 되감는다(스펙 2026-10-28-014 D9)
  const openTpl = useOpenParam('tpl');
  useRouteDrawer('tpl', (value) => ({
    title: t('soulTpl.drawerTitle'),
    sub: value,
    body: <TemplateDrawerBody value={value} />,
  }));
  const d = q.data;
  const all = d?.templates ?? [];
  const live = all.filter((x) => !x.deleted);
  return (
    <>
      <ListView<SoulTemplate>
        guide="soul-templates.list"
        title={t('views.soul-templates.label')}
        sub={t('soulTpl.lead', { sentence: d?.identity_sentence ?? '' })}
        error={q.error?.message}
        // 보기 카드(2026-10-17-011)가 탭 줄을 대신한다. 지운 것(관리자만) 보기에도 카드가 있어야 카드 모드가 유지된다
        tabs={[
          { id: 'all', label: t('soulTpl.tabAll'), items: live, card: {} },
          {
            id: 'builtin',
            label: t('soulTpl.builtin'),
            items: live.filter((x) => x.builtin),
            card: { sub: t('soulTpl.cardBuiltinSub', { n: live.filter((x) => x.modified).length }) },
          },
          {
            id: 'custom',
            label: t('soulTpl.custom'),
            items: live.filter((x) => !x.builtin),
            empty: t('soulTpl.customEmpty'),
            card: {},
          },
          ...(d?.can_edit
            ? [
                {
                  id: 'deleted',
                  label: t('soulTpl.deleted'),
                  items: all.filter((x) => x.deleted),
                  empty: t('soulTpl.deletedEmpty'),
                  card: {},
                },
              ]
            : []),
        ]}
        filters={[{ key: 'lang', label: t('soulTpl.lang'), get: (x) => t(`soulTpl.langName.${x.lang}`) }]}
        text={(x) => [x.name, x.id, x.keywords, x.body].join(' ')}
        toolbar={d?.can_edit ? <DefaultTemplatePicker value={d.default_template ?? ''} items={live} /> : undefined}
        // 새 템플릿은 표 툴바 오른쪽 끝(다른 목록 화면과 같은 자리)
        gridAction={
          d?.can_edit
            ? { label: t('soulTpl.new'), guide: 'soul-templates.add', onClick: () => openDrawer({ title: t('soulTpl.newTitle'), body: <TemplateEditor canEdit langs={d.langs} /> }) }
            : null
        }
        onRow={(x) => openTpl({ tpl: tplKey(x) })}
        id="soul-templates"
        columns={COLUMNS()}
        rowId={tplKey}
        note={t('soulTpl.note.list')}
      />
      {d && !d.can_edit && (
        <Section>
          <Typography variant="caption" color="text.secondary">
            {t('soulTpl.viewOnly')}
          </Typography>
        </Section>
      )}
    </>
  );
}
