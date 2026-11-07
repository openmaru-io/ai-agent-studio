/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// LLM 가드 거절 인식(OMAI-1857, cogentai-aas-docs docs-plan/deploy/field-report-20261105-six-issues.md 디자인 D17·재검토 M6).
// 사용자 Hermes 이미지의 가드가 허용 목록 밖 LLM 호출을 403 과 이 구절로 거절한다. 서버 aas/ops/llm_block.py 와 같은 구절이고,
// 두 언어의 시험이 tests/fixtures/llm_guard_block.txt(가드가 OKE 카나리에서 실제로 낸 문구)를 함께 읽는다.
// 모델 답 본문은 보지 않는다 — 오류 이벤트에만 쓴다(M6, 답이 이 구절을 인용해도 안내로 바뀌지 않게).
// 도구 결과는 실패한 도구에서만 본다(스펙 2026-11-07-001 E2) — 성공한 명령의 출력(문서 읽기 등)이 구절을 담아도 안내로 바꾸지 않는다.
// 구절은 ASCII 앞부분만 본다: json.dumps 기본값이면 한글이 \uXXXX 로 바뀌어 전체 문장 비교가 실패한다(외부 검토 M2).
export const LLM_BLOCK_MARK = 'BLOCKED by CogentAI AAS';

export const isLlmBlocked = (text?: string | null): boolean => !!text && text.includes(LLM_BLOCK_MARK);

/** 실패한 도구 결과의 error·output·stderr 중 하나에 가드 구절이 있는가(E2). 성공한 도구는 늘 거짓 */
export const isLlmBlockedTool = (failed: boolean, fields: { error?: unknown; output?: unknown; stderr?: unknown }): boolean =>
  failed && [fields.error, fields.output, fields.stderr].some((v) => typeof v === 'string' && isLlmBlocked(v));
