/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 스킬: 무엇이 이 스킬을 부르고, 이 스킬이 무엇을 부르는지. SKILL.md 와 같은 폴더의 파일을 정적으로 읽은 결과다.
import AddIcon from '@mui/icons-material/Add';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import FolderZipOutlinedIcon from '@mui/icons-material/FolderZipOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import { Alert, Autocomplete, Box, Button, IconButton, NativeSelect, Stack, Tab, Tabs, TextField, Tooltip, Typography } from '@mui/material';
import { visuallyHidden } from '@mui/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { ReactNode, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { AddAction, AddIconButton } from '@/components/AddIconButton';
import { AiSummary } from '@/components/AiSummary';
import { ChatChip, KV, LinkChip, Mono, monoFont, RowList, ScreenLoading, Section, Tag } from '@/components/bits';
import { BundledRepair, BundledRepairNote } from '@/components/BundledRepairNote';
import { GridColumn, nameColumn, Pill } from '@/components/DataGrid';
import { DescTranslation } from '@/components/DescTranslation';
import { DisclosureButton } from '@/components/DisclosureButton';
import { DrawerActions } from '@/components/DrawerActions';
import { type PageOf } from '@/components/drawerPages';
import { useDrawerHead } from '@/components/drawerScope';
import { ListView } from '@/components/ListView';
import { MarkdownField } from '@/components/MarkdownField';
import { ALL_PROFILES, ProfileScopePicker, useProfileScope } from '@/components/ProfileScopeSelect';
import { TagBar, tagCounts, tagLabel, tagMatches } from '@/components/TagBar';
import { TeamTargetNote } from '@/components/TeamTargetNote';
import { tier1, tier2 } from '@/components/tierButton';
import { useUi } from '@/components/UiContext';
import { useRoutePage } from '@/components/useRoutePage';
import { ScriptReview, sendZip, ZipDropZone, ZipFile, ZipFileChip, ZipFileList, zipProblem, ZipScript } from '@/components/zipParts';
import { t } from '@/i18n';
import { ApiError, get, post } from '@/lib/api';
import { openChat } from '@/lib/chatPopup';
import { useIsAdmin, useMe } from '@/lib/data';
import { profileName } from '@/lib/format';
import { cleanSkillBody } from '@/lib/skillTemplate';
import { isMySkill } from '@/screens/profiles/skillOrigin';
import { agentOrder, AgentSkills, type AgentSkillsData } from '@/screens/skills/AgentSkills';
import { useSkillDelete } from '@/screens/skills/DeleteSkill';
import { DownloadSkill } from '@/screens/skills/DownloadSkill';

interface SkillRow {
  id: string;
  name: string;
  description?: string;
  /** 번역을 붙였을 때 원문과 출처("llm" | "seed"). 영어 화면이나 번역 전이면 없다(스펙 2026-10-19-017 P5) */
  description_src?: string;
  description_by?: string;
  profile: string;
  /** 출처(bundled·bundled_modified·hub·market·agent·local) — 서버가 Hermes 파일을 읽어 판정한다 */
  origin?: string;
  /** 설정의 skills.external_dirs 로 다른 프로파일에서 가져온 스킬이면 그 프로파일 이름(스펙 2026-10-15-011 D6) */
  shared_from?: string;
  n_cron: number;
  n_mcp: number;
  n_rest: number;
  n_scripts: number;
  /** 부르는 외부 URL(호스트 순, 호스트마다 5개까지). 외부 URL 탭의 열에 쓴다 */
  urls?: string[];
  /** 서버가 LLM 으로 붙인 태그 id(마켓과 같은 어휘, OMAI-1283). 아직 분류 전이면 비어 있다 */
  tags?: string[];
  /** 스킬 허브에 이 스킬의 더 새 버전이 있으면 그 버전(올릴 수 있는 사람에게만, 스펙 2026-10-24-003 D15) */
  new_version?: string;  /** 화면에서 지울 수 없는 이유(origin·same_name·name), 빈 값이면 지울 수 있다(스펙 2026-10-29-005 DD3) */
  delete_block?: string;
}
interface SkillsData {
  totals: { skills: number; with_cron: number; with_mcp: number; with_rest: number };
  skills: SkillRow[];
  by_mcp: Record<string, string[]>;
  by_host: Record<string, string[]>;
  /** 새 스킬을 넣을 수 있는 프로파일(서버가 정함). 루트가 숨겨진 POD 는 default 가 없다(OMAI-1195) */
  profiles?: string[];
  primary?: string;
  /** 관리자나 이 POD 의 주인만 true — 「zip 올리기」 탭을 그린다(DR5) */
  can_upload?: boolean;
  /** 최근 7일 안에 서버가 되돌린 가려진 기본 스킬(스펙 2026-10-27-011 D14) */
  bundled_repaired?: BundledRepair[];
  /** 에이전트(프로파일)별 요약 — 에이전트 중심 보기의 왼쪽 칸. 옛 서버면 없다 */
  agents?: AgentSkillsData['agents'];
}
interface SkillOne {
  name: string;
  description?: string;
  description_src?: string;
  description_by?: string;
  profile: string;
  path: string;
  modified?: string;
  origin?: string;
  shared_from?: string;
  files: number;
  cron: { profile: string; job: string; enabled: boolean; last_status?: string }[];
  mcp: { server: string; tools: string[]; evidence?: string }[];
  /** 부르는 외부 호스트 — SKILL.md 와 따라간 스크립트에 나온 것(스펙 2026-10-28-013 D2·D3). files 는 나온 파일 */
  rest: { host: string; urls: string[]; files?: string[] }[];
  /** README·참고 글에만 나온 호스트(부르는 수에서 뺀다) */
  rest_doc?: { host: string; files: string[] }[];
  skills: string[];
  scripts: string[];
  external_scripts: string[];
  tags?: string[];
  /** 스킬이 SKILL.md 머리에 선언한 필요한 비밀값(스펙 2026-10-16-010 2단계). set 은 그 프로파일 .env 에 값이 있는가 */
  required_env?: { name: string; prompt?: string; help?: string; required_for?: string; optional?: boolean; set?: boolean }[];
}

const originLabel = (o?: string) => (o ? t(`skills.origin.${o}` as Parameters<typeof t>[0]) : '');
const where = (s: { profile: string; shared_from?: string }) =>
  (s.profile === 'default' ? t('skills.shared') : s.profile) + (s.shared_from ? ' ' + t('skills.sharedFrom', { name: s.shared_from === 'default' ? t('skills.shared') : s.shared_from }) : '');
const newSkillPrompt = () => t('skills.newSkillPrompt');
const bodyTemplate = () => t('skills.bodyTemplate');
const commaList = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
const chat = (agent: string, text: string) => ({ agent, text });

// 공통 표의 열(OMAI-1127). 두 줄 목록의 cron 태그·오른쪽 MCP·URL·스크립트 수 → 숫자 열, 둘째 줄 → 위치·설명
const count = (id: string, label: string, get: (s: SkillRow) => number): GridColumn<SkillRow> => ({
  id,
  label,
  value: get,
  width: '80px',
  num: true,
});
const COLUMNS = (showTags: boolean, showWhere = true): GridColumn<SkillRow>[] => [
  nameColumn<SkillRow>({ label: t('skills.title'), value: (s) => s.name }),
  // 위치 값이 하나뿐이면(프로파일 하나를 골랐고 공용 줄이 없으면) 열을 뺀다(스펙 2026-10-27-013 엔지니어링 D6, 디자인 12A)
  ...(showWhere ? [{ id: 'profile', label: t('skills.location'), value: where, width: 'minmax(96px, auto)' }] : []),
  {
    id: 'origin',
    label: t('skills.origin'),
    value: (s) => originLabel(s.origin),
    width: 'minmax(112px, auto)',
    render: (s) => (
      <>
        <span>{originLabel(s.origin)}</span>
        {s.new_version && <Pill tone="warn">{t('market.newVersionV', { v: s.new_version })}</Pill>}
      </>
    ),
  },
  // 태그가 하나라도 있을 때만 보인다(OMAI-1283, 마켓과 같다). 알약 둘까지 + 「+N」, 정렬·검색은 태그 이름 글자로 한다
  ...(showTags
    ? [
        {
          id: 'tags',
          label: t('market.grid.tags'),
          value: (s) => (s.tags ?? []).map(tagLabel).join(' '),
          width: 'minmax(176px, auto)',
          render: (s) => (
            <>
              {(s.tags ?? []).slice(0, 2).map((id, i) => (
                <Pill key={id} flush={i === 0}>
                  {tagLabel(id)}
                </Pill>
              ))}
              {(s.tags ?? []).length > 2 && <Pill>{`+${(s.tags ?? []).length - 2}`}</Pill>}
            </>
          ),
        } as GridColumn<SkillRow>,
      ]
    : []),
  {
    id: 'description',
    label: t('skills.description'),
    value: (s) => s.description || t('skills.noDescription'),
    width: 'minmax(200px, 3fr)',
  },
  count('n_cron', t('skills.grid.cron'), (s) => s.n_cron),
  count('n_scripts', t('skills.grid.scripts'), (s) => s.n_scripts),
  count('n_mcp', 'MCP', (s) => s.n_mcp),
  count('n_rest', 'URL', (s) => s.n_rest),
];

