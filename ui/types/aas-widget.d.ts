/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// CogentAI AAS 채팅 위젯의 공개 타입(cogentai-aas-docs security/chat-embed-save-answer 2026-11-18-012 D21⑤·D25⑩).
// 위젯 빌드가 aas/static/js/aas-widget.d.ts 로 복사하고, AAS 가 /static/js/aas-widget.d.ts 로 내보낸다.
// 페이지 코드에서: /// <reference path="./aas-widget.d.ts" /> 또는 tsconfig 의 files 에 넣는다.
// 값의 뜻은 위젯 연동 매뉴얼의 「답 저장」 장을 본다. 이 파일은 손으로 쓴다 — ui/src/embed 의 타입을 바꾸면 함께 고친다
// (ui/src/embed/aasWidgetTypes.test.ts 가 메서드·키·오류 코드가 어긋나면 실패한다).

declare namespace CogentAIAAS {
  type Lang = 'ko' | 'en';
  type Label = { ko: string; en: string };
  type SaveSource = 'registered' | 'page' | 'none';

  /** onSave 에 넘기는 값. source 로 나뉜다 */
  interface SaveAnswerBase {
    /** 답 원문(마크다운). 32,000자보다 길어도 자르지 않은 원래 답 */
    markdown: string;
    /** Hermes 에 저장된 대화 id. 아직 저장 전인 새 대화면 빈 문자열 */
    session: string;
    /** 답 글 해시. 같은 대화 순서에서 같은 글이면 같다 */
    answerKey: string;
    /** 답을 낸 AI 에이전트의 화면 이름 */
    agent: string;
    /** 저장 한 번마다 새로 만든다. 「다시 저장」은 같은 값 — 두 번 넣기를 거르는 키로 쓴다 */
    attemptId: string;
  }
  interface SaveAnswerRegistered extends SaveAnswerBase {
    source: 'registered';
    format: string;
    /** 등록 형식의 판(스키마나 채우는 법을 고칠 때마다 1 오름) */
    version: number;
    /** 스키마 꼴의 해시(서버가 계산). 형식이 바뀌었는지 볼 때 쓴다 */
    schemaHash: string;
    /** 사람이 확인·고친 값 */
    payload: Record<string, unknown>;
    /** 서버가 채운 시각(ISO 8601, UTC) */
    filledAt: string;
  }
  interface SaveAnswerPage extends SaveAnswerBase {
    source: 'page';
    format: null;
    version: null;
    schemaHash: string;
    payload: Record<string, unknown>;
    filledAt: string;
  }
  interface SaveAnswerNone extends SaveAnswerBase {
    source: 'none';
    format: null;
    version: null;
    schemaHash: null;
    payload: null;
    filledAt: null;
  }
  type SaveAnswerResult = SaveAnswerRegistered | SaveAnswerPage | SaveAnswerNone;

  /** onSave 가 거부할 때 던지는 값. retryable:false 면 위젯이 「다시 저장」을 숨긴다 */
  interface SaveAnswerRejection {
    message?: string;
    retryable?: boolean;
  }

  type SaveAnswerErrorCode =
    | 'saveAnswer.on_save_not_function'
    | 'saveAnswer.label_missing'
    | 'saveAnswer.label_too_long'
    | 'saveAnswer.format_and_schema'
    | 'saveAnswer.schema_invalid'
    | 'saveAnswer.lookup_failed';

  interface SaveAnswerError {
    code: SaveAnswerErrorCode;
    /** lookup_failed 면 서버 코드(detail.code)와 requestId */
    detail?: Record<string, unknown>;
    path?: string;
    keyword?: string;
  }

  interface SaveAnswerConfig {
    /** 등록 형식 id. schema 와 함께 줄 수 없다 */
    format?: string;
    /** 페이지 형식(JSON Schema). 임베드 앱이 「페이지가 형식을 넘길 수 있음」을 켰을 때만 */
    schema?: Record<string, unknown>;
    /** 페이지 형식의 채우는 법(4,000자까지) */
    instructions?: string;
    /** 단추 이름(각 40자). 페이지 형식·형식 없음에서 필요, 등록 형식은 관리자 이름을 쓴다 */
    label?: Label;
    onSave: (r: SaveAnswerResult) => void | { message?: string } | Promise<void | { message?: string }>;
    onError?: (e: SaveAnswerError) => void;
    /** onSave 를 기다리는 시간(ms). 기본 30,000, 최대 120,000 */
    timeoutMs?: number;
    /** false 면 setContext 의 페이지 문맥을 채우기에 보내지 않는다(기본 true) */
    sendContext?: boolean;
  }

  interface SaveAnswerState {
    state: 'ready' | 'pending' | 'disabled';
    code?: SaveAnswerErrorCode;
    detail?: Record<string, unknown>;
    path?: string;
  }

  interface StatusEvent {
    state: 'ready' | 'connecting' | 'error' | 'disconnected';
    code?: string;
    retryable?: boolean;
    action?: 'relogin' | 'retry' | 'open_aas' | 'contact_admin';
  }

  interface PageContext {
    source: 'mindwiki';
    title?: string;
    url: string;
    pageId: string;
    selection?: string;
  }

  interface Config {
    backendUrl?: string;
    accessToken?: string;
    accessTokenCookie?: string;
    getAccessToken?: () => string | Promise<string>;
    onLoginRequired?: () => void | Promise<unknown>;
    theme?: 'light' | 'dark';
    langCode?: Lang;
    position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
    width?: string;
    height?: string;
    title?: string;
    agent?: string;
    /** 처음 열 프로파일(그 에이전트에 없으면 채팅 기본) */
    profile?: string;
    showLauncher?: boolean;
    widgetInfo?: string;
    headerAction?: { label: Label; onClick: () => void };
    onStatusChange?: (s: StatusEvent) => void;
    onOpenChange?: (open: boolean) => void;
    /** 답 말풍선의 저장 단추(없거나 null 이면 단추 없음) */
    saveAnswer?: SaveAnswerConfig | null;
    [key: string]: unknown;
  }

  interface Widget {
    readonly features: string[];
    open(opts?: { rect?: { left: number; top: number; width: number; height: number } }): void;
    close(): void;
    toggle(): void;
    focus(): void;
    maximize(): void;
    restore(): void;
    destroy(): void;
    updateConfig(next: Partial<Config>): void;
    updateTheme(theme: 'light' | 'dark'): void;
    setLanguage(lang: Lang): void;
    getLanguage(): Lang;
    newConversation(): void;
    resetUserSession(): void;
    resizeEvent(e: UIEvent | null, width: number, height: number): void;
    sendMessage(message: string, displayMessage?: string, language?: Lang): boolean;
    setContext(ctx: PageContext | null): void;
    /** AI 에이전트(작업공간)와 프로파일을 바꿔 연다. features 에 'agent' 가 있을 때만 */
    setAgent(pod: string, profile?: string): void;
    /** 답 저장 단추의 지금 상태 */
    saveAnswerState(): SaveAnswerState;
  }

  interface Global {
    init(config?: Config): Widget;
    create(config?: Config): Widget;
    /** 서버·LLM 없이 saveAnswer 설정을 검사한다 */
    validateSaveAnswer(config: unknown): { ok: boolean; errors: SaveAnswerError[] };
  }
}

declare var CogentAIAASWidget: CogentAIAAS.Global;
