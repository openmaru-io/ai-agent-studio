/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
// 자격증명·도구·라이브러리: 같은 틀. 값은 보지 않고 이름·위치·상태·쓰는 곳만 본다.
// 서랍 아래의 「관리 기록」(상태·담당·메모)은 AAS 가 따로 갖는 기록이며 Hermes 의 파일은 바꾸지 않는다.
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, NativeSelect, Stack, TextField, Typography } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { ReactNode, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { AddAction, AddIconButton } from '@/components/AddIconButton';
import { AgentPicker } from '@/components/AgentPicker';
import { ChatChip, KV, Labeled, LinkChip, ScreenLoading, Section, Tag, UsedByLinks } from '@/components/bits';
import { useConfirm } from '@/components/ConfirmDialog';
import { GridColumn, nameColumn, Pill } from '@/components/DataGrid';
import { ListBanner, ListCard, ListToggleCard, ListView, tabOf, Tone } from '@/components/ListView';
import { Markdown } from '@/components/Markdown';
import { MarkdownField } from '@/components/MarkdownField';
import { PersonPicker } from '@/components/PersonPicker';
import { ALL_PROFILES, ProfileScopePicker, useProfileScope } from '@/components/ProfileScopeSelect';
import { t } from '@/i18n';
import { get, post } from '@/lib/api';
import { useIsAdmin, useMe } from '@/lib/data';
import { MONO_FONT } from '@/lib/monoFont';
import { usePeople } from '@/lib/people';
import { badgeTone, serverTerm } from '@/lib/serverTerms';

import { SetValue } from './profiles/Panes';
import type { ProfileRow } from './profiles/types';
interface Reg {
  status: 'registered' | 'review' | 'deprecated';
  owner?: string;
  note?: string;
  updated?: string;
}
interface Item {
  id: string;
  name: string;
  scope: string;
  profile?: string;
  flags?: string[];
  used_count?: number;
  used_by?: string[];
  reg?: Reg | null;
  // 종류마다 다른 값
  [k: string]: unknown;
}
interface Env {
  env: string;
  kind: string;
  scope: string;
  profile?: string;
  packages: number;
  path?: string;
  note?: string;
}
/** 도구 화면의 MCP 서버 한 줄(서버 aas/assets/inventory.py _mcp). 값은 없고 이름과 mcp_target 결과만 온다 */
interface McpRow {
  id: string;
  name: string;
  scope: string;
  profile?: string;
  transport: string;
  enabled: boolean;
  auth: string;
  target: string;
  env_names: string[];
  env_count: number;
  header_names: string[];
  header_count: number;
  modified?: string;
}
interface Data {
  /** 서버가 .env 에서 행으로 싣는 이름의 규칙(자격증명만). 새 비밀값 이름이 표에 나타날지 미리 알린다(스펙 2026-10-14-025 D9) */
  name_pattern?: string;
  totals: Record<string, number | Record<string, number>>;
  items: Item[];
  envs?: Env[];
  /** 도구 화면: 옛 서버 응답에는 없다(그때는 MCP 카드와 탭을 그리지 않는다, V4) */
  mcp?: McpRow[];
  /** 설정 파일을 읽지 못해 건너뛴 프로파일. profile 이 '*' 이면 목록 전체를 못 만들었다(V5) */
  mcp_skipped?: { profile: string; reason: string }[];
  /** API 키·토큰: 서버가 감춘 AAS 기본 값의 수(값·이름은 없다). by_profile 의 루트는 "" (스펙 2026-10-28-006 D5·OV-9) */
  hidden?: { count: number; by_profile: Record<string, number>; kinds: string[] };
}

type Kind = 'credentials' | 'tools' | 'libraries';

const REG = (): Record<Reg['status'], [string, Tone]> => ({
  registered: [t('inventory.statusRegistered'), 'good'],
  review: [t('inventory.statusReview'), 'warn'],
  deprecated: [t('inventory.statusDeprecated'), 'bad'],
});
// 서버가 범위(scope)로 보내는 한글 값
const GLOBAL = '전역'; // i18n-ignore: 서버가 보내는 범위 값
const day = (s?: unknown) => String(s ?? '').slice(0, 10);
const str = (v: unknown) => (v == null ? '' : String(v));
const scopeOf = (i: { scope: string; profile?: string }) =>
  i.scope === GLOBAL ? t('inventory.scopeGlobal') : i.profile ?? '';
const flagTone = (f: string): Tone => (badgeTone(f) === 'bad' ? 'bad' : 'warn');
const FlagTags = ({ i, max }: { i: Item; max?: number }) => (
  <>
    {(i.flags ?? []).slice(0, max).map((f) => (
      <Tag key={f} tone={flagTone(f)}>
        {serverTerm(f)}
      </Tag>
    ))}
  </>
);
const code = (v: unknown) => (v ? <code>{str(v)}</code> : '');

// ── 공통 표의 열(OMAI-1127, 계획 2026-10-13-015). 두 줄 목록의 배지·보조 줄·오른쪽 칩을 열로 옮겼다(디자인 1B) ──
/** 확인할 것 칸: 서버 플래그와 관리 기록을 Pill 로(디자인 5C). 자격증명은 값이 비었으면 「비어 있음」도 */
const reviewColumn = (withEmpty: boolean): GridColumn<Item> => ({
  id: 'flags',
  label: t('inventory.review'),
  value: (i) => (i.flags ?? []).join(' '),
  width: 'minmax(160px, 1.5fr)',
  render: (i) => (
    <>
      {withEmpty && !i.set && !i.oauth && !(i.flags ?? []).includes('비어 있음') /* i18n-ignore: 서버가 보내는 표시 값 */ && (
        <Pill tone="bad">{t('inventory.valueEmpty')}</Pill>
      )}
      {(i.flags ?? []).slice(0, 2).map((f) => (
        <Pill key={f} tone={flagTone(f)}>
          {serverTerm(f)}
        </Pill>
      ))}
      {i.reg && <Pill tone={REG()[i.reg.status][1]}>{REG()[i.reg.status][0]}</Pill>}
    </>
  ),
});
const scopeColumn: GridColumn<Item> = { id: 'profile', label: t('inventory.scope'), value: (i) => scopeOf(i), width: 'minmax(100px, 0.8fr)' };
const textColumn = (id: string, label: string, o: Partial<GridColumn<Item>> = {}): GridColumn<Item> => ({
  id,
  label,
  value: (i) => str(i[id]),
  width: 'minmax(100px, 1fr)',
  ...o,
});
const usedColumn: GridColumn<Item> = {
  id: 'used_count',
  label: t('inventory.usedCount'),
  value: (i) => Number(i.used_count ?? 0),
  width: '88px',
  num: true,
};
// 거르기 배지의 판정은 서버 합계(aas/assets/inventory.py totals)와 같은 식이다 — 숫자가 행 수와 어긋나지 않는다
const hasFlag = (part: string) => (i: Item) => (i.flags ?? []).some((f) => f.includes(part));

function RegistryForm({ kind, item }: { kind: string; item: Item }) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [reg, setReg] = useState<Reg | null>(item.reg ?? null);
  const [status, setStatus] = useState<string>(reg?.status ?? 'registered');
  const [owner, setOwner] = useState(reg?.owner ?? '');
  const [note, setNote] = useState(reg?.note ?? '');
  const [busy, setBusy] = useState(false);
  const admin = useIsAdmin(); // 담당·메모·상태 기록은 관리자만(OMAI-1122). 그 밖에는 기록을 읽기만 한다
  const people = usePeople(admin); // 담당은 관리자만 적는다(GET /api/users 도 관리자 전용)
  const confirm = useConfirm();

  const save = async () => {
    // 등록 해제는 담당·메모 기록이 함께 지워지므로 확인한다(OMAI-1135)
    if (reg && status === 'none' && !(await confirm(t('inventory.unregisterConfirm', { name: item.name })))) return;
    setBusy(true);
    try {
      const r = await post<{ reg: Reg | null }>('/api/registry', { kind, key: item.id, status, owner, note });
      setReg(r.reg);
      enqueueSnackbar(r.reg ? t('inventory.registered', { name: item.name }) : t('inventory.unregistered', { name: item.name }), { variant: 'success' });
      await qc.invalidateQueries({ queryKey: ['inventory'] });
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    }
    setBusy(false);
  };

  return (
    <Section title={t('inventory.registryTitle')}>
      {reg && (
        <Typography variant="caption" color="text.secondary" component="p">
          {`${REG()[reg.status][0]} · ${[reg.owner, reg.updated && day(reg.updated)].filter(Boolean).join(' · ')}`}
        </Typography>
      )}
      {reg?.note && <Markdown text={reg.note} />}
      {!admin && !reg && (
        <Typography variant="caption" color="text.secondary" component="p">
          {t('inventory.adminOnly')}
        </Typography>
      )}
      {admin && (
      <Stack spacing={1.5} sx={{ mt: 1 }}>
        <Labeled label={t('inventory.status')}>
          <NativeSelect
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            inputProps={{ 'aria-label': t('inventory.status') }}
          >
            {Object.entries(REG()).map(([k, v]) => (
              <option key={k} value={k}>
                {v[0]}
              </option>
            ))}
            {reg && <option value="none">{t('inventory.unregister')}</option>}
          </NativeSelect>
        </Labeled>
        <PersonPicker
          label={t('inventory.owner')}
          value={owner}
          onChange={setOwner}
          people={people}
          store="name"
          placeholder={t('inventory.ownerPlaceholder')}
        />
        <MarkdownField
          value={note}
          onChange={setNote}
          label={t('inventory.noteLabel')}
          placeholder={t('inventory.notePlaceholder')}
        />
        <Box>
          <Button variant="contained" disabled={busy} onClick={save}>
            {reg ? t('inventory.saveChanges') : t('inventory.register')}
          </Button>
        </Box>
        <Typography variant="caption" color="text.secondary">
          {t('inventory.registryNote')}
        </Typography>
      </Stack>
      )}
    </Section>
  );
}