// 외부 URL 탭의 「호출 URL」 열: 대표 URL(첫 번째) 하나와 나머지 개수. 올리면 전체 URL 을 보인다
function UrlsCell({ urls }: { urls: string[] }) {
  // URL 이 없는 줄(다른 배지와 함께 켜 OR 로 들어온 줄)은 비우지 않고 「—」(스펙 2026-10-27-011 D19 — 못 읽음으로 보이지 않게)
  if (!urls.length) return <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>;
  const rest = urls.length - 1;
  return (
    <Tooltip
      describeChild
      placement="bottom-start"
      slotProps={{ tooltip: { sx: { maxWidth: 560 } } }}
      title={
        <Box component="ul" sx={{ m: 0, pl: 0, listStyle: 'none', fontFamily: monoFont, fontSize: 12, lineHeight: 1.7 }}>
          {urls.map((u) => (
            <li key={u} style={{ overflowWrap: 'anywhere' }}>
              {u}
            </li>
          ))}
        </Box>
      }
    >
      <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, minWidth: 0, maxWidth: '100%' }}>
        <Box
          component="span"
          sx={{ fontFamily: monoFont, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}
        >
          {urls[0]}
        </Box>
        {rest > 0 && (
          <Box
            component="span"
            aria-label={t('skills.grid.moreUrls', { n: rest })}
            sx={{ flexShrink: 0, fontSize: 11, color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}
          >
            +{rest}
          </Box>
        )}
      </Box>
    </Tooltip>
  );
}

const urlsColumn = (): GridColumn<SkillRow> => ({
  id: 'urls',
  label: t('skills.grid.urls'),
  value: (s) => s.urls?.[0],
  width: 'minmax(220px, 2fr)',
  render: (s) => <UrlsCell urls={s.urls ?? []} />,
});
// 외부 URL 탭만 스킬 다음에 URL 열을 둔다
const REST_COLUMNS = (showTags: boolean, showWhere = true): GridColumn<SkillRow>[] => {
  const [name, ...rest] = COLUMNS(showTags, showWhere);
  return [name, urlsColumn(), ...rest];
};

/** 「스킬 연결도와 대화」 칸 안의 요약 한 줄(스펙 2026-10-28-013 디자인 D3·D4·D6·D7·D14·D15).
 *  누를 수 없는 숫자는 글자로, 「스킬 폴더 밖」만 경고 Tag, 「문서에만」은 풍선말로 나온 파일을 보인다.
 *  수는 스킬 연결도 중심 패널 「외부 호스트 N」과 같다(D5) — 연결도로 가는 링크는 위 「스킬 연결도 보기」 하나다. */
function CallSummary({ s }: { s: SkillOne }) {
  const hosts = s.rest.length;
  const scripts = s.scripts.length + s.external_scripts.length;
  const outside = s.external_scripts;
  const doc = s.rest_doc ?? [];
  const parts: ReactNode[] = [];
  if (hosts) parts.push(t('skills.sumHosts', { n: hosts }));
  if (scripts) parts.push(t('skills.sumScripts', { n: scripts }));
  if (outside.length) parts.push(<Tag tone="warn">{t('skills.sumOutside', { n: outside.length })}</Tag>);
  if (doc.length)
    parts.push(
      <Tooltip
        title={
          <Box component="span" sx={{ whiteSpace: 'pre-line' }}>
            {t('skills.sumDocHelp') + '\n' + doc.map((d) => `${d.host} — ${d.files.join(', ')}`).join('\n')}
          </Box>
        }
      >
        <Box
          component="button"
          type="button"
          sx={{ all: 'unset', cursor: 'help', textDecoration: 'underline dotted', textUnderlineOffset: 3, '&:focus-visible': { outline: '2px solid', outlineColor: 'text.secondary' } }}
        >
          {t('skills.sumDocOnly', { n: doc.length })}
        </Box>
      </Tooltip>
    );
  return (
    <>
      <Typography
        variant="body2"
        color="text.secondary"
        component="div"
        data-call-summary
        sx={{ mt: 1, display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 0.75, rowGap: 0.25, fontVariantNumeric: 'tabular-nums' }}
      >
        {parts.length
          ? parts.map((p, i) => (
              <Box component="span" key={i} sx={{ whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                {i > 0 && (
                  <Box component="span" aria-hidden>
                    ·
                  </Box>
                )}
                {p}
              </Box>
            ))
          : t('skills.sumNone')}
      </Typography>
      {outside.slice(0, 5).map((x) => (
        <OutsidePath key={x} path={x} />
      ))}
      {outside.length > 5 && (
        <Typography variant="caption" color="text.secondary" component="p">
          {t('skills.sumOutsideMore', { n: outside.length - 5 })}
        </Typography>
      )}
    </>
  );
}

/** 스킬 폴더 밖 스크립트 한 줄: 경고 Tag + 경로. 넘치면 앞 경로를 줄여 파일 이름을 남긴다(디자인 D15, DESIGN §8 긴 식별자) */
function OutsidePath({ path }: { path: string }) {
  const { enqueueSnackbar } = useSnackbar();
  const cut = path.lastIndexOf('/') + 1;
  const clip = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(path);
      enqueueSnackbar(t('skills.pathCopied'), { variant: 'success' });
    } catch {
      enqueueSnackbar(t('skills.pathCopyFail'), { variant: 'error' });
    }
  };
  return (
    <Stack direction="row" alignItems="center" spacing={0.75} sx={{ mt: 0.5, minWidth: 0 }} data-outside-path>
      <Tag tone="warn">{t('skills.outsideFolder')}</Tag>
      <Tooltip title={path}>
        <Box sx={{ display: 'flex', minWidth: 0, fontFamily: monoFont, fontSize: 12 }}>
          <Box component="span" sx={clip}>
            {path.slice(0, cut)}
          </Box>
          <Box component="span" sx={{ flexShrink: 0 }}>
            {path.slice(cut)}
          </Box>
        </Box>
      </Tooltip>
      <IconButton size="small" aria-label={t('skills.copyPath', { path })} onClick={() => void copy()} sx={{ '@media (pointer: coarse)': { minWidth: 44, minHeight: 44 } }}>
        <ContentCopyOutlinedIcon sx={{ fontSize: 16 }} />
      </IconButton>
    </Stack>
  );
}

function Group<T>({
  title,
  items,
  render,
  empty = t('skills.none'),
}: {
  title: string;
  items: T[];
  render: (i: T) => ReactNode;
  empty?: string;
}) {
  return (
    <Section title={title} count={items.length}>
      {items.length ? (
        <RowList>
          {items.map((i, n) => (
            <li key={n}>{render(i)}</li>
          ))}
        </RowList>
      ) : (
        <Typography color="text.secondary">{empty}</Typography>
      )}
    </Section>
  );
}

interface PublishReq {
  id: string;
  ts: string;
  who: string;
  profile: string;
  path: string;
  name: string;
  version: string;
  status: string;
  message?: string;
}
interface PublishList {
  items: PublishReq[];
  can?: boolean;
}
const PUBLISHABLE = ['local', 'agent', 'bundled_modified', 'market'];
const packageName = (n: string) => n.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);

