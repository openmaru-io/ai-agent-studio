/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 내 PC 의 Hermes 를 프로파일에 넣기·프로파일 내보내기(OMAI-1136, 스펙 import-local-hermes-into-main §10)의 서버 호출과 화면 계산.
// main 이 아닌 이름 있는 프로파일도 대상이다(OMAI-1444, 스펙 pc-import-any-profile). 루트(default)·임시(pcimp-)는 막는다.
// 서버는 오류를 {code} 로만 보내고 문장은 화면이 번역 키로 고른다. lib/api 의 도우미는 code 를 버리므로 여기서 따로 읽는다.
// 올리기는 대화 파일 올리기(lib/chatFiles.sendUpload)처럼 XHR 로 보내 진행률을 받는다.
import { useQuery } from '@tanstack/react-query';

import { getLang, hasKey, t } from '@/i18n';

export type JobState = 'uploaded' | 'rejected' | 'running' | 'done' | 'failed' | 'rolled_back' | 'rollback_failed' | 'cancelled';
export type JobStage = 'check' | 'import' | 'config' | 'replace' | 'secrets' | 'env' | 'skills' | 'restart' | 'cleanup' | '';

/** 확인 화면의 「옮기는 비밀」 미리 나눈 숫자(스펙 2026-10-22-003 DD7). known=false 면 숫자를 모른다(R23) */
export interface SecretsPlan {
  known: boolean;
  files_replace: string[];
  files_replace_count: number;
  files_new: string[];
  files_new_count: number;
  env_add: string[];
  env_add_count: number;
  env_exists: string[];
  env_exists_count: number;
  env_blocked: string[];
  env_blocked_count: number;
  mcp_files: number;
  channel_files: number;
}

export interface Keeps {
  env: number;
  env_known?: boolean;
  channels: string[];
  shared_with: string[];
  /** 대상 프로파일의 지금 스킬 수(DD5). 이름은 main 때 그대로 둔다(OMAI-1444 §4-3). 읽지 못했으면 null */
  skills_main?: number | null;
  secrets_plan?: SecretsPlan;
  /** 같은 AI 에이전트 작업공간의 다른 이름 있는 프로파일. 있으면 게이트웨이 재시작 안내(OMAI-1444 DD10) */
  others?: string[];
}

export interface Group {
  name: string;
  files: number;
}

export interface Dropped {
  links: number;
  link_skills: string[];
  link_skills_count: number;
  credential: number;
  credential_groups: Group[];
  credential_groups_count: number;
  other: number;
  other_groups: Group[];
  other_groups_count: number;
  secrets_off: number;
  secrets_off_names: string[];
  secrets_off_count: number;
}

export interface SummarySecrets {
  files: string[];
  files_count: number;
  env_keys: string[];
  env_keys_count: number;
  env_unreadable: string[];
  size: number;
  model_files: string[];
  mcp_files: number;
  channel_files: number;
}

export interface EnvSkip {
  name: string;
  reason: 'exists' | 'blocked' | 'unreadable' | 'unchecked' | string;
}

export interface Job {
  id: string;
  profile: string;
  state: JobState;
  stage: JobStage;
  name: string;
  size: number;
  by_admin: boolean;
  owner: string;
  /** 주인의 사람 이름(2026-10-30) */
  owner_name?: string;
  summary: {
    ok: boolean;
    reason: string;
    root: string;
    counts: { skills: number; cron: number; sessions: number; memories: number; soul: boolean };
    os_only_skills: string[];
    pc_path_jobs: string[];
    env_refs: string[];
    unpacked: number;
    members: number;
    kept?: number;
    kept_size?: number;
    secrets_enabled?: boolean;
    secrets_bundle?: boolean;
    /** 오퍼레이터가 비밀 작업을 아는가(R26). null 이면 모름 */
    secrets_supported?: boolean | null;
    secrets?: SummarySecrets;
    dropped?: Dropped;
    top_names?: string[];
    /** main 이 아닌 대상에서 옮기지 않은 채널 연결 파일 이름(OMAI-1444 DD3·R8). 비밀 묶음에서 빠진다 */
    channel_files_skipped?: string[];
  };
  result: {
    done_at?: string;
    secrets_needed?: string[];
    paused_cron?: number;
    pc_path_jobs?: string[];
    os_only_skills?: string[];
    mcp_relogin?: number;
    link_skills?: string[];
    env_added?: string[];
    env_failed?: { name: string; reason: string }[];
    env_skipped?: EnvSkip[];
    secrets_replaced?: string[];
    secrets_added?: string[];
    secrets_list_unreadable?: boolean;
    secrets_unsupported?: boolean;
    secrets_rolled_back?: boolean;
    changed_after_confirm?: boolean;
    /** 다시 연결할 채널 수(= channel_files_skipped 수, OMAI-1444 DD3) */
    channels_to_reconnect?: number;
    /** 내보내기 때 가려진 기본 스킬 되돌리기(스펙 2026-10-27-011 R11·R12). 목록은 데이터 폴더 기준 상대경로(profiles/<p>/skills/…) */
    bundled_repaired_n?: number;
    bundled_repaired?: string[];
    bundled_kept?: string[];
    bundled_list_unreadable?: boolean;
    bundled_repair_unsupported?: boolean;
    bundled_repair_error?: string;
  };
  reason: string;
  error: string;
  created: string;
  updated: string;
  backup_days: number;
  stages: string[];
  keeps?: Keeps;
}