// ── 값 넣기(스펙 2026-10-14-025). 쓰기는 프로파일 화면의 비밀값과 같은 경로(env_set → Hermes /api/env)다. ──
/**
 * 값을 넣을 수 있는 조건: 관리자 또는 이 POD 의 주인이고(OMAI-1196, 스펙 2026-10-15-011 D3), 암호화된 연결(서버가 /api/me 로 알림)이고,
 * 프로파일 목록을 받았을 때. 모르는 상태는 닫는다. 주인이 넣을 수 없는 이름(모델 키·동작 설정)은 서버가 거절하고 그 문구가 입력 칸에 보인다.
 */
function useCredentialWrite(enabled: boolean) {
  const me = useMe();
  const admin = useIsAdmin();
  const may = admin || !!me.data?.owner || !!me.data?.team_manager; // 팀 관리자도 팀원 에이전트에 값을 넣는다(스펙 2026-10-22-001)
  const list = useQuery<{ profiles: ProfileRow[] }>({
    queryKey: ['profiles'],
    queryFn: () => get('/api/profiles'),
    enabled: enabled && may,
  });
  const profiles = list.data?.profiles;
  const secure = me.data?.secure; // undefined = 모름
  // 목록을 받지 않는 사람이거나 받기를 마쳤는가(성공·실패). 프로파일 고르기의 처음 값이 목록을 기다린다 — 안 기다리면 주소의 프로파일을 없는 이름으로 본다
  const listed = !(enabled && may) || list.isFetched;
  return { admin, may, secure, profiles, listed, ready: enabled && may && secure === true && !!profiles };
}
type Write = ReturnType<typeof useCredentialWrite>;
// 숨긴 루트(main 대상 POD)는 관리자에게도 읽기 전용이다(스펙 2026-10-14-003 리뷰 D8). 프로파일 화면과 같은 규칙
const rootHidden = (profiles?: ProfileRow[]) => !!profiles?.find((p) => p.is_default)?.hidden_root;
const ENV_KEY = /^[A-Z][A-Z0-9_]{1,63}$/; // 서버 profiles.ENV_KEY 와 같다
/** 행이 가리키는 프로파일(전역 행은 기본 프로파일) */
const targetOf = (i: Item) => (i.scope === GLOBAL ? 'default' : i.profile ?? '');
const isEnvRow = (i: Item) => /\.env$/.test(str(i.location)) && !/docker\//.test(str(i.location));