/** 스킬 서랍의 「마켓에 올리기」: 올리기 요청을 남긴다. 관리자가 마켓 화면의 「올리기 요청」 탭에서 승인하면 SkillHub 에 게시된다. */
function PublishSection({ s }: { s: SkillOne }) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const [name, setName] = useState(packageName(s.name));
  const [version, setVersion] = useState('1.0.0');
  const [busy, setBusy] = useState(false);
  const list = useQuery<PublishList>({ queryKey: ['market', 'publish'], queryFn: () => get<PublishList>('/api/market/publish') });
  const inRoot = s.path.replace(/^profiles\/[^/]+\//, '');
  const mine = (list.data?.items ?? []).filter((r) => r.profile === s.profile && r.path === inRoot);
  if (!list.data?.can || !s.origin || !PUBLISHABLE.includes(s.origin)) return null;
  const send = async () => {
    setBusy(true);
    try {
      const res = await post<{ request?: { auto?: string; auto_namespace?: string; auto_namespace_label?: string; auto_public?: boolean } }>('/api/market/publish', {
        profile: s.profile,
        path: inRoot,
        name: name.trim(),
        version: version.trim(),
      });
      const req = res?.request;
      // 주인 스킬 자동 승인(스펙 2026-10-28-001 D6): 「게시됨 · <네임스페이스>(구성원만 보임 / 외부 공개)」 — 공개 여부는 서버가 정한다(F1)
      // 네임스페이스는 서버가 준 이름(shared·restricted). 옛 서버라 이름이 없으면 slug 를 보인다
      enqueueSnackbar(
        req?.auto === 'pending'
          ? t('skills.publishAuto', { name: name.trim(), ns: req.auto_namespace_label ?? req.auto_namespace ?? '', vis: req.auto_public ? t('skills.visPublic') : t('skills.visMembers') })
          : t('skills.publishRequested', { name: name.trim() }),
        { variant: 'success' }
      );
      await qc.invalidateQueries({ queryKey: ['market', 'publish'] });
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t('skills.publishTitle')}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {t('skills.publishNote')}
      </Typography>
      <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
        <TextField size="small" label={t('skills.publishName')} value={name} onChange={(e) => setName(e.target.value)} slotProps={{ htmlInput: { spellCheck: false } }} />
        <TextField size="small" label={t('skills.publishVersion')} value={version} onChange={(e) => setVersion(e.target.value)} sx={{ width: 110 }} />
        <Button variant="outlined" disabled={busy || !name.trim() || !version.trim()} onClick={() => void send()}>
          {t('skills.publishAsk')}
        </Button>
      </Stack>
      {mine.map((r) => (
        <Typography key={r.id} variant="body2" color="text.secondary">
          {`${r.name}@${r.version} — ${t(`skills.publishStatus.${r.status}` as Parameters<typeof t>[0])}${r.message ? ` (${r.message})` : ''}`}
        </Typography>
      ))}
    </Section>
  );
}

function SkillDetail({ s0 }: { s0: SkillRow }) {
  const admin = useIsAdmin();
  const q = useQuery<SkillOne>({
    queryKey: ['skill', s0.id],
    queryFn: () => get<SkillOne>('/api/skill?id=' + encodeURIComponent(s0.id)),
  });
  const s = q.data;
  // 지우기(스펙 2026-10-29-005): 서랍 머리 「지우기」. 내 스킬을 지우면 서랍을 닫고 주소의 open·pod 를 지운 뒤 목록 검색 칸으로(DD10)
  const list = useQuery<SkillsData>({ queryKey: ['skills'], queryFn: () => get<SkillsData>('/api/skills'), staleTime: 120000 });
  const { closeDrawer } = useUi();
  const [, setParams] = useSearchParams();
  const { enqueueSnackbar } = useSnackbar();
  const hubAsked = useRef(false);
  const [leaving, setLeaving] = useState(false);
  const leave = () =>
    void closeDrawer().then(() => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete('open');
          next.delete('pod');
          return next;
        },
        { replace: true }
      );
      // 서랍이 닫히는 동안 MUI 가 초점을 연 줄로 돌려놓아(OKE T4 에서 body 로 떨어짐), 닫힘이 끝난 뒤에 검색 칸으로 옮긴다
      window.setTimeout(() => document.querySelector<HTMLInputElement>('main input[type="search"]')?.focus(), 400);
    });
  const del = useSkillDelete(list.data?.skills, (_x, kind) => {
    if (kind === 'hub') hubAsked.current = true;                      // 스킬 허브 스킬은 「지우는 중」을 보이며 서랍에 남는다(DD2)
    else leave();
  });
  const row: SkillRow = list.data?.skills.find((r) => r.id === s0.id) ?? s0;
  const gone = !!list.data && !list.data.skills.some((r) => r.id === s0.id);
  useEffect(() => {
    // 지우기를 요청한 스킬 허브 스킬이 실제로 없어지면 「찾을 수 없음」 대신 서랍을 닫고 알린다(OKE T4)
    if (!hubAsked.current || !gone) return;
    hubAsked.current = false;
    setLeaving(true);
    enqueueSnackbar(t('skills.del.done', { name: s0.name }), { variant: 'success' });
    leave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gone]);
  const mode = del.modeOf(row);
  const pend = del.pendingOf(row);
  if (leaving) return null;
  if (gone && !hubAsked.current) return <Alert severity="warning">{t('skills.notFound', { id: s0.id })}</Alert>;
  if (!s)
    return q.error ? (
      <Alert severity="error">{q.error.message}</Alert>
    ) : (
      <Typography color="text.secondary">{t('skills.loading')}</Typography>
    );
  const talkTo = s.profile === 'default' ? s.cron[0]?.profile ?? 'default' : s.profile;
  // 「쓰려면 필요한 것」 아래에 붙이는 사실 칩: 모델 답과 섞지 않고 서버가 읽은 값을 그대로 보인다(스펙 2026-10-17-002 §4)
  const env = s.required_env ?? [];
  const facts =
    env.length || s.mcp.length || s.rest.length ? (
      <>
        {env.map((e) => (
          <Tag key={e.name} tone={e.set ? 'good' : e.optional ? undefined : 'warn'}>
            {`${e.name} · ${e.set ? t('skills.envSet') : e.optional ? t('skills.envOptional') : t('skills.envNeeded')}`}
          </Tag>
        ))}
        {s.mcp.map((m) => (
          <Tag key={'mcp:' + m.server}>{`MCP ${m.server}`}</Tag>
        ))}
        {s.rest.map((r) => (
          <Tag key={'host:' + r.host}>{r.host}</Tag>
        ))}
      </>
    ) : undefined;
  return (
    <>
      {mode.kind !== 'none' && (
        <DrawerActions
          actions={[{ id: 'delete', label: t('skills.del.label', { name: s0.name }), icon: DeleteOutlineIcon, danger: true, disabled: mode.disabled, onClick: () => del.open(row) }]}
        />
      )}
      {del.dialog}
      {pend && (
        <Box sx={{ mb: 1, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <Pill tone="warn" flush>
            {t('skills.del.pending')}
          </Pill>
          {pend.stale && (
            <>
              <Typography variant="caption" color="text.secondary">
                {t('skills.del.stale')}
              </Typography>
              <LinkChip to="market" params={{ tab: 'log' }}>
                {t('skills.del.requestLog')}
              </LinkChip>
            </>
          )}
        </Box>
      )}
      {s.description && <Typography>{s.description}</Typography>}
      <DescTranslation
        src={s.description_src}
        by={s.description_by}
        onRetranslate={admin ? () => post('/api/skill/retranslate', { id: s0.id }) : undefined}
      />
      <Section title={t('market.summary.title')}>
        <AiSummary target={{ id: s0.id }} facts={facts} />
      </Section>
      <KV
        pairs={[
          [t('skills.location'), profileName(s.profile)],
          ...(s.shared_from ? ([[t('skills.sharedFromLabel'), s.shared_from === 'default' ? t('skills.shared') : s.shared_from]] as [string, string][]) : []),
          [t('skills.path'), <code key="p">{s.path}</code>],
          ...(s.origin ? ([[t('skills.origin'), originLabel(s.origin)]] as [string, string][]) : []),
          ...((q.data?.tags ?? s0.tags ?? []).length ? ([[t('market.tags'), (q.data?.tags ?? s0.tags ?? []).map(tagLabel).join(', ')]] as [string, string][]) : []),
          [t('skills.modified'), (s.modified ?? '').slice(0, 10)],
          [t('skills.files'), t('skills.fileCount', { count: s.files })],
        ]}
      />
      {s.origin === 'aas' ? (
        // AAS 기본 스킬은 이미지 안(/opt/aas-skills)이라 내려받기·고치기가 없다(스펙 2026-10-27-007 §4-4)
        <Alert severity="info" sx={{ mb: 1 }}>
          {t('skills.originNoteAas')}
        </Alert>
      ) : s.shared_from ? (
        <Alert severity="info" sx={{ mb: 1 }}>
          {t('skills.sharedNote', { name: s.shared_from === 'default' ? t('skills.shared') : s.shared_from })}
        </Alert>
      ) : (
        <DownloadSkill s={s} />
      )}
      {s.origin === 'bundled_modified' && (
        <Alert severity="info" sx={{ mb: 1 }}>
          {t('skills.originNoteModified')}
        </Alert>
      )}
      {s0.new_version && (
        <Box sx={{ mb: 1 }}>
          <Pill tone="warn" flush>
            {t('market.newVersionV', { v: s0.new_version })}
          </Pill>{' '}
          <LinkChip to="market" params={{ tab: 'updates', scope: 'pod', q: s0.profile }}>
            {t('market.upd.openInHub')}
          </LinkChip>
        </Box>
      )}
      {!s.shared_from && <PublishSection s={s} />}
      {!!s.required_env?.length && (
        <Section title={t('skills.envTitle')} count={s.required_env.length}>
          <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 1 }}>
            {t('skills.envNote')}
          </Typography>
          <RowList>
            {s.required_env.map((e) => (
              <Box key={e.name} sx={{ py: 0.5 }}>
                <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
                  <Mono>{e.name}</Mono>
                  <Tag tone={e.set ? 'good' : e.optional ? undefined : 'warn'}>
                    {e.set ? t('skills.envSet') : e.optional ? t('skills.envOptional') : t('skills.envNeeded')}
                  </Tag>
                  {!e.set && (
                    <LinkChip to="profiles" params={{ name: s.profile, pane: 'env', key: e.name }} page>
                      {t('skills.envFill')}
                    </LinkChip>
                  )}
                </Stack>
                {(e.prompt || e.required_for || e.help) && (
                  <Typography variant="caption" color="text.secondary" component="p">
                    {[e.prompt, e.required_for && t('skills.envFor', { what: e.required_for }), e.help].filter(Boolean).join(' · ')}
                  </Typography>
                )}
              </Box>
            ))}
          </RowList>
          <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
            {t('skills.chatLoginNote')}
          </Typography>
        </Section>
      )}
      <Section title={t('skills.flowAndChat')}>
        <LinkChip to="flows" params={{ root: 'skill:' + s0.id }} page={{ kind: 'skillMap', root: 'skill:' + s0.id }}>
          {t('skills.viewFlow')}
        </LinkChip>
        <ChatChip {...chat(talkTo, t('skills.explainPrompt', { name: s.name, path: s.path }))}>
          {t('skills.explainAction')}
        </ChatChip>
        <ChatChip {...chat(talkTo, t('skills.editPrompt', { name: s.name, path: s.path }))}>
          {t('skills.editAction')}
        </ChatChip>
        <CallSummary s={s} />
      </Section>
      {/* 0 인 칸은 그리지 않는다(스펙 2026-10-28-013 Q2·디자인 D8). 외부 호스트·스크립트는 위 요약 줄로 옮겼다(D3) */}
      {s.cron.length > 0 && (
        <Group
          title={t('skills.cronJobs')}
          items={s.cron}
          empty={t('skills.cronNone')}
          render={(c) => (
            <>
              <LinkChip to="cron" params={{ tab: 'profiles', q: c.profile }}>{`${c.profile}/${c.job}`}</LinkChip>{' '}
              <Tag tone={!c.enabled ? undefined : c.last_status === 'ok' ? 'good' : c.last_status ? 'bad' : undefined}>
                {!c.enabled ? t('skills.off') : c.last_status || t('skills.notRun')}
              </Tag>
            </>
          )}
        />
      )}
      {s.mcp.length > 0 && (
        <Group
          title={t('skills.mcpServers')}
          items={s.mcp}
          render={(m) => (
            <>
              <LinkChip to="credentials" params={{ tab: 'all', q: m.server }}>
                {m.server}
              </LinkChip>
              <LinkChip to="skills" params={{ tab: 'all', profile: linkScope(s.profile), lens: 'mcp:' + m.server }}>
                {t('skills.sameMcp')}
              </LinkChip>
              <Mono block>{m.tools.length ? m.tools.join(', ') : m.evidence}</Mono>
            </>
          )}
        />
      )}
      {s.skills.length > 0 && (
        <Group
          title={t('skills.otherSkills')}
          items={s.skills}
          render={(x) => (
            <LinkChip to="skills" params={{ tab: 'all', profile: linkScope(s.profile), q: x }}>
              {x}
            </LinkChip>
          )}
        />
      )}
      <Typography variant="caption" color="text.secondary" component="p" className="aas-footnote">
        {t('skills.staticNote')}
      </Typography>
    </>
  );
}