export interface StatusResp {
  job: Job | null;
  profile: string;
  owner: string;
  /** 주인의 사람 이름(2026-10-30) */
  owner_name?: string;
  /** 같은 AI 에이전트 작업공간에서 가져오는 중인 다른 프로파일(OMAI-1444 DD6·R3). 그동안 놓기·시작을 막는다 */
  busy_profile?: string;
}

/** 가져오기 임시 프로파일 이름의 앞머리(pc_import.temp_profile). 이 프로파일에는 단추를 두지 않는다(OMAI-1444 OV10) */
export const TEMP_PREFIX = 'pcimp-';

/** 「{name} 내용 바꾸기」 같은 단추의 이름 칸: 24자를 넘으면 말줄임표(OMAI-1444 DD2). 전체 이름은 툴팁·aria-label 에 둔다 */
export const shortName = (name: string, max = 24): string => (name.length > max ? `${name.slice(0, max - 1)}…` : name);

/** 공용 스킬 수와 원본 프로파일(내보내기 응답, OMAI-1444 R16) */
export interface SharedSkills {
  n: number;
  sources: string[];
}

/** 서버가 거절한 요청. code 로 문장을 고른다. extra 는 limit·used·quota 같은 값 */
export class PcError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(errText(code, extra));
    this.name = 'PcError';
  }
}

/** 오류 코드 → 화면 문장. 모르는 코드는 일반 문장 */
export function errText(code: string, extra: Record<string, unknown> = {}): string {
  const key = `profiles.pcImport.err.${code}`;
  const vars = {
    limit: typeof extra.limit === 'number' ? mb(extra.limit) : '',
    used: typeof extra.used === 'number' ? mb(extra.used) : '',
    quota: typeof extra.quota === 'number' ? mb(extra.quota) : '',
  };
  return hasKey(key) ? t(key, vars) : t('profiles.pcImport.err.unknown');
}