function EnvChange({ item, w }: { item: Item; w: Write }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const name = targetOf(item);
  let body: ReactNode = null;
  if (w.may) {
    if (w.secure === false) {
      body = <Typography variant="body2" color="text.secondary">{t('inventory.needSecure')}</Typography>;
    } else if (w.ready && name === 'default' && rootHidden(w.profiles)) {
      body = <Typography variant="body2" color="text.secondary">{t('inventory.rootReadOnly')}</Typography>;
    } else if (w.ready) {
      body = (
        <Stack spacing={1}>
          {open ? (
            <SetValue
              name={name}
              target={item.name}
              overwrite={!!item.set}
              onDone={() => {
                setOpen(false);
                void qc.invalidateQueries({ queryKey: ['inventory'] }); // 서버는 저장 때 캐시를 버린다. 이 표도 다시 받는다
              }}
            />
          ) : (
            <Box>
              <Button size="small" startIcon={<EditOutlinedIcon />} onClick={() => setOpen(true)}>
                {item.set ? t('profiles.envChange') : t('profiles.envPut')}
              </Button>
            </Box>
          )}
          <Typography variant="caption" color="text.secondary">{t('inventory.envApplyNote')}</Typography>
        </Stack>
      );
    }
  }
  return (
    <Section title={t('inventory.changeValue')}>
      {body}
      <LinkChip to="profiles" params={{ name, pane: 'env' }} page>
        {t('inventory.changeInSecrets', { name })}
      </LinkChip>
    </Section>
  );
}