interface UploadInfo {
  hash: string;
  name: string;
  name_valid: boolean;
  description: string;
  files: ZipFile[];
  scripts: ZipScript[];
  only_skill_md: boolean;
  conflict: boolean;
}
/**
 * 「새 스킬」의 「zip 올리기」 탭(OMAI-1195, 스펙 §3-6). 파일을 고르면 바로 서버로 보내 검사하고 미리 보기를 보인다(DR13).
 * 검사는 임시 보관만 한다. 사용자가 「올리고 적용」을 눌러야 해시로 적용된다. 스크립트는 미리 보기 안의 확인 체크로 받는다(DR11).
 */
function ZipUpload({ profile }: { profile: string }) {
  const { enqueueSnackbar } = useSnackbar();
  const { closeDrawer } = useUi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pickRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [info, setInfo] = useState<UploadInfo | null>(null);
  const [name, setName] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [phase, setPhase] = useState<'' | 'checking' | 'applying'>('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(false);
  const [nameError, setNameError] = useState('');

  useEffect(() => {
    if (info) previewRef.current?.focus(); // 단계가 바뀌면 포커스를 미리 보기로 옮긴다(DR14)
  }, [info]);

  const inspect = async (f: File) => {
    setPhase('checking');
    setError('');
    setRetry(false);
    setNameError('');
    try {
      const r = await sendZip<UploadInfo>(`/api/skill/upload?profile=${encodeURIComponent(profile)}`, f);
      setInfo(r);
      setName(r.name);
      setConfirmed(false);
    } catch (e) {
      setInfo(null);
      setError((e as Error).message);
    } finally {
      setPhase('');
    }
  };
  const pick = (f: File | undefined) => {
    if (!f) return;
    setInfo(null);
    setError('');
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
    setInfo(null);
    setError('');
    setNameError('');
  };
  const needsName = !!info && (info.conflict || !info.name_valid);
  const apply = async () => {
    if (!info) return;
    setPhase('applying');
    setError('');
    setRetry(false);
    setNameError('');
    try {
      const r = await post<{ name: string; profile: string; state: string }>('/api/skill/apply', {
        hash: info.hash,
        profile,
        name: name.trim(),
        confirm_scripts: confirmed,
      });
      await Promise.all([qc.invalidateQueries({ queryKey: ['skills'] }), qc.invalidateQueries({ queryKey: ['flows'] })]);
      closeDrawer();
      enqueueSnackbar(r.state === 'done' ? t('skills.zipDone') : t('skills.zipPending'), {
        variant: 'success',
        action: () => (
          <Button color="inherit" size="small" onClick={() => navigate(`/skills?${new URLSearchParams({ tab: 'all', profile: r.profile, open: r.name })}`)}>
            {t('skills.zipOpen')}
          </Button>
        ),
      });
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 409) setNameError(t('skills.zipConflict'));
      else {
        setError(err.message);
        setRetry(true); // 만료·적용 실패: 미리 보기를 유지한 채 같은 파일을 다시 올려 새 해시를 받는다(DR9)
      }
    } finally {
      setPhase('');
    }
  };
  const busy = phase !== '';
  const canApply = !!info && !busy && !!name.trim() && (!info.scripts.length || confirmed);
  return (
    <Stack spacing={1.5}>
      <Box role="status" aria-live="polite" sx={visuallyHidden}>
        {phase === 'checking' ? t('skills.zipChecking') : phase === 'applying' ? t('skills.zipUploading') : ''}
      </Box>
      <Box data-guide="skills.zip">
        <ZipDropZone show={!info} busy={busy} onPick={pick} pickRef={pickRef} sub={t('skills.zipDropSub')} />
      </Box>
      {file && <ZipFileChip file={file} checking={phase === 'checking'} busy={busy} onReplace={() => pickRef.current?.click()} onRemove={clear} />}
      {error && (
        <Alert severity="error" action={retry && file ? <Button startIcon={<RefreshIcon />} color="inherit" size="small" onClick={() => void inspect(file)}>{t('skills.zipRetry')}</Button> : undefined}>
          {error}
        </Alert>
      )}
      {info && (
        <Stack spacing={1.5} ref={previewRef} tabIndex={-1} sx={{ outline: 'none' }}>
          {needsName ? (
            <TextField
              size="small"
              label={t('skills.zipName')}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameError('');
              }}
              error={!!nameError || info.conflict || !info.name_valid}
              helperText={nameError || (info.conflict ? t('skills.zipConflict') : t('skills.zipNameInvalid'))}
              slotProps={{ htmlInput: { spellCheck: false } }}
            />
          ) : (
            <Typography variant="subtitle2">{info.name}</Typography>
          )}
          {info.description && <Typography variant="body2">{info.description}</Typography>}
          <ScriptReview scripts={info.scripts} confirmed={confirmed} onConfirm={setConfirmed} />
          <ZipFileList key={info.hash} files={info.files} scripts={info.scripts} />
          <Box component="details" sx={{ fontSize: 12, color: 'text.secondary' }}>
            <summary>{t('skills.zipHash')}</summary>
            <Mono>{info.hash}</Mono>
          </Box>
          <Box>
            <Button variant="outlined" color="inherit" sx={tier1} disabled={!canApply} onClick={() => void apply()}>
              {phase === 'applying' ? t('skills.zipUploading') : t('skills.zipApply')}
            </Button>
          </Box>
        </Stack>
      )}
    </Stack>
  );
}