/** 「n MB」. 진행 막대와 크기 표시가 같이 쓴다 */
export const mb = (n: number): string => `${(Math.max(0, n) / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;

const q = (o: Record<string, string>) => new URLSearchParams(o).toString();

async function call<T>(method: 'GET' | 'POST', url: string): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, {
      method,
      headers: method === 'GET' ? { 'Accept-Language': getLang() } : { 'X-AAS': '1', 'Accept-Language': getLang() },
    });
  } catch {
    throw new PcError('agent_unreachable', 0);
  }
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new PcError(String(body.code || 'unknown'), r.status, body);
  return body as T;
}

export const statusUrl = (pod: string, profile: string) => `/api/profile/pc-import?${q({ pod, profile })}`;
export const getStatus = (pod: string, profile: string) => call<StatusResp>('GET', statusUrl(pod, profile));
export const startImport = (pod: string, id: string) =>
  call<{ job: Job }>('POST', `/api/profile/pc-import/start?${q({ pod, id })}`);
export const cancelImport = (pod: string, id: string) =>
  call<{ ok: boolean }>('POST', `/api/profile/pc-import/cancel?${q({ pod, id })}`);
export const exportMain = (pod: string, profile: string) =>
  call<{ id: string; size: number; profile: string; shared_skills?: SharedSkills }>('POST', `/api/profile/pc-export?${q({ pod, profile })}`);
/** 내려받기 주소. 브라우저가 디스크로 받게 a[href] 로 연다(메모리에 올리지 않는다). 다 받으면 서버가 지운다 */
export const exportUrl = (pod: string, id: string) => `/api/profile/pc-export?${q({ pod, id })}`;

/** 진행 중이면 이 간격으로 다시 읽는다. 끝난 상태면 멈춘다. 다른 프로파일이 가져오는 중이어도 다시 읽어 끝나면 막기를 푼다(OMAI-1444 OV3) */
export const POLL_MS = 2500;
export const pollEvery = (data?: StatusResp | null): number | false =>
  data?.job?.state === 'running' || data?.busy_profile ? POLL_MS : false;

export const pcImportKey = (pod: string | undefined, profile: string) => ['pc-import', pod ?? '', profile];

/** 마지막 가져오기. 서랍 머리 단추(진행 중이면 막기)와 서랍 본문이 같은 키를 쓴다(서랍을 다시 열면 같은 화면, D6) */
export function usePcImport(pod: string | undefined, profile: string, enabled: boolean) {
  return useQuery<StatusResp, PcError>({
    queryKey: pcImportKey(pod, profile),
    queryFn: () => getStatus(pod as string, profile),
    enabled: enabled && !!pod,
    refetchInterval: (query) => pollEvery(query.state.data),
    retry: false,
  });
}

export interface UploadHandle {
  done: Promise<Job>;
  abort: () => void;
}

/** 묶음 하나를 올린다(XHR — 진행률을 받는다). 끝나면 서버 검사 결과(Job & keeps), 거절되면 PcError */
export function uploadArchive(pod: string, profile: string, file: File, onProgress: (loaded: number, total: number) => void): UploadHandle {
  const xhr = new XMLHttpRequest();
  const done = new Promise<Job>((resolve, reject) => {
    xhr.open('PUT', `/api/profile/pc-import?${q({ pod, profile, name: file.name })}`);
    xhr.setRequestHeader('X-AAS', '1');
    xhr.setRequestHeader('Accept-Language', getLang());
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(xhr.responseText || '{}');
      } catch {
        /* 본문 없는 오류 */
      }
      if (xhr.status === 200 && body.id) resolve(body as unknown as Job);
      else reject(new PcError(String(body.code || (xhr.status === 429 ? 'busy' : 'unknown')), xhr.status, body));
    };
    xhr.onerror = () => reject(new PcError('agent_unreachable', 0));
    xhr.onabort = () => reject(new PcError('aborted', 0));
    xhr.send(file);
  });
  return { done, abort: () => xhr.abort() };
}

// ---- OS 와 명령 ---------------------------------------------------------------------------------------------
export type Os = 'mac' | 'linux' | 'windows';
export const OSES: Os[] = ['mac', 'linux', 'windows'];

/** 브라우저 정보로 PC 의 OS 를 미리 고른다. 맥을 먼저 본다(「darwin」에 「win」이 들어 있다) */
export function detectOs(nav: { userAgent?: string; platform?: string; userAgentData?: { platform?: string } } = navigator): Os {
  const s = [nav.userAgentData?.platform, nav.platform, nav.userAgent].filter(Boolean).join(' ').toLowerCase();
  if (/mac|darwin|iphone|ipad/.test(s)) return 'mac';
  if (/win/.test(s)) return 'windows';
  return 'linux';
}

/** 프로파일 이름 칸 값. Hermes 프로파일 이름에 쓰는 글자만 남기고, 비면 default */
export const pcProfile = (raw: string): string => raw.trim().replace(/[^A-Za-z0-9_.-]/g, '') || 'default';

export const archiveName = (profile: string) => `hermes-${profile}.tar.gz`;

export const exportCommand = (os: Os, profile: string): string =>
  os === 'windows'
    ? `hermes profile export ${profile} -o $env:USERPROFILE\\${archiveName(profile)}`
    : `hermes profile export ${profile} -o ~/${archiveName(profile)}`;

export const outputPath = (os: Os, profile: string): string =>
  os === 'windows' ? `%USERPROFILE%\\${archiveName(profile)}` : `~/${archiveName(profile)}`;

export const isArchive = (name: string) => /\.(tar\.gz|tgz)$/i.test(name);

/** 크기·파일 수 초과일 때 sessions 를 빼고 다시 묶는 명령(Hermes 정식 기능이 아니다, D8).
 * 최상위 폴더 하나만 다시 묶는다 — `-C 폴더 .` 로 묶으면 「.」 항목이 생겨 서버 검사(최상위 폴더 하나)가 거절한다 */
export function repackCommand(os: Os, file: string): string {
  const small = file.replace(/\.(tar\.gz|tgz)$/i, '') + '-small.tar.gz';
  return os === 'windows'
    ? [
        `cd $env:USERPROFILE; mkdir hermes-repack; tar -xzf ${file} -C hermes-repack`,
        'Remove-Item -Recurse -Force hermes-repack\\*\\sessions',
        `Push-Location hermes-repack; tar -czf ..\\${small} (Get-ChildItem -Name); Pop-Location`,
      ].join('\n')
    : [
        `cd ~ && mkdir hermes-repack && tar -xzf ${file} -C hermes-repack`,
        'rm -rf hermes-repack/*/sessions',
        `cd hermes-repack && tar -czf ../${small} * && cd ..`,
      ].join('\n');
}

/** PC 에서 비밀값을 찾는 명령(§5-1 단계 2·3·4·4-1) */
export function findCommands(os: Os, name: string): { config: string; envPath: string; grep: string; open: string } {
  const win = os === 'windows';
  return {
    config: 'hermes config',
    envPath: 'hermes config env-path',
    grep: win ? `Select-String -Path (hermes config env-path) -Pattern '^${name}='` : `grep '^${name}=' "$(hermes config env-path)"`,
    open: win ? 'notepad (hermes config env-path)' : os === 'mac' ? 'open -e "$(hermes config env-path)"' : 'nano "$(hermes config env-path)"',
  };
}

/** AAS 에서 내보낸 묶음을 PC 의 default 에 넣는 명령(§5-2). 맥·리눅스는 같다. file 은 내려받은 파일 이름 */
export function applyCommands(os: Os, file: string): Record<'backup' | 'clean' | 'unpack' | 'cron' | 'check', string> {
  if (os === 'windows')
    return {
      backup: 'hermes profile export default -o $env:USERPROFILE\\hermes-default-backup.tar.gz',
      clean:
        'Push-Location (Split-Path (hermes config env-path)); Remove-Item state.db-wal,state.db-shm,gateway.pid,gateway_state.json -ErrorAction SilentlyContinue; Pop-Location',
      unpack: `tar -xzf $env:USERPROFILE\\Downloads\\${file} -C (Split-Path (hermes config env-path)) --strip-components=1`,
      cron: 'hermes cron list\nhermes cron pause <id>',
      check: 'hermes config',
    };
  return {
    backup: 'hermes profile export default -o ~/hermes-default-backup.tar.gz',
    clean: 'cd "$(dirname "$(hermes config env-path)")" && rm -f state.db-wal state.db-shm gateway.pid gateway_state.json',
    unpack: `tar -xzf ~/Downloads/${file} -C "$(dirname "$(hermes config env-path)")" --strip-components=1`,
    cron: 'hermes cron list\nhermes cron pause <id>',
    check: 'hermes config',
  };
}

/** main 이 아닌 프로파일의 묶음을 PC 에 새 프로파일로 넣는 명령(OMAI-1444 DD11·R13). Hermes 는 같은 이름이 있으면 거절한다
 * (345cd2b profiles.py:1646-1648) — 그래서 기본은 새 이름. -p 는 모든 hermes 명령이 받는 프로파일 고르기다 */
export function importCommands(os: Os, file: string, name: string): Record<'import' | 'cron' | 'check', string> {
  const path = os === 'windows' ? `$env:USERPROFILE\\Downloads\\${file}` : `~/Downloads/${file}`;
  return {
    import: `hermes profile import ${path} --name ${name}`,
    cron: `hermes -p ${name} cron list\nhermes -p ${name} cron pause <id>`,
    check: `hermes -p ${name} config`,
  };
}

/** PC 에 같은 이름 프로파일이 있을 때 바꾸는 순서: 보관(꼭 먼저) → 지우기 → 넣기(OMAI-1444 R13) */
export function replaceCommands(os: Os, file: string, name: string): Record<'backup' | 'remove' | 'import', string> {
  const win = os === 'windows';
  return {
    backup: win
      ? `hermes profile export ${name} -o $env:USERPROFILE\\hermes-${name}-backup.tar.gz`
      : `hermes profile export ${name} -o ~/hermes-${name}-backup.tar.gz`,
    remove: `hermes profile delete ${name}`,
    import: importCommands(os, file, name).import,
  };
}

// ---- 진행 단계 ---------------------------------------------------------------------------------------------
/** 화면의 단계 줄: 검사 · 가져오기 · 사본 · 바꾸기 · 기본 스킬 맞추기 · 재시작. 비밀 묶음이 있으면 바꾸기 뒤에 인증 파일 · 비밀값을 더한다(DD14).
 *  기본 스킬 맞추기는 내보내기 때 가려진 기본 스킬을 되돌리는 단계다(스펙 2026-10-27-011 D10) */
export function stageKeys(withSecrets: boolean): string[] {
  return ['check', 'import', 'copy', 'replace', ...(withSecrets ? ['secrets', 'env'] : []), 'skills', 'restart'];
}

export const stageLabels = (withSecrets = false): string[] => stageKeys(withSecrets).map((k) => t(`profiles.pcImport.stage.${k}`));

/** 서버가 보낸 단계 목록에 secrets 가 있는가(비밀 묶음이 있는 가져오기) */
export const hasSecretStages = (job: Pick<Job, 'stages'> | null | undefined): boolean => !!job?.stages?.includes('secrets');

export type RowState = 'done' | 'now' | 'wait';

/** 서버 stage → 줄 번호. replace 는 오퍼레이터 작업 하나가 사본과 바꾸기를 함께 하므로 둘 다 진행 중이다 */
function rowsOf(stage: JobStage, withSecrets: boolean): number[] {
  const keys = stageKeys(withSecrets);
  if (stage === 'check') return [0];
  if (stage === 'replace') return [2, 3];
  if (stage === 'secrets' || stage === 'env') return withSecrets ? [keys.indexOf(stage)] : [3];
  if (stage === 'skills') return [keys.indexOf('skills')];
  if (stage === 'restart' || stage === 'cleanup') return [keys.length - 1];
  return [1];
}

/** 서버 stage → 줄마다 상태. 검사는 시작 전에 끝났다 */
export function stageRows(stage: JobStage, withSecrets = false): RowState[] {
  const now = rowsOf(stage === 'check' ? 'import' : stage, withSecrets);
  const first = Math.min(...now);
  return stageKeys(withSecrets).map((_, i) => (now.includes(i) ? 'now' : i < first ? 'done' : 'wait'));
}

/** 실패한 단계 이름(되돌림 화면의 다음 줄) */
export function stageName(stage: JobStage, withSecrets = false): string {
  const labels = stageLabels(withSecrets);
  const rows = rowsOf(stage, withSecrets);
  return labels[rows[rows.length - 1]] ?? '';
}

/** 거절 이유 → 문장 갈래(§10-4, 2026-10-22-003 R2·R3·DD17). 묶음 모양이 틀리면 다시 내보내기, 크기·개수 초과면 다시 묶기,
 * 저장 실패면 다시 올리기, 옛 규칙(credential·link·plugins)으로 거절된 기록은 「다시 올리면 걸러서 받습니다」 */
export function rejectKind(reason: string): 'archive' | 'size' | 'retry' | 'oldRule' | 'noContent' {
  if (reason === 'credential' || reason === 'plugins' || reason === 'link') return 'oldRule';
  if (reason === 'store_failed') return 'retry';
  if (reason === 'no_content') return 'noContent';
  if (reason === 'too_big' || reason === 'too_many') return 'size';
  return 'archive';
}

// ---- 이름 목록 ---------------------------------------------------------------------------------------------
/** 이름 목록 한 줄(DD21·DD22): 처음 3개만, 나머지는 「외 N개」로 펼친다. total 은 개수 필드(*_count)이고
 * 서버가 담은 이름보다 많으면 끝에 「외 n개(이름 생략)」 */
export function namesLine(names: string[], total: number, open: boolean): { shown: string[]; more: number; omitted: number } {
  const all = names ?? [];
  const omitted = Math.max(0, total - all.length);
  const shown = open ? all : all.slice(0, 3);
  return { shown, more: open ? 0 : Math.max(0, all.length - shown.length), omitted: open || all.length <= 3 ? omitted : 0 };
}

/** 이름 안의 `/`·`.`·`-` 뒤에 줄바꿈 자리를 둔다(DD22, 긴 경로가 서랍을 넘지 않게) */
export const breakable = (name: string): string => name.replace(/([/.-])/g, '$1\u200b');

/** 확인 화면의 비밀 갈래(DD12·DD13·DD8·R23): 비밀 묶음 없음 · http · 미지원 · 모름 · 옮김 */
export function secretsMode(job: Job): 'none' | 'off' | 'unsupported' | 'unknown' | 'move' {
  const s = job.summary ?? ({} as Job['summary']);
  if (s.secrets_enabled === false && (s.dropped?.secrets_off ?? 0) > 0) return 'off';
  if (!s.secrets_bundle) return 'none';
  if (s.secrets_supported === false) return 'unsupported';
  if (s.secrets_supported == null || !job.keeps?.secrets_plan?.known) return 'unknown';
  return 'move';
}

/** 결과 화면의 「아직 할 일 → 비밀값」 이름: 필요한 키 + 넣지 못한 키 + 읽을 수 없음·확인하지 못함(DD10) */
export function secretsTodo(r: Job['result']): string[] {
  const out = new Set(r.secrets_needed ?? []);
  for (const f of r.env_failed ?? []) out.add(f.name);
  for (const s of r.env_skipped ?? []) if (s.reason === 'unreadable' || s.reason === 'unchecked') out.add(s.name);
  return [...out];
}