/** 서랍의 「값 바꾸기」: 갈래는 번역된 source 가 아니라 location 의 모양으로 가른다 */
function ChangeHint({ item, w }: { item: Item; w: Write }) {
  const loc = str(item.location);
  const name = targetOf(item);
  if (isEnvRow(item)) return <EnvChange item={item} w={w} />;
  if (/config\.yaml/.test(loc))
    return (
      <Section title={t('inventory.changeValue')}>
        <LinkChip to="profiles" params={{ name, pane: 'config' }} page>
          {t('inventory.changeInConfig', { name })}
        </LinkChip>
      </Section>
    );
  if (/(^|\/)secrets\//.test(loc) || /(^|\/)(auth|google_token|google_client_secret)\.json$/.test(loc))
    return (
      <Section title={t('inventory.changeValue')}>
        <Typography variant="body2" color="text.secondary">{t('inventory.cannotChangeHere', { where: loc })}</Typography>
      </Section>
    );
  return null;
}

/** 표 위 「새 비밀값」: 표에 없는 새 .env 키를 이 화면에서 만든다 */
/** 새 비밀값을 넣을 수 있는 프로파일(숨긴 루트 제외). 비면 「새 비밀값」 단추를 보이지 않는다 */
const secretChoices = (w: Write) => (w.ready ? (w.profiles ?? []).filter((p) => !(p.is_default && p.hidden_root)) : []);

/** 새 비밀값 창. 여는 단추(제목 옆 + 와 표 툴바의 「+ 새 비밀값」)는 화면이 그린다(2026-10-21) */
function NewSecret({
  w,
  items,
  pattern,
  open,
  onClose,
  initialProfile,
}: {
  w: Write;
  items: Item[];
  pattern?: string;
  open: boolean;
  onClose: () => void;
  /** 화면에서 고른 프로파일(스펙 2026-10-28-006 §4-1). 넣을 수 있는 곳이 아니면 무시한다 */
  initialProfile?: string;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [profile, setProfile] = useState('');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const choices = secretChoices(w);
  if (choices.length === 0) return null;
  const chosen =
    profile || (choices.find((p) => p.name === initialProfile) ?? choices.find((p) => !p.is_default) ?? choices[0]).name;
  const valid = ENV_KEY.test(name);
  let listed = true; // 서버의 표 규칙에 맞아 저장 뒤 행으로 나타나는가. 규칙을 아직 못 받았으면 경고하지 않는다
  try {
    listed = !pattern || new RegExp(pattern, 'i').test(name);
  } catch {
    listed = true;
  }
  const close = () => {
    onClose();
    setName('');
    setValue('');
  };
  const save = async () => {
    if (!valid || !value || busy) return;
    const exists = items.some((i) => isEnvRow(i) && targetOf(i) === chosen && i.name === name);
    if (exists && !(await confirm(t('profiles.envOverwriteConfirm', { target: name })))) return;
    setBusy(true);
    try {
      await post('/api/profile/action', { name: chosen, action: 'env_set', target: name, value });
      enqueueSnackbar(t('inventory.newSecretSaved', { name, profile: chosen }), { variant: 'success' });
      close();
      await qc.invalidateQueries({ queryKey: ['inventory'] });
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    }
    setBusy(false);
  };
  return (
    <>
      <Dialog open={open} onClose={close} maxWidth="xs" fullWidth aria-labelledby="new-secret-title">
        <DialogTitle id="new-secret-title">{t('inventory.newSecretTitle')}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <AgentPicker
              label={t('inventory.newSecretProfile')}
              value={chosen}
              onChange={setProfile}
              options={choices.map((p) => ({ value: p.name, label: p.name }))}
            />
            <TextField
              size="small"
              label={t('inventory.newSecretName')}
              value={name}
              onChange={(e) => setName(e.target.value.toUpperCase())}
              error={!!name && !valid}
              helperText={!!name && !valid ? t('inventory.newSecretBadName') : t('inventory.newSecretNameHelp')}
              autoComplete="off"
              slotProps={{ htmlInput: { spellCheck: false, style: { fontFamily: MONO_FONT } } }}
            />
            {valid && !listed && (
              <Typography variant="caption" color="warning.main">
                {t('inventory.newSecretNotListed')}
              </Typography>
            )}
            <TextField
              size="small"
              type="password"
              label={t('inventory.newSecretValue')}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
              slotProps={{ htmlInput: { spellCheck: false } }}
            />
            <Typography variant="caption" color="text.secondary">
              {t('inventory.envApplyNote')}
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={close}>{t('inventory.newSecretClose')}</Button>
          <Button variant="contained" disabled={busy || !valid || !value} onClick={save}>
            {t('profiles.save')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

interface Config {
  kind: string;
  title: string;
  api: string;
  filters: [string, string][];
  note: string;
  /** 숫자만 카드(누를 수 없음). 보기의 둘째 줄은 views 에 둔다(2026-10-17-011) */
  cards: (tt: Data['totals']) => ListCard[];
  /** 보기 카드의 둘째 줄(탭 id → 글). 예전에는 그 탭으로 가는 카드의 설명이었다 */
  views: (tt: Data['totals']) => Record<string, string | undefined>;
  /** 현재 탭을 거르는 배지(검토 D11). 원래 「확인할 것」 탭으로 가던 카드다 */
  toggles: () => ListToggleCard<Item>[];
  text: (i: Item) => string;
  columns: () => GridColumn<Item>[];
  facts: (i: Item) => [string, ReactNode][];
  extra?: (i: Item) => ReactNode;
}

const n = (v: unknown) => Number(v ?? 0);

const CONFIG = (): Record<Kind, Config> => ({
  credentials: {
    kind: 'credential',
    title: t('inventory.credentials'),
    api: '/api/credentials',
    filters: [
      ['interface', t('inventory.interface')],
      ['source', t('inventory.source')],
    ],
    note: t('inventory.credentialsNote'),
    cards: (tt) => [{ n: n(tt.shared_groups), label: t('inventory.sharedGroups'), sub: t('inventory.sharedGroupsSub') }],
    views: (tt) => ({ all: t('inventory.scopeSplit', { global: n(tt.global), profile: n(tt.profile) }) }),
    toggles: () => [
      { id: 'expiring', label: t('inventory.expiring'), sub: t('inventory.expiringSub'), tone: 'bad', match: hasFlag('만료') }, // i18n-ignore: 서버 플래그 비교
      { id: 'empty', label: t('inventory.emptyValues'), sub: t('inventory.emptyValuesSub'), tone: 'warn', match: (i) => !i.set && !i.oauth }, // MCP OAuth 토큰 행은 「로그인 필요」로 따로 알린다(스펙 2026-10-16-010 T7)
      { id: 'backups', label: t('inventory.backups'), sub: t('inventory.backupsSub'), tone: 'warn', match: hasFlag('백업·임시 파일') }, // i18n-ignore: 서버 플래그 비교
    ],
    text: (i) =>
      [i.name, i.location, i.interface, i.profile, i.target, (i.used_by ?? []).join(' '), (i.flags ?? []).join(' ')]
        .map(str)
        .join(' '),
    columns: () => [
      nameColumn<Item>({ label: t('inventory.name'), value: (i) => i.name }),
      scopeColumn,
      textColumn('interface', t('inventory.interface')),
      textColumn('target', t('inventory.target')),
      textColumn('source', t('inventory.source'), { hidden: true }),
      textColumn('location', t('inventory.file'), { hidden: true, width: 'minmax(160px, 1.5fr)' }),
      textColumn('expires', t('inventory.expiry'), { value: (i) => day(i.expires), width: '104px' }),
      usedColumn,
      reviewColumn(true),
    ],
    facts: (i) => [
      [t('inventory.scope'), scopeOf(i)],
      [t('inventory.interface'), str(i.interface)],
      [t('inventory.target'), str(i.target)],
      [t('inventory.source'), str(i.source)],
      [t('inventory.file'), code(i.location)],
      [t('inventory.value'), i.set ? t('inventory.valueFilled') : t('inventory.valueEmpty')],
      [t('inventory.expiry'), i.expires ? day(i.expires) : ''],
      [t('inventory.sameValue'), i.shared ? t('inventory.copiedTo', { count: Number(i.shared) }) : ''],
    ],
  },
  tools: {
    kind: 'tool',
    title: t('inventory.tools'),
    api: '/api/tools',
    filters: [
      ['language', t('inventory.language')],
      ['kind', t('inventory.kind')],
    ],
    note: t('inventory.toolsNote'),
    cards: (tt) => [
      // 다른 카드처럼 숫자(언어 개수)를 앞에 크게, 언어별 개수는 설명 줄에 작게.
      // 예전에는 「Python 50 · Shell 5 · JavaScript 3」 문자열을 숫자 자리에 큰 글씨로 넣었다
      {
        n: Object.keys(tt.languages ?? {}).length,
        label: t('inventory.language'),
        sub: Object.entries((tt.languages ?? {}) as Record<string, number>)
          .map(([k, v]) => `${k} ${v}`)
          .join(' · '),
      },
    ],
    views: (tt) => ({
      all: t('inventory.scopeSplit', { global: n(tt.global), profile: n(tt.profile) }),
      reg: t('inventory.registeredToolsSub'),
      mcp: typeof tt.mcp === 'number' ? t('inventory.mcpCardSub', { on: tt.mcp - Number(tt.mcp_off ?? 0), off: n(tt.mcp_off) }) : undefined,
    }),
    toggles: () => [
      { id: 'unreferenced', label: t('inventory.unreferenced'), sub: t('inventory.unreferencedSub'), tone: 'warn', match: hasFlag('부르는 곳을 찾지 못함') }, // i18n-ignore: 서버 플래그 비교
    ],
    text: (i) =>
      [i.name, i.path, i.summary, i.profile, ((i.imports as string[]) ?? []).join(' '), (i.used_by ?? []).join(' ')]
        .map(str)
        .join(' '),
    columns: () => [
      nameColumn<Item>({ label: t('inventory.name'), value: (i) => i.name }),
      scopeColumn,
      textColumn('language', t('inventory.language'), { width: '96px' }),
      textColumn('kind', t('inventory.kind'), { hidden: true }),
      textColumn('summary', t('inventory.summary'), { value: (i) => str(i.summary || i.path), width: 'minmax(180px, 2fr)' }),
      textColumn('modified', t('inventory.modified'), { value: (i) => day(i.modified), width: '104px' }),
      usedColumn,
      reviewColumn(false),
    ],
    facts: (i) => [
      [t('inventory.scope'), scopeOf(i)],
      [t('inventory.language'), str(i.language)],
      [t('inventory.kind'), str(i.kind)],
      [t('inventory.path'), code(i.path)],
      [t('inventory.modified'), day(i.modified)],
      [t('inventory.summary'), str(i.summary)],
    ],
    extra: (i) => (
      <>
        <Section title={t('inventory.chatWithTool')}>
          <ChatChip
            agent={i.scope === GLOBAL ? 'default' : (i.profile ?? 'default')}
            text={t('inventory.explainPrompt', { path: str(i.path) })}
          >
            {t('inventory.explainAction')}
          </ChatChip>
        </Section>
      </>
    ),
  },
  libraries: {
    kind: 'library',
    title: t('inventory.libraries'),
    api: '/api/libraries',
    filters: [
      ['env', t('inventory.env')],
      ['kind', t('inventory.kind')],
    ],
    note: t('inventory.librariesNote'),
    cards: (tt) => [{ n: n(tt.used), label: t('inventory.usedByScripts'), sub: t('inventory.usedByScriptsSub') }],
    views: (tt) => ({ all: t('inventory.envScopeSplit', { envs: n(tt.envs), global: n(tt.global), profile: n(tt.profile) }) }),
    // 서버의 version_conflicts 는 (종류, 이름) 묶음 수다. 배지는 행을 거르므로 그 묶음에 든 행 수를 센다
    toggles: () => [
      { id: 'conflicts', label: t('inventory.versionConflicts'), sub: t('inventory.versionConflictsSub'), tone: 'warn', match: hasFlag('버전이 다름') }, // i18n-ignore: 서버 플래그 비교
    ],
    text: (i) => [i.name, i.env, i.profile, (i.used_by ?? []).join(' ')].map(str).join(' '),
    columns: () => [
      nameColumn<Item>({ label: t('inventory.name'), value: (i) => i.name }),
      textColumn('version', t('inventory.version'), { width: '120px' }),
      scopeColumn,
      textColumn('kind', t('inventory.kind'), { width: '96px' }),
      textColumn('env', t('inventory.env')),
      usedColumn,
      reviewColumn(false),
    ],
    facts: (i) => [
      [t('inventory.version'), code(i.version)],
      [t('inventory.scope'), scopeOf(i)],
      [t('inventory.kind'), str(i.kind)],
      [t('inventory.env'), str(i.env)],
    ],
  },
});

// ── 도구 화면의 MCP 서버 탭(OMAI-1249, 스펙 2026-10-16-002 3-2절) ──
/** 알려진 연결 값(http·https)은 HTTP 로, 그 밖(stdio·sse 등)은 원문 그대로(V14) */
const transportLabel = (v: string) => (/^https?$/i.test(v) ? 'HTTP' : v);
/** Item 은 임의 키를 가지므로 'in' 만으로는 McpRow 로 좁혀지지 않는다. 숫자인 env_count 로 가른다 */
const isMcp = (i: Item | Env | McpRow): i is McpRow => typeof (i as McpRow).env_count === 'number' && 'transport' in i;
const mcpProfile = (m: McpRow) => (m.scope === GLOBAL ? 'default' : m.profile ?? '');
const mcpColumns = (): GridColumn<McpRow>[] => [
  nameColumn<McpRow>({ label: t('inventory.name'), value: (m) => m.name }),
  { id: 'profile', label: t('inventory.scope'), value: (m) => scopeOf(m), width: 'minmax(100px, 0.8fr)' },
  { id: 'transport', label: t('inventory.transport'), value: (m) => transportLabel(m.transport), width: 'minmax(96px, auto)' },
  { id: 'target', label: t('inventory.mcpTarget'), value: (m) => m.target, mono: true, width: 'minmax(220px, 3fr)' },
  {
    id: 'enabled',
    label: t('inventory.mcpSetting'),
    help: t('inventory.mcpSettingHelp'),
    value: (m) => (m.enabled ? t('inventory.mcpOn') : t('inventory.mcpOff')),
    // 켜짐은 본문 글자, 예외인 꺼짐만 중립 알약(초록은 「정상」이라 쓰지 않는다, V12)
    render: (m) => (m.enabled ? <span>{t('inventory.mcpOn')}</span> : <Pill flush>{t('inventory.mcpOff')}</Pill>),
    width: 'minmax(96px, auto)',
  },
];
const mcpText = (m: McpRow) =>
  [m.name, m.target, m.profile, transportLabel(m.transport), m.auth, ...m.env_names, ...m.header_names, m.enabled ? t('inventory.mcpOn') : t('inventory.mcpOff')].join(' ');
/** 이름 목록: 쉼표로 이은 모노스페이스 글자 한 덩어리, 20개를 넘으면 「외 N개」(V6·V13). 비면 「없음」(V7) */
function McpNames({ names, total }: { names: string[]; total: number }) {
  const more = Math.max(0, total - names.length);
  return (
    <Typography variant="body2" sx={{ fontFamily: MONO_FONT, overflowWrap: 'anywhere' }}>
      {names.length ? names.join(', ') + (more ? ` ${t('inventory.mcpMore', { count: more })}` : '') : t('inventory.mcpNone')}
    </Typography>
  );
}
const mcpDetail = (m: McpRow) => ({
  title: m.name,
  sub: `${scopeOf(m)} · ${t('inventory.mcpServers')}`,
  body: (
    <>
      <KV
        pairs={[
          [t('inventory.scope'), scopeOf(m)],
          [t('inventory.transport'), transportLabel(m.transport) || t('inventory.mcpNone')],
          [t('inventory.mcpTarget'), m.target ? <code key="t" style={{ overflowWrap: 'anywhere' }}>{m.target}</code> : t('inventory.mcpNone')],
          [t('inventory.mcpSetting'), m.enabled ? t('inventory.mcpOnNote') : t('inventory.mcpOffNote')],
          [t('inventory.mcpAuth'), m.auth || t('inventory.mcpNoAuth')],
          [t('inventory.mcpConfigModified'), day(m.modified) || t('inventory.mcpNone')],
        ]}
      />
      <Box sx={{ mt: 1.5 }}>
        <LinkChip to="profiles" params={{ name: mcpProfile(m), pane: 'tools', server: m.name }} page>
          {t('inventory.mcpOpenProfile')}
        </LinkChip>
      </Box>
      <Section title={t('inventory.mcpEnvNames', { count: m.env_count })}>
        <McpNames names={m.env_names} total={m.env_count} />
      </Section>
      <Section title={t('inventory.mcpHeaderNames', { count: m.header_count })}>
        <McpNames names={m.header_names} total={m.header_count} />
      </Section>
      <Typography variant="caption" color="text.secondary">
        {t('inventory.mcpNoValues')}
      </Typography>
    </>
  ),
});

/** API 키·토큰의 프로파일 선택 목록: 행의 프로파일 ∪ 넣을 수 있는 프로파일(숨긴 루트 제외). 주 프로파일 → 이름순 → 기본 프로파일(루트) */
const credChoices = (items: Item[], profiles: ProfileRow[] | undefined, primary?: string) =>
  [
    ...new Set([
      ...items.map(targetOf),
      ...(profiles ?? []).filter((p) => !(p.is_default && p.hidden_root)).map((p) => (p.is_default ? 'default' : p.name)),
    ]),
  ]
    .filter(Boolean)
    .sort((a, b) => Number(a === 'default') - Number(b === 'default') || Number(b === primary) - Number(a === primary) || a.localeCompare(b));
const scopeLabel = (p: string, primary?: string) =>
  p === ALL_PROFILES ? t('skills.profileAll') : p === 'default' ? t('common.profileRoot') : p === primary ? t('skills.profilePrimary', { name: p }) : p;
/** 카드·보기 숫자를 고른 행으로 센다(스펙 2026-10-28-006 §4-1). 「전체 프로파일」도 같은 함수 — 한 길 */
const credTotals = (items: Item[]) => ({
  items: items.length,
  global: items.filter((i) => i.scope === GLOBAL).length,
  profile: items.filter((i) => i.scope !== GLOBAL).length,
  shared_groups: new Set(items.map((i) => i.shared_group).filter(Boolean)).size,
});

function Inventory({ view }: { view: Kind }) {
  const C = CONFIG()[view];
  const q = useQuery<Data>({ queryKey: ['inventory', view], queryFn: () => get<Data>(C.api) });
  const d = q.data;
  const w = useCredentialWrite(view === 'credentials');
  const [secretOpen, setSecretOpen] = useState(false);
  const [params, setParams] = useSearchParams();
  const primary = useMe().data?.primary?.profile;
  const cred = view === 'credentials';
  const choices = cred && d ? credChoices(d.items, w.profiles, primary) : [];
  // 프로파일 고르기(스펙 2026-10-28-006, 스킬 목록과 같은 부품 D1). 처음 값은 행이 있는 프로파일(R8), 검색어만 있는 링크는 전체(R11)
  const { scope, pick, picked, pickerRef } = useProfileScope({
    ready: cred && !!d && w.listed,
    choices,
    multi: choices.length > 1,
    primary,
    storageKey: 'aas.credentialsProfile',
    labelOf: (p) => scopeLabel(p, primary),
    initial: () => (params.get('q') ? ALL_PROFILES : undefined),
    hasRows: (p) => !!d?.items.some((i) => targetOf(i) === p),
  });
  // 도구·라이브러리의 거르기 줄도 주소 키 profile 을 쓴다. API 키·토큰에서 가져온 「전체(*)」는 거르지 않음이다(외부 검토 OV-13)
  useEffect(() => {
    if (cred || params.get('profile') !== ALL_PROFILES) return;
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.delete('profile');
        return p;
      },
      { replace: true }
    );
  }, [cred, params, setParams]);
  if (!d || (cred && !scope)) return <ScreenLoading title={C.title} error={q.error?.message} />;

  const sc = scope ?? ALL_PROFILES; // 위에서 API 키·토큰이면 null 이 아님을 확인했다. 다른 보기는 늘 「전체」
  const scoped = cred && sc !== ALL_PROFILES;
  const items = scoped ? d.items.filter((i) => targetOf(i) === sc) : d.items;
  const totals = cred ? credTotals(items) : d.totals;
  const flagged = items.filter((i) => (i.flags ?? []).length);
  const nothing = d.items.length === 0 && Number(d.totals.items ?? 0) === 0;
  const emptyHint = nothing ? (view === 'credentials' ? t('inventory.emptyCredentials') : view === 'tools' ? t('inventory.emptyTools') : undefined) : undefined;
  // 고른 프로파일이 0행이면 다른 프로파일의 수와 「전체 프로파일에서 보기」(스킬과 같은 모양, R8)
  const elsewhere = scoped ? d.items.length - items.length : 0;
  const otherHint =
    scoped && items.length === 0 && elsewhere > 0 ? (
      <>
        {t('skills.otherProfiles', { name: scopeLabel(sc, primary), n: elsewhere })}
        <Button size="small" color="inherit" onClick={() => pick(ALL_PROFILES)} sx={{ color: 'text.secondary' }}>
          {t('skills.otherProfilesShow')}
        </Button>
      </>
    ) : undefined;

  const tabs = [
    // 전체가 첫 탭, 확인할 것은 그다음. 확인할 것으로 바로 가는 카드·링크는 tab 을 적는다
    tabOf<Item>({ id: 'all', label: t('inventory.all'), items, empty: otherHint ?? emptyHint }),
    tabOf<Item>({
      id: 'flag',
      label: t('inventory.review'),
      tone: 'warn',
      items: flagged,
      empty: t('inventory.reviewEmpty'),
    }),
    tabOf<Item>({
      id: 'reg',
      label: t('inventory.statusRegistered'),
      items: items.filter((i) => i.reg),
      empty: t('inventory.registeredEmpty'),
    }),
  ];
  const mcp = view === 'tools' ? d.mcp : undefined; // 옛 서버 응답에는 없다 — 그때는 카드와 탭을 그리지 않는다(V4)
  if (mcp) {
    const skipped = d.mcp_skipped ?? [];
    const skippedBanner: ListBanner | null = skipped.length
      ? {
          severity: 'warning',
          message: skipped.some((x) => x.profile === '*')
            ? t('inventory.mcpSkippedAll')
            : t('inventory.mcpSkipped', { count: skipped.length, names: skipped.map((x) => x.profile).join(', ') }),
        }
      : null;
    const off = mcp.filter((m) => !m.enabled).length;
    tabs.push(
      tabOf<McpRow>({
        id: 'mcp',
        label: t('inventory.mcpServers'),
        items: mcp,
        count: mcp.length,
        empty: t('inventory.mcpEmpty'),
        banner: skippedBanner,
        rowId: (m) => m.id,
        columns: mcpColumns(),
        // 스크립트용 「부르는 곳을 찾지 못함」은 MCP 행에 맞지 않는다. 꺼진 서버 하나만 둔다(V9)
        toggles: off ? [{ id: 'off', label: t('inventory.mcpOff'), match: (m: McpRow) => !m.enabled }] : [],
        detail: mcpDetail,
      })
    );
  }
  if (view === 'libraries')
    tabs.push(
      tabOf<Env>({
        id: 'envs',
        label: t('inventory.env'),
        items: d.envs ?? [],
        rowId: (e) => `${e.profile ?? ''}:${e.env}`,
        toggles: [], // 패키지 배지는 환경 행에 맞지 않는다
        columns: [
          nameColumn<Env>({ id: 'env', label: t('inventory.env'), value: (e) => e.env }),
          { id: 'profile', label: t('inventory.scope'), value: (e) => scopeOf(e), width: 'minmax(100px, 0.8fr)' },
          { id: 'kind', label: t('inventory.kind'), value: (e) => e.kind, width: '96px' },
          { id: 'packages', label: t('inventory.packages'), value: (e) => e.packages, width: '88px', num: true },
          { id: 'note', label: t('inventory.remark'), value: (e) => e.note || e.path || '', width: 'minmax(180px, 2fr)' },
        ],
        detail: (e) => ({
          title: e.env,
          sub: t('inventory.env'),
          body: (
            <>
              <KV
                pairs={[
                  [t('inventory.scope'), scopeOf(e)],
                  [t('inventory.kind'), e.kind],
                  [t('inventory.packages'), t('inventory.packagesTotal', { count: e.packages })],
                  [t('inventory.path'), code(e.path)],
                  [t('inventory.remark'), e.note ?? ''],
                ]}
              />
              <Section title={t('inventory.seeNext')}>
                <LinkChip to="libraries" params={{ tab: 'all', env: e.env }}>
                  {t('inventory.envPackages')}
                </LinkChip>
              </Section>
            </>
          ),
        }),
      })
    );

  // 보기 카드(2026-10-17-011): 모든 탭(조건부 MCP·설치 환경 포함)에 카드를 달아 탭 줄 대신 보기 카드 줄을 그린다
  const views = C.views(totals);
  for (const tb of tabs) tb.card = { sub: views[tb.id] };

  const addSecret: AddAction | null =
    view === 'credentials' && secretChoices(w).length ? { label: t('inventory.newSecret'), onClick: () => setSecretOpen(true) } : null;
  const hiddenN = cred && d.hidden ? (scoped ? (d.hidden.by_profile[sc === 'default' ? '' : sc] ?? 0) : d.hidden.count) : 0;
  const note = hiddenN ? `${C.note} ${t('inventory.hiddenDefaults', { n: hiddenN })}` : C.note;
  const count = mcp ? t('inventory.toolsTotal', { scripts: d.items.length, mcp: mcp.length }) : t('inventory.itemsTotal', { count: items.length });
  const picker =
    cred && choices.length > 1 ? (
      <ProfileScopePicker
        id="credentials-profile"
        scope={sc}
        choices={choices}
        labelOf={(p) => scopeLabel(p, primary)}
        onPick={pick}
        pickerRef={pickerRef}
        announce={picked === sc ? t('inventory.profileAnnounce', { name: scopeLabel(sc, primary), n: items.length }) : ''}
      />
    ) : null;

  return (
    <>
    <ListView<Item | Env | McpRow>
      guide={cred ? 'credentials.list' : undefined}
      key={cred ? sc : view}
      title={C.title}
      sub={
        picker ? (
          <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: 1.5, width: '100%' }}>
            {picker}
            <span>{count}</span>
          </Box>
        ) : (
          count
        )
      }
      error={q.error?.message}
      note={note}
      titleAction={addSecret ? <AddIconButton {...addSecret} /> : undefined}
      gridAction={addSecret}
      cards={C.cards(totals)}
      tabs={tabs}
      id={view}
      // 프로파일 하나를 고르면 범위 열은 값이 하나라 뺀다(§4-1). 사용자가 숨긴 열 기억은 그대로
      columns={(scoped ? C.columns().filter((c) => c.id !== 'profile') : C.columns()) as GridColumn<Item | Env | McpRow>[]}
      rowId={(i) => (i as Item).id}
      toggles={C.toggles() as ListToggleCard<Item | Env | McpRow>[]}
      onRefresh={() => void q.refetch()}
      isFetching={q.isFetching}
      filters={[
        // API 키·토큰은 머리의 프로파일 선택이 같은 일을 하고 같은 주소 키를 쓴다(리뷰 R3)
        ...(cred ? [] : [{ key: 'profile', label: t('inventory.scope'), get: (i: Item | Env | McpRow) => scopeOf(i as Item) }]),
        ...C.filters.map(([key, label]) => ({
          key,
          label,
          get: (i: Item | Env | McpRow) => str((i as unknown as Record<string, unknown>)[key]),
        })),
      ]}
      text={(i) => (isMcp(i) ? mcpText(i) : 'env' in i && 'packages' in i ? [i.env, i.kind, i.note].join(' ') : C.text(i as Item))}
      detail={(i) => {
        const it = i as Item;
        return {
          title: it.name,
          sub: `${scopeOf(it)} · ${C.title}`,
          body: (
            <>
              <KV pairs={C.facts(it)} />
              {(it.flags ?? []).length > 0 && (
                <Section title={t('inventory.review')}>
                  <FlagTags i={it} />
                </Section>
              )}
              {view === 'credentials' && <ChangeHint item={it} w={w} />}
              <Section title={t('inventory.usedByTitle')} count={it.used_count || 0}>
                <UsedByLinks labels={it.used_by} more={it.used_count} />
              </Section>
              {C.extra?.(it)}
              <RegistryForm kind={C.kind} item={it} />
            </>
          ),
        };
      }}
    />
    {addSecret && (
      <NewSecret
        w={w}
        items={d.items}
        pattern={d.name_pattern}
        open={secretOpen}
        onClose={() => setSecretOpen(false)}
        initialProfile={scoped ? sc : undefined}
      />
    )}
    </>
  );
}

export const Credentials = () => <Inventory view="credentials" />;
export const Tools = () => <Inventory view="tools" />;
export const Libraries = () => <Inventory view="libraries" />;
