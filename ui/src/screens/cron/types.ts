/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Doc } from '@/components/TextEditor';

export interface Incident {
  id: string;
  job: string;
  job_id: string;
  profile: string;
  error?: string;
  now: 'ok' | 'off' | 'gone' | 'failing';
  state?: string;
  age_days?: number | null;
  last_seen_at?: string;
  new?: boolean;
  ack?: string;
  muted?: boolean;
}
export interface FailedJob {
  job: string;
  job_id: string;
  profile: string;
  schedule?: string;
  error?: string;
  streak: number;
  last_run_at?: string;
  deliver?: string;
  skills?: string[];
  muted?: boolean;
}
export interface StalledJob {
  job: string;
  job_id: string;
  profile: string;
  schedule?: string;
  kind: string;
  cause?: string;
  since?: string;
  hours: number;
  skills?: string[];
  muted?: boolean;
}
export interface SilentJob {
  job: string;
  job_id?: string;
  profile: string;
  schedule?: string;
  reason: string;
  delivery_error?: string;
  skills?: string[];
  muted?: boolean;
}
export interface MutedJob {
  profile: string;
  job_id: string;
  job: string;
  note?: string;
  ts?: string;
  by?: string;
  /** by 의 사람 이름(2026-10-30) */
  by_name?: string;
  failing?: boolean;
  incidents?: number;
}
export interface ProfileCron {
  name: string;
  open_incidents: number;
  failed_jobs: number;
  stalled_jobs: number;
  silent_jobs: number;
  jobs_total: number;
  jobs_active: number;
  runs_7d: number;
  runs_failed_7d: number;
  stale?: boolean;
  exec_status?: string;
  jobs_status?: string;
  detail?: string;
}
export interface CronHealth {
  collected_at: string;
  totals: {
    jobs: number;
    jobs_active: number;
    live_incidents: number;
    new_incidents: number;
    open_incidents: number;
    settled_incidents: number;
    failed_jobs: number;
    stalled: number;
    silent: number;
    stale_profiles: string[];
  };
  incidents: Incident[];
  failed_jobs: FailedJob[];
  stalled: StalledJob[];
  silent: SilentJob[];
  muted?: MutedJob[];
  profiles: ProfileCron[];
}
export interface JobData {
  can_edit: boolean;
  job: {
    id: string;
    name?: string;
    enabled: boolean;
    paused_at?: string | null;
    state?: string;
    schedule_display?: string;
    next_run_at?: string;
    last_run_at?: string;
    last_status?: string;
    failure_streak?: number;
    last_error?: string;
    deliver?: string;
    skills?: string[];
    skill?: string;
    script?: string;
    no_agent?: boolean;
  };
  targets?: { id: string; name: string; ready: boolean }[];
  runs: {
    started_at?: number | string;
    ended_at?: number | string;
    finished_at?: number | string;
    status?: string;
    tool_call_count?: number;
  }[];
  muted?: { ts?: string; by?: string; by_name?: string; note?: string } | null;
  note_doc?: Doc | null;
  prompt_doc: Doc;
}
export interface ExplainData {
  skill?: { id: string; name: string; where: string; description?: string; outline: { level: number; text: string }[] };
  root?: string;
  checks: { level: 'ok' | 'warn' | 'bad'; text: string }[];
  groups: {
    title: string;
    items: {
      label: string;
      sub?: string;
      summary?: string;
      by?: string;
      badges: string[];
      conf: string;
      observed?: number;
      tools: string[];
      evidence?: { file: string; line?: number; text?: string };
    }[];
  }[];
  observed?: { error?: string; hint?: string; days: number; scope: string; runs: number; matched: number };
}
