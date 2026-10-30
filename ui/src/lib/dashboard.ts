/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 대시보드(계획 2026-10-14-014)의 값 모양과 화면 밖 계산: 표 순서·거름, 오래된 값, 새로고침 뒤 자리 되찾기.
export interface PodValues {
  profiles: number;
  gateways_up: number;
  /** 연결된 메신저 수와 전체 수(텔레그램·슬랙 등, api_server 제외). 옛 기록은 null — 게이트웨이가 실행 중이어도 메신저가 없을 수 있다(2026-10-18) */
  messengers_connected?: number | null;
  messengers_total?: number | null;
  profiles_bad: number;
  creds_expiring: number;
  jobs: number;
  jobs_active: number;
  failed_jobs: number;
  stalled_jobs: number;
  open_incidents: number;
}

export interface DashPod {
  id: string;
  /** 에이전트 이름(HermesAgent displayName). 없으면 빈 값이고 화면이 id 를 보인다(2026-10-18-013) */
  name?: string;
  /** 관리자에게만 온다 */
  owner?: string;
  /** 주인 표시 이름(관리자에게만, 2026-10-18). 칸에는 이름을, 이메일은 풍선말로 */
  owner_name?: string;
  owner_me: boolean;
  ready: boolean;
  phase: string;
  collected: boolean;
  ok: boolean;
  reason: string;
  /** 값을 마지막으로 읽은 시각(수집에 실패해도 지난 값의 시각) */
  ts: string | null;
  /** 마지막으로 수집을 시도한 시각 */
  checked: string | null;
  stale: boolean;
  values: PodValues | null;
  last_day: string | null;
}

export interface TrendDay {
  day: string;
  jobs?: number;
  runs_7d?: number;
  failed_jobs?: number;
  stalled?: number;
  open_incidents?: number;
  collect_errors?: number;
}

export interface UsageDay {
  day: string;
  sessions: number;
  messages: number;
  input_tokens: number;
  output_tokens: number;
}

export interface DashOps {
  users: number;
  last_login: string | null;
  litellm: { reachable: boolean; error?: string; ts?: string } | null;
  /** 마켓 설치를 끈 환경이면 없다 */
  market: { alive: boolean; last: string; error: string } | null;
  collect: { ts: string; seconds: number; pods: { ok: number; total: number; failed: unknown[] } } | null;
}

export interface Dashboard {
  admin: boolean;
  now: string;
  next_collect: string;
  collected_at: string | null;
  pods: DashPod[];
  totals: {
    agents_ready: number;
    agents_total: number;
    failed_stalled: number;
    profiles_bad: number;
    creds_expiring: number;
    counted: number;
    countable: number;
    failed: number;
  };
  trend: TrendDay[];
  usage: UsageDay[];
  ops?: DashOps;
}

export type PodFilter = 'all' | 'failing' | 'profiles' | 'collect';

const problems = (p: DashPod) =>
  p.values ? p.values.failed_jobs + p.values.stalled_jobs + p.values.profiles_bad + p.values.creds_expiring : 0;

/** 표 순서: 문제 수가 많은 것 → 수집 실패 → 준비 중 → 이름(디자인 DD11 「문제 수 내림차순」). */
export function sortPods(pods: DashPod[]): DashPod[] {
  const failedCollect = (p: DashPod) => (p.ready && p.collected && !p.ok ? 1 : 0);
  return [...pods].sort(
    (a, b) =>
      problems(b) - problems(a) ||
      failedCollect(b) - failedCollect(a) ||
      Number(b.ready) - Number(a.ready) ||
      a.id.localeCompare(b.id)
  );
}

export function filterPods(pods: DashPod[], f: PodFilter): DashPod[] {
  if (f === 'failing') return pods.filter((p) => !!p.values && p.values.failed_jobs + p.values.stalled_jobs > 0);
  if (f === 'profiles') return pods.filter((p) => !!p.values && p.values.profiles_bad > 0);
  if (f === 'collect') return pods.filter((p) => p.ready && p.collected && !p.ok);
  return pods;
}

/** ts 가 now 보다 몇 시간 전인가(1시간 넘으면 「n시간 전 값」, 디자인 DD4). 1시간 이하·모름은 0. */
export function hoursOld(ts: string | null | undefined, now: string | number | Date = Date.now()): number {
  if (!ts) return 0;
  const age = new Date(now).getTime() - new Date(ts).getTime();
  return age > 3600_000 ? Math.floor(age / 3600_000) : 0;
}
