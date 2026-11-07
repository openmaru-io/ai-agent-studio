/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Issue } from '@/components/bits';
import type { Doc } from '@/components/TextEditor';

export interface Channel {
  name: string;
  state?: string;
  stale?: boolean;
  attention?: boolean;
}
export interface ProfileRow {
  name: string;
  title?: string;
  description?: string;
  model?: string;
  is_default: boolean;
  /** 주 프로파일(main)을 쓰는 POD 의 루트 — 관리자에게만 「루트(숨김)」 읽기 전용으로 보인다(스펙 2026-10-14-003 리뷰 D8) */
  hidden_root?: boolean;
  /** 그 AI 에이전트 작업공간에서 이 프로파일에 PC 가져오기가 진행 중(OMAI-1444 DD4). 목록 응답에만 있다 */
  importing?: boolean;
  running: boolean | null;
  service_disabled?: boolean;
  jobs_active: number;
  jobs_total: number;
  failed_jobs: number;
  sessions_7d: number;
  skills: number;
  mcp: string[];
  creds: number;
  creds_expiring?: number;
  last_activity?: string | null;
  channels: Channel[];
  issues: Issue[];
}
export interface EnvVar {
  name: string;
  set: boolean;
  description?: string;
  /** 번역을 붙였을 때의 원문(스펙 2026-10-21-003 P2) */
  description_src?: string;
  channel?: boolean;
  category?: string;
  /** 주인 화면에서 서버가 막는 변수의 잠금 사유(빈 문자열이면 바꿀 수 있다, 디자인 결정 2C) */
  locked?: string;
}
export interface SkillItem {
  name: string;
  description?: string;
  /** 번역을 붙였을 때의 원문(스펙 2026-10-19-017 P5) */
  description_src?: string;
  enabled: boolean;
  usage?: number;
  provenance?: string;
  /** 분류. AAS 기본 스킬은 서버가 머리말 metadata.hermes.category 로 채운다(스펙 2026-10-27-007 R5) */
  category?: string;
}
/** OAuth MCP 서버 행의 로그인 상태(서버의 mcp_oauth_relay.decide, 스펙 2026-10-16-010 11-3·14-6) */
export interface McpLoginState {
  state: 'unknown' | 'login_required' | 'logging_in' | 'disabled_logged_in' | 'connected' | 'reauth_required' | 'connect_failed' | 'unavailable';
  /** logging_in: 지금 보는 사용자가 시작한 흐름인가 */
  mine?: boolean;
  /** logging_in: 로그인은 끝났고 게이트웨이가 붙기를 기다리는 중 */
  connecting?: boolean;
  tools?: number | null;
  message?: string;
  reason?: string;
}
export interface McpItem {
  name: string;
  transport?: string;
  target: string;
  env_names: string[];
  enabled: boolean;
  /** none·header·oauth. 옛 서버는 빈 값 */
  auth?: string;
  login_state?: McpLoginState | null;
  /** 관리자가 「이 환경에서 쓸 수 없음」 판정을 무시하고 추가했다(스펙 2026-10-16-010 V16) */
  forced?: boolean;
}
export interface ToolsetItem {
  name: string;
  label: string;
  description: string;
  tools: number;
  enabled: boolean;
  configured: boolean;
}
export interface SoulTemplateHint {
  use: {
    template_id: string;
    lang: string;
    rev: number;
    name: string;
    exists: boolean;
    current_rev: number | null;
    changed: boolean;
  } | null;
  is_default: boolean;
  department: string;
  recommend: { id: string; lang: string; name: string } | null;
}
/** 작업 지침(AGENTS.md)의 읽기 전용 사유. 서버가 우선순위대로 하나만 고른다(2026-10-19-004 D5) */
export type AgentsReadonlyReason = 'unsupported' | 'read_error' | 'link' | 'truncated' | 'masked' | 'hidden_root' | 'view_only';
/** 에이전트(Hermes)가 마지막으로 고치거나 지운 판. 확인 기록이 없을 때만 온다(D7·D19·D20) */
export interface AgentChange {
  id: number;
  at: string;
  deleted: boolean;
  /** 「바뀐 줄 보기」의 비교 기준: 마지막 사람 판(없으면 처음 본 판). 둘 다 쓸 수 없으면 null(단추를 숨긴다) */
  compare_id: number | null;
  /** 「이전 판으로 되돌리기」 대상: 마지막 사람 판. 사람 판이 없으면 null(되돌리기를 숨긴다) */
  revert_id: number | null;
}
/** 상세 응답의 agents. 읽기 오류여도 객체로 온다(그때 lines 는 비어 있을 수 있다) */
export interface AgentsDoc extends Doc {
  exists?: boolean;
  path?: string;
  readonly_reason?: AgentsReadonlyReason | null;
  /** Hermes 가 자르는 글자 수 한도(모르면 20000) */
  limit?: number;
  chars?: number;
  /** 지금 내용 기준 경고(크기). 저장을 막지 않는다 */
  warnings?: string[];
  agent_change?: AgentChange | null;
  /** 파일이 있는데 화면에서 사람이 저장한 판이 하나도 없다(D8) */
  never_saved?: boolean;
}
export interface ProfileDetailData {
  profile: ProfileRow;
  can_edit: boolean;
  /** 지금 POD 의 주인인가. 주인은 SOUL 과 스킬 켜고 끄기를 바꾼다(OMAI-1126, 스펙 2026-10-13-014) */
  owner?: boolean;
  /** 주인이거나 팀 관리자인가 — 편집 권한 판단은 owner 가 아니라 이 값을 쓴다(owner 는 「내 전용」 표시용, 스펙 2026-10-22-001). 옛 서버는 보내지 않는다 */
  manages?: boolean;
  /** 관리자가 남의 에이전트를 열 때만: 주인 표시 이름(이메일 전체는 아니다). 「<이름>님 전용」 태그에 쓴다(스펙 2026-10-15-011 D9) */
  owner_name?: string;
  /** 지울 수 있는가: 관리자, 또는 주인이고 마켓 에이전트 패키지로 만든 프로파일(리뷰 O4). 옛 서버는 보내지 않는다 */
  can_delete?: boolean;
  /** 이 프로파일을 만든 마켓 에이전트 패키지 id(없으면 '') */
  market_package?: string;
  /** 지울 수 있을 때만: 앉은 오피스 자리 수와 그 자리가 든 열린 방 수 */
  /** 탭별 권한과 막힌 이유 코드(서버가 정한다, 디자인 결정 1A). 문장은 capWhy 가 코드로 고른다 */
  caps?: Record<string, { can: boolean; reason: string }>;
  places?: { seats: number; rooms: number; channels?: number } | null;
  /** 이 프로파일로 열린 대화 수(이 서버 허브만, 숨김·회의 중계 포함). 지우면 함께 닫힌다(스펙 2026-11-07-001 디자인 3D·재검토 R2-3). 옛 서버는 없다 */
  open_chats?: number;
  /** SOUL 을 저장하면 알림이 갈 열린 방: 내가 구성원인 방 이름과 그 밖의 방 수(관리자·주인에게만) */
  rooms?: { names: string[]; others: number } | null;
  secure: boolean;
  notes: string[];
  /** 이 작업공간이 다시 뜨는 중(스펙 2026-10-23-008). 그동안 읽지 못한 부분은 notes 대신 안내 한 줄로 보인다 */
  restarting?: boolean;
  models: string[];
  /** 이 프로파일이 AAS LiteLLM 이 아닌 주소로 부르는 모델(OMAI-1857 D11). 옛 서버는 없다 */
  blocked_models?: string[];
  /** 지금 AAS 기본 모델 이름(서버 설정의 HERMES_LLM_MODEL). 모르면 빈 문자열 */
  default_model?: string;
  /** 이 프로파일의 게이트웨이를 루트 게이트웨이가 함께 돌린다(쿠버네티스의 이름 있는 프로파일, 2026-10-14) */
  gateway_shared?: boolean;
  soul?: Doc | null;
  /** SOUL 템플릿 적용 기록과 부서 추천(계획 2026-10-13-009) */
  soul_template?: SoulTemplateHint | null;
  config?: Doc | null;
  /** 작업 지침(AGENTS.md, 2026-10-19-004). 옛 서버는 보내지 않는다 */
  agents?: AgentsDoc | null;
  env?: EnvVar[] | null;
  skills?: SkillItem[] | null;
  mcp?: McpItem[] | null;
  toolsets?: ToolsetItem[] | null;
  /** 이 프로파일의 POD id. MCP OAuth 로그인 경로가 받는다 */
  pod?: string;
  /** 인가 서버에 등록할 AAS 콜백 주소(<AAS_PUBLIC_URL>/oauth/mcp/callback, V7) */
  mcp_oauth_callback?: string;
}