/** 새 스킬 서랍. onCreated 가 있으면 만든 뒤 스킬 화면으로 가지 않고 그것을 부른다(프로파일 서랍의 스킬 탭에서 열 때, 2026-10-17-017) */
export function CreateSkill({
  profiles,
  initialProfile,
  canUpload,
  initialTab = 'write',
  onCreated,
}: {
  profiles: string[];
  initialProfile: string;
  canUpload: boolean;
  /** 처음 열 탭. 빈 화면 「zip 올리기」는 zip 탭으로 연다 */
  initialTab?: 'write' | 'zip';
  onCreated?: (name: string) => void;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const { closeDrawer } = useUi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [profile, setProfile] = useState(initialProfile);
  const [tab, setTab] = useState<'write' | 'zip'>(canUpload ? initialTab : 'write');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState(bodyTemplate);
  // 머리말에 넣는 추가 정보(2026-10-28-004 §9). 버전·만든 사람은 서버가 붙인다
  const [showMeta, setShowMeta] = useState(true); // 처음부터 펼쳐 둔다(사용자 요청 2026-10-28)
  const [related, setRelated] = useState<string[]>([]);
  const [envText, setEnvText] = useState('');
  const [tagsText, setTagsText] = useState('');
  const skillsQ = useQuery<SkillsData>({ queryKey: ['skills'], queryFn: () => get<SkillsData>('/api/skills'), staleTime: 120000 });
  // 관련 스킬은 고른 프로파일에서 보이는 스킬(그 프로파일 + 공용)에서 고른다. 서버도 같은 범위로 검사한다
  const relatedOptions = [
    ...new Set((skillsQ.data?.skills ?? []).filter((s) => s.profile === profile || s.profile === 'default').map((s) => s.name)),
  ]
    .filter((n) => n !== name.trim())
    .sort();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const rename = (v: string) => {
    setName(v);
    setBody((b) => b.replace(/^# .*\n/, `# ${v.trim() || t('skills.nameDefault')}\n`)); // 이름을 따라 본문 제목이 바뀐다
  };
  const create = async () => {
    // 틀의 안내 주석·빈 절을 지워 보내고, 채운 것이 없으면 보내지 않는다(2026-10-28-004)
    const clean = cleanSkillBody(body, bodyTemplate());
    if (clean.empty) {
      setError(t('skills.bodyEmpty'));
      return;
    }
    setBusy(true);
    try {
      const r = await post<{ name: string }>('/api/skill/create', {
        name: name.trim(),
        profile,
        category: category.trim(),
        description,
        body: clean.body,
        env: commaList(envText),
        tags: commaList(tagsText),
        related,
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['skills'] }),
        qc.invalidateQueries({ queryKey: ['flows'] }),
      ]);
      closeDrawer();
      enqueueSnackbar(t('skills.created', { name: r.name }), { variant: 'success' });
      if (onCreated) onCreated(r.name);
      else navigate(`/skills?${new URLSearchParams({ tab: 'mine', profile, q: r.name })}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Stack spacing={1.5}>
      <NativeSelect
        value={profile}
        onChange={(e) => setProfile(e.target.value)}
        inputProps={{ 'aria-label': t('skills.whoUses') }}
      >
        {profiles.map((p) => (
          <option key={p} value={p}>
            {p === 'default' ? t('skills.sharedAll') : t('skills.onlyFor', { name: p })}
          </option>
        ))}
      </NativeSelect>
      {canUpload && (
        <Tabs
          value={tab}
          onChange={(_, v: 'write' | 'zip') => setTab(v)}
          sx={{ '& .MuiTabs-indicator': { bgcolor: 'text.primary' }, '& .MuiTab-root': { textTransform: 'none' } }}
        >
          <Tab value="write" label={t('skills.tabWrite')} />
          <Tab value="zip" label={t('skills.tabZip')} />
        </Tabs>
      )}
      {/* 탭을 바꿔도 쓰던 입력이 남도록 숨기기만 한다(DR16) */}
      <Stack spacing={1.5} hidden={tab !== 'write'} sx={{ display: tab === 'write' ? undefined : 'none' }}>
        <TextField
          size="small"
          label={t('skills.nameLabel')}
          data-guide="skills.name"
          value={name}
          onChange={(e) => rename(e.target.value)}
          placeholder={t('skills.namePlaceholder')}
          slotProps={{ htmlInput: { spellCheck: false } }}
        />
        <TextField
          size="small"
          label={t('skills.category')}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder={t('skills.categoryPlaceholder')}
          slotProps={{ htmlInput: { spellCheck: false } }}
        />
        <TextField
          size="small"
          label={t('skills.description')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('skills.descriptionPlaceholder')}
          // Hermes 는 스킬 목록에 설명 앞 60자만 싣는다(SKILL_PROMPT_DESC_LIMIT). 넘어도 막지 않고 글자 수를 보인다
          helperText={description.length > 60 ? t('skills.descriptionOver', { n: description.length }) : t('skills.descriptionHelp')}
          slotProps={{ htmlInput: { maxLength: 300 } }}
        />
        <DisclosureButton
          open={showMeta}
          onToggle={() => setShowMeta((v) => !v)}
          label={t('skills.moreMeta')}
          controls="new-skill-meta"
          sx={{ alignSelf: 'flex-start' }}
        />
        {showMeta && (
          <Stack id="new-skill-meta" spacing={1.5}>
            <Autocomplete
              multiple
              size="small"
              filterSelectedOptions
              options={relatedOptions}
              value={related}
              onChange={(_, v) => setRelated(v)}
              noOptionsText={t('skills.relatedNone')}
              renderInput={(params) => (
                <TextField {...params} label={t('skills.relatedLabel')} helperText={t('skills.relatedHelp')} />
              )}
            />
            <TextField
              size="small"
              label={t('skills.envLabel')}
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder={t('skills.envPlaceholder')}
              helperText={t('skills.envHelp')}
              slotProps={{ htmlInput: { spellCheck: false } }}
            />
            <TextField
              size="small"
              label={t('skills.tagsLabel')}
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder={t('skills.tagsPlaceholder')}
              helperText={t('skills.tagsHelp')}
            />
            <Typography variant="caption" color="text.secondary">
              {t('skills.metaAuto')}
            </Typography>
          </Stack>
        )}
        <Typography variant="caption" color="text.secondary">
          {t('skills.bodyLabel')}
        </Typography>
        <MarkdownField value={body} onChange={setBody} label={t('skills.bodyField')} monaco />
        {error && <Alert severity="error">{error}</Alert>}
        <Box>
          <Button startIcon={<AddIcon />} variant="contained" disabled={busy} onClick={create}>
            {t('skills.create')}
          </Button>
        </Box>
        <Typography variant="caption" color="text.secondary">
          {t('skills.createNote')}
        </Typography>
      </Stack>
      {canUpload && (
        <Box hidden={tab !== 'zip'} sx={{ display: tab === 'zip' ? undefined : 'none' }}>
          <ZipUpload profile={profile} />
        </Box>
      )}
    </Stack>
  );
}

/** 스킬 서랍(스펙 2026-10-26-003 §5-8). 목록 행 클릭·주소 ?open= 도 이 페이지로 연다(스펙 2026-10-28-014 D8).
 *  목록 행을 /api/skills 에서 id 또는 이름으로 찾는다. 이름이 여럿이면 prefer 프로파일 → 주 프로파일 → 첫 줄(엔지니어링 D2) */
export function SkillPage({ page }: { page: PageOf<'skill'> }) {
  const q = useQuery<SkillsData>({ queryKey: ['skills'], queryFn: () => get<SkillsData>('/api/skills'), staleTime: 120000 });
  const found = q.data ? findOpen(q.data.skills, page.id, page.prefer ?? q.data.primary) : undefined;
  // 한 번 찾은 줄은 목록에서 사라져도 SkillDetail 에 넘긴다. 여기서 바로 「찾을 수 없음」으로 바꾸면 SkillDetail 이 내려가
  // 스킬 허브 지우기 뒤 서랍을 닫는 효과가 렌더 순서에 따라 돌지 않는다(OKE T4 재확인, 스펙 2026-10-29-005 §7-5)
  const last = useRef<SkillRow | undefined>(undefined);
  if (found) last.current = found;
  const s = found ?? (q.data && last.current && (last.current.id === page.id || last.current.name === page.id) ? last.current : undefined);
  useDrawerHead(s ? { title: s.name, sub: t('skills.drawerSub', { where: where(s) }) } : null);
  if (!s) return q.data ? <Alert severity="warning">{t('skills.notFound', { id: page.id })}</Alert> : <ScreenLoading title={page.id} error={q.error?.message} />;
  return <SkillDetail s0={s} />;
}

// 프로파일 고르기(스펙 2026-10-27-013) — 선택 상자·처음 값·저장은 공용 부품(ProfileScopeSelect, 스펙 2026-10-28-006 D1)
const ALL = ALL_PROFILES;
/** 선택 목록: 스킬 줄에 나온 프로파일 ∪ 새 스킬 대상(profiles 는 루트를 숨긴 POD 에서 default 가 빠진다). 주 프로파일 → 이름순 → 공용(디자인 D5·9A) */
const profileChoices = (g: SkillsData) =>
  [...new Set([...g.skills.map((s) => s.profile), ...(g.profiles ?? [])])].sort(
    (a, b) => Number(a === 'default') - Number(b === 'default') || Number(b === g.primary) - Number(a === g.primary) || a.localeCompare(b)
  );
const choiceLabel = (p: string, primary?: string) =>
  p === ALL ? t('skills.profileAll') : p === 'default' ? t('skills.shared') : p === primary ? t('skills.profilePrimary', { name: p }) : p;
/** 프로파일 P 를 고르면 P 의 줄과, P 에 같은 이름이 없는 공용 줄 — 에이전트는 자기 것을 먼저 쓰고 없을 때만 공용을 쓴다(skill_graph.py by_key, 엔지니어링 D6·디자인 13A) */
const scopeRows = (skills: SkillRow[], p: string) => {
  if (p === ALL) return skills;
  if (p === 'default') return skills.filter((s) => s.profile === 'default');
  const own = skills.filter((s) => s.profile === p);
  const names = new Set(own.map((s) => s.name));
  return [...own, ...skills.filter((s) => s.profile === 'default' && !names.has(s.name))];
};
/** 주소의 open(id 또는 이름)으로 찾은 줄. 이름이 여럿이면 prefer 프로파일 → 첫 줄(엔지니어링 D2) */
const findOpen = (skills: SkillRow[], open: string, prefer?: string) => {
  const hits = skills.filter((x) => x.id === open || x.name === open);
  return hits.find((x) => x.profile === prefer) ?? hits[0];
};
/** 서랍에서 스킬 화면으로 가는 링크의 범위. 공용 스킬은 모든 프로파일이 쓰므로 전체 프로파일(§4-5) */
const linkScope = (p: string) => (p === 'default' ? ALL : p);
const skillText = (s: SkillRow) => [s.name, s.description, s.description_src, s.profile, (s.tags ?? []).map(tagLabel).join(' ')].join(' ');
// 무엇을 부르는지는 거르기 배지(011 R3, D18). 고른 보기 안에서 거르고 여럿이면 OR
const TOGGLES = () => [
  { id: 'cron', label: t('skills.chipCron'), match: (s: SkillRow) => s.n_cron > 0 },
  { id: 'mcp', label: t('skills.chipMcp'), match: (s: SkillRow) => s.n_mcp > 0 },
  { id: 'rest', label: t('skills.chipRest'), match: (s: SkillRow) => s.n_rest > 0 },
];
/** 주소 ?new=write|zip 이면 「새 스킬」 서랍을 연다(가이드 따라하기가 서랍을 열어 준다). 값이 바뀔 때마다 한 번만 열고, 값이 없어지면 다시 열 수 있다 */
function NewFromParam({ value, canUpload, open }: { value: string | null; canUpload: boolean; open: (tab: 'write' | 'zip') => void }) {
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (value !== 'write' && value !== 'zip') {
      done.current = null;
      return;
    }
    if (done.current === value) return;
    done.current = value;
    open(value === 'zip' && canUpload ? 'zip' : 'write');
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/** 표 보기로 여는 주소 값. 옛 북마크·다른 화면의 링크(호출 대상·태그·보기·서랍)는 지금처럼 표로 연다 */
const TABLE_PARAMS = ['view', 'lens', 'tab', 'chip', 'tag', 'open', 'new'];

/**
 * 스킬 화면. 기본은 에이전트 중심 3칸(AI 에이전트 | 그 에이전트의 스킬 | 동작·필요한 것·파일·게시)이고,
 * 「전체 표」(?view=table 또는 위의 주소 값)는 POD 전체 스킬 표다. 상태 값이 없는 옛 서버면 표로 연다.
 */
export function Skills() {
  const [params, setParams] = useSearchParams();
  const { openDrawer } = useUi();
  const q = useQuery<SkillsData>({ queryKey: ['skills'], queryFn: () => get<SkillsData>('/api/skills'), staleTime: 120000 });
  useMe(); // 표 보기가 붙기 전에 권한 정보를 함께 받아 둔다(관리자 단추가 늦게 뜨지 않게)
  const table = TABLE_PARAMS.some((k) => params.has(k)) || params.get('profile') === ALL_PROFILES;
  if (table) return <SkillsTable />;
  if (!q.data) return <ScreenLoading title={t('skills.title')} error={q.error?.message} />;
  const g = q.data;
  if (!g.agents?.length) return <SkillsTable />;
  const onTable = () =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      ['skill', 'pane', 'f'].forEach((k) => next.delete(k));
      next.set('view', 'table');
      next.set('profile', ALL_PROFILES);
      return next;
    });
  const profiles = g.profiles ?? agentOrder(g);
  const onNew = (profile: string) =>
    openDrawer({
      title: t('skills.newSkill'),
      sub: t('skills.newSkillSub'),
      body: <CreateSkill profiles={profiles} initialProfile={profiles.includes(profile) ? profile : (profiles[0] ?? 'default')} canUpload={!!g.can_upload} initialTab="write" />,
    });
  return <AgentSkills g={g} onTable={onTable} onNew={onNew} />;
}

/** 에이전트 중심 보기로 돌아가는 단추(표 보기의 도구 줄) */
function AgentViewButton() {
  const [params, setParams] = useSearchParams();
  const back = () =>
    setParams((prev) => {
      const next = new URLSearchParams();
      const p = prev.get('profile');
      if (p && p !== ALL_PROFILES) next.set('profile', p);
      return next;
    });
  return (
    <Button size="small" onClick={back} data-agent-view={params.get('profile') ?? ''}>
      {t('skillsAgent.byAgent')}
    </Button>
  );
}

function SkillsTable() {
  const [params, setParams] = useSearchParams();
  const { openDrawer } = useUi();
  const { enqueueSnackbar } = useSnackbar();
  const admin = useIsAdmin();
  const meQ = useMe();
  const me = meQ.data;
  const q = useQuery<SkillsData>({
    queryKey: ['skills'],
    queryFn: () => get<SkillsData>('/api/skills'),
    staleTime: 120000,
  });
  const g = q.data;
  // 행 서랍은 주소 ?open=(+pod)과 묶인다(스펙 2026-10-28-014 D8). 연 뒤에도 open 을 지우지 않는다(의도한 변경, §7)
  const route = useRoutePage('skills');
  const open = params.get('open');
  const choices = g ? profileChoices(g) : [];
  // 공용을 뺀 프로파일이 하나뿐이면 선택을 그리지 않고 지금 화면 그대로 전부 보인다(R5). 주소에 맞는 값이 있으면 그 값
  const multi = choices.filter((p) => p !== 'default').length > 1;
  // 처음 값(R3·D8·디자인 8A): 주소 → open 으로 찾은 줄 → 이 POD 의 마지막 고른 값 → 주 프로파일 → 첫 값
  const { scope, pick: pickScope, picked, pickerRef } = useProfileScope({
    ready: !!g,
    choices,
    multi,
    primary: g?.primary,
    storageKey: 'aas.skillsProfile',
    labelOf: (p) => choiceLabel(p, g?.primary),
    initial: () => (g && open ? findOpen(g.skills, open, g.primary)?.profile : undefined),
    // 보기·검색어·배지·태그는 그대로(디자인 6A), 호출 대상·열린 서랍은 다른 프로파일에 없을 수 있어 지운다(OV4). 표는 key 로 첫 페이지부터(D7)
    // 열린 서랍은 주소 값이 사라지면 공용 훅이 닫는다(저장 확인 적용)
    onPick: (n) => {
      n.delete('lens');
      n.delete('open');
      n.delete('pod');
    },
  });

  // 옛 주소 ?tab=cron|mcp|rest(보기 카드였던 때)는 전체 보기 + 같은 거르기 배지로 연다(스펙 2026-10-27-011 R5). 북마크를 살린다
  const legacyTab = params.get('tab');
  useEffect(() => {
    if (legacyTab !== 'cron' && legacyTab !== 'mcp' && legacyTab !== 'rest') return;
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set('tab', 'all');
        p.set('chip', legacyTab);
        return p;
      },
      { replace: true }
    );
  }, [legacyTab, setParams]);

  if (!g || !scope) return <ScreenLoading title={t('skills.title')} error={q.error?.message} />;

  const rows = scopeRows(g.skills, scope);
  const pick = (p: string) => pickScope(p);

  const lens = params.get('lens') ?? '';
  const [lk, lv] = lens ? [lens.slice(0, lens.indexOf(':')), lens.slice(lens.indexOf(':') + 1)] : ['', ''];
  const ids = lens ? new Set((lk === 'mcp' ? g.by_mcp[lv] : g.by_host[lv]) ?? []) : null;
  // 태그 거르기(OMAI-1283): 주소 ?tag=a,b 가 정본이다. 칩 목록·순서와 켠 태그의 유효성은 전체 스킬 기준이고,
  // 칩에 보이는 수는 지금 프로파일·보기 기준이다(스펙 2026-10-27-011 D6, 2026-10-27-013 엔지니어링 D4 — 프로파일을 바꿔도 칩 자리가 같다)
  const tagCount = tagCounts(g.skills);
  const activeTags = (params.get('tag') ?? '').split(',').filter((id) => tagCount.some((c) => c.id === id));
  const setTags = (next: string[]) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (next.length) p.set('tag', next.join(','));
        else p.delete('tag');
        return p;
      },
      { replace: true }
    );
  const refreshTags = async () => {
    try {
      await post('/api/market/tags/refresh', {});
      enqueueSnackbar(t('market.tagsRefreshing'), { variant: 'info' });
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    }
  };
  // 보기(스펙 2026-10-27-011 R1·R2): 내 스킬 = 기본 제공(Hermes 기본·AAS 기본)이 아닌 것 전부, 첫 보기는 내 스킬. 모두 고른 프로파일 범위 안에서(013 R2)
  const mineAll = rows.filter((s) => isMySkill(s.origin));
  const builtinAll = rows.filter((s) => !isMySkill(s.origin));
  const narrow = (list: SkillRow[]) => list.filter((s) => (!ids || ids.has(s.id)) && tagMatches(s, activeTags));
  const tabId = params.get('tab') === 'builtin' || params.get('tab') === 'all' ? (params.get('tab') as string) : 'mine';
  const viewAll = tabId === 'builtin' ? builtinAll : tabId === 'all' ? rows : mineAll;
  const viewTags = Object.fromEntries(tagCounts(viewAll).map((c) => [c.id, c.n]));
  const above = (
    <TagBar
      counts={tagCount}
      total={viewAll.length}
      view={tabId === 'all' && scope === ALL ? undefined : viewTags}
      active={activeTags}
      onToggle={(id) => setTags(activeTags.includes(id) ? activeTags.filter((x) => x !== id) : [...activeTags, id])}
      onClear={() => setTags([])}
      action={
        admin ? (
          <Button startIcon={<RefreshIcon />} size="small" variant="outlined" color="inherit" sx={tier2 as object} onClick={() => void refreshTags()}>
            {t('market.tagsRefresh')}
          </Button>
        ) : undefined
      }
    />
  );
  const setLens = (v: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (v) next.set('lens', v);
        else next.delete('lens');
        return next;
      },
      { replace: true }
    );
  const lensText = t('skills.lensOnly', { kind: lk === 'mcp' ? 'MCP' : t('skills.host'), name: '\u0001' }).split('\u0001');
  // 호출 대상 목록은 고른 범위로 다시 세고 0 을 뺀 뒤 많은 순으로 자른다(엔지니어링 OV9). 지금 고른 값은 0 이어도 남긴다
  const rowIds = new Set(rows.map((s) => s.id));
  const recount = (m: Record<string, string[]>, kind: string) =>
    Object.entries(m)
      .map(([k, v]) => [k, v.filter((id) => rowIds.has(id)).length] as const)
      .filter(([k, n]) => n > 0 || lens === `${kind}:${k}`)
      .sort((a, b) => b[1] - a[1]);
  const filterProfile = scope === ALL ? null : scope;
  // 「전체 프로파일」이면 새 스킬·대화는 지금 규칙(R6, 엔지니어링 Q1) — * 를 프로파일 이름으로 넘기지 않는다
  const talk = filterProfile && filterProfile !== 'default' ? filterProfile : 'default';
  const profiles =
    g.profiles ??
    [...new Set(g.skills.map((s) => s.profile).concat('default'))].sort(
      (a, b) => Number(a !== 'default') - Number(b !== 'default') || a.localeCompare(b)
    );
  // 새 스킬의 처음 위치: 고른 프로파일 → 공용(있으면) → 주 에이전트 → 첫 값
  const startProfile =
    filterProfile && profiles.includes(filterProfile)
      ? filterProfile
      : profiles.includes('default')
        ? 'default'
        : g.primary && profiles.includes(g.primary)
          ? g.primary
          : (profiles[0] ?? 'default');

  const openNew = (tab: 'write' | 'zip') =>
    openDrawer({
      title: t('skills.newSkill'),
      sub: t('skills.newSkillSub'),
      body: <CreateSkill profiles={profiles} initialProfile={startProfile} canUpload={!!g.can_upload} initialTab={tab} />,
    });
  const add: AddAction = { label: t('skills.newSkill'), onClick: () => openNew('write') };
  // 거르기(태그·호출 대상)는 ListView 밖에서 하므로, 그것 때문에 0 줄이면 「항목이 없습니다」 대신 거르기를 지우라고 알린다(011 D7)
  const filteredEmpty = lens || activeTags.length ? t('skills.filteredEmpty') : undefined;
  // 고른 프로파일에서 0 줄인데 다른 프로파일에는 같은 보기·검색어·배지·거르기로 맞는 줄이 있으면 그 수와 「전체 프로파일에서 보기」(디자인 5A)
  const needle = (params.get('q') ?? '').trim().toLowerCase();
  const chips = (params.get('chip') ?? '').split(',');
  const onChips = TOGGLES().filter((c) => chips.includes(c.id));
  const matches = (s: SkillRow) =>
    (!onChips.length || onChips.some((c) => c.match(s))) && (!needle || skillText(s).toLowerCase().includes(needle));
  const elsewhere = (inTab: (s: SkillRow) => boolean) =>
    scope === ALL ? 0 : narrow(g.skills.filter((s) => !rowIds.has(s.id) && inTab(s))).filter(matches).length;
  const otherHint = (n: number) =>
    n > 0 ? (
      <>
        {t('skills.otherProfiles', { name: choiceLabel(scope, g.primary), n })}
        <Button size="small" color="inherit" onClick={() => pick(ALL)} sx={{ color: 'text.secondary' }}>
          {t('skills.otherProfilesShow')}
        </Button>
      </>
    ) : undefined;
  const emptyFor = (inTab: (s: SkillRow) => boolean) => {
    const hint = otherHint(elsewhere(inTab));
    return { empty: hint ?? filteredEmpty, noMatch: hint };
  };
  // 기본 제공 카드 둘째 줄: 같은 기본 스킬이 프로파일마다 한 줄씩이라 줄 수가 부풀어 보인다(011 D4). 프로파일이 둘 이상일 때만
  const builtinProfiles = new Set(builtinAll.map((s) => s.profile)).size;
  const builtinSub = builtinProfiles > 1 ? t('skills.builtinSub', { n: new Set(builtinAll.map((s) => s.name)).size, p: builtinProfiles }) : undefined;
  const restColumns = chips.includes('rest');                         // 외부 URL 배지가 켜져 있으면 「호출 URL」 열(D19). 열 숨김은 따로 기억한다
  // 다른 프로파일에서 가져온 스킬(shared_from)은 위치 칸이 「side (main에서 가져옴)」을 말하므로 값이 하나여도 열을 둔다
  const showWhere = new Set(rows.map((s) => s.profile)).size > 1 || rows.some((s) => s.shared_from);
  const showBuiltin = () =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set('tab', 'builtin');
        return p;
      },
      { replace: true }
    );
  // 부제: 프로파일 선택만(「정적 분석」은 뺌, 디자인 2A) + 호출 대상을 골랐을 때만 그 안내. 자리가 모자라면 안내는 다음 줄, xs 는 선택이 한 줄을 다 쓴다(디자인 10A)
  const named = choices.filter((p) => p !== ALL);
  const picker = multi ? (
    <ProfileScopePicker
      id="skills-profile"
      scope={scope}
      choices={named}
      labelOf={(p) => choiceLabel(p, g.primary)}
      onPick={pick}
      pickerRef={pickerRef}
      announce={picked === scope ? t('skills.profileAnnounce', { name: choiceLabel(scope, g.primary), n: rows.length }) : ''}
    />
  ) : null;
  const lensNote = lens ? (
    <Box component="span">
      {lensText[0]}
      <code>{lv}</code>
      {lensText[1]}{' '}
      <Button size="small" onClick={() => setLens('')}>
        {t('skills.viewAll')}
      </Button>
    </Box>
  ) : null;
  const sub =
    picker || lensNote ? (
      <Box component="span" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 1, rowGap: 0.5 }}>
        {picker}
        {lensNote}
      </Box>
    ) : undefined;
  const inMine = (s: SkillRow) => isMySkill(s.origin);
  const inBuiltin = (s: SkillRow) => !isMySkill(s.origin);

  return (
    <>
      {/* 팀원 에이전트의 스킬을 다룰 때만 화면 머리에 회색 상태 줄(스펙 2026-10-22-001 DD5) */}
      <TeamTargetNote />
      <NewFromParam value={params.get('new')} canUpload={!!g.can_upload} open={openNew} />
      <BundledRepairNote pod={me?.pod?.id ?? ''} records={g.bundled_repaired} profile={filterProfile ?? undefined} />
      <ListView<SkillRow>
        guide="skills.list"
        key={scope}
        titleAction={
          // 가이드가 강조하는 자리(OMAI-1274 user.make-skill)
          <Box component="span" data-guide="skills.new" sx={{ display: 'inline-flex' }}>
            <AddIconButton {...add} />
          </Box>
        }
        gridAction={add}
        title={t('skills.title')}
        sub={sub}
        error={q.error?.message}
        // 보기 카드(2026-10-17-011). 숫자는 lens·태그로 거르기 전 수다(D9) — 태그를 켤 때마다 바뀌지 않게. 거른 수는 표 개수와 태그 칩 줄이 보인다
        tabs={[
          {
            id: 'mine',
            label: t('skills.tabMine'),
            items: narrow(mineAll),
            count: mineAll.length,
            above: mineAll.length ? above : undefined,
            card: {},
            ...emptyFor(inMine),
            // 내 스킬이 거르기 전부터 0 이면 표 대신 빈 화면(스펙 2026-10-27-011 D8, 재검토 D1 — ListView 는 그대로)
            ...(mineAll.length ? {} : { content: <MineEmpty builtin={builtinAll.length} onNew={add.onClick} onZip={g.can_upload ? () => openNew('zip') : undefined} onBuiltin={showBuiltin} /> }),
          },
          { id: 'builtin', label: t('skills.tabBuiltin'), items: narrow(builtinAll), count: builtinAll.length, above, card: builtinSub ? { sub: builtinSub } : {}, ...emptyFor(inBuiltin) },
          { id: 'all', label: t('skills.tabAll'), items: narrow(rows), count: rows.length, above, card: {}, ...emptyFor(() => true) },
        ]}
        toggles={TOGGLES()}
        toolbar={
          <>
            <NativeSelect
              value={lens}
              onChange={(e) => setLens(e.target.value)}
              inputProps={{ 'aria-label': t('skills.filterByTarget') }}
            >
              <option value="">{t('skills.targetAll')}</option>
              <optgroup label={t('skills.mcpGroup')}>
                {recount(g.by_mcp, 'mcp').map(([k, n]) => (
                  <option key={k} value={'mcp:' + k}>{`${k} (${n})`}</option>
                ))}
              </optgroup>
              <optgroup label={t('skills.hostGroup')}>
                {recount(g.by_host, 'host')
                  .slice(0, 40)
                  .map(([k, n]) => (
                    <option key={k} value={'host:' + k}>{`${k} (${n})`}</option>
                  ))}
              </optgroup>
            </NativeSelect>
            <AgentViewButton />
            <Button
              size="small"
              data-guide="skills.delegate"
              onClick={() => openChat({ kind: 'chat', ...chat(talk, newSkillPrompt()) })}
              title={t('skills.delegateTitle')}
            >
              {t('skills.delegate')}
            </Button>
          </>
        }
        text={skillText}
        id={restColumns ? 'skills-rest' : 'skills'}
        columns={restColumns ? REST_COLUMNS(tagCount.length > 0, showWhere) : COLUMNS(tagCount.length > 0, showWhere)}
        rowId={(s) => s.id}
        openId={route.open}
        clearOnTab={route.clearOnTab}
        onRefresh={() => void q.refetch()}
        isFetching={q.isFetching}
        onRow={(s) => route.openRow(s.id)}
      />
    </>
  );
}

/** 내 스킬이 하나도 없을 때(디자인 리뷰 D8): 제목·설명·Tier 1 「새 스킬」·기본 제공·스킬 허브 링크. 밀도 화면이라 표 자리 안에 둔다.
 *  zip 을 올릴 수 있으면(can_upload) 「새 스킬」 옆에 「zip 올리기」 — 새 스킬 서랍의 zip 탭으로 바로 연다 */
function MineEmpty({ builtin, onNew, onZip, onBuiltin }: { builtin: number; onNew: () => void; onZip?: () => void; onBuiltin: () => void }) {
  const navigate = useNavigate();
  return (
    <Stack data-testid="skills-mine-empty" alignItems="center" spacing={1} sx={{ py: 6, px: 2, textAlign: 'center' }}>
      <Typography variant="h6" component="h2">
        {t('skills.mineEmptyTitle')}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 480 }}>
        {t('skills.mineEmptyBody')}
      </Typography>
      <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
        <Button variant="outlined" color="inherit" sx={tier1} startIcon={<AddIcon />} onClick={onNew}>
          {t('skills.newSkill')}
        </Button>
        {onZip && (
          <Button variant="outlined" color="inherit" sx={tier1} startIcon={<FolderZipOutlinedIcon />} onClick={onZip}>
            {t('skills.tabZip')}
          </Button>
        )}
      </Stack>
      <Stack direction="row" spacing={2}>
        <Button size="small" color="inherit" onClick={onBuiltin}>
          {t('skills.mineEmptyBuiltin', { n: builtin })}
        </Button>
        <Button size="small" color="inherit" onClick={() => navigate('/market')}>
          {t('skills.mineEmptyHub')}
        </Button>
      </Stack>
    </Stack>
  );
}
