/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import { textWidthEm } from "./nameplate";
import { SPEECH_BUBBLE_BOTTOM, SPEECH_TAIL, speechBubbleLayout } from "./speechBubble";

const LONG =
  "다양한 도구 활용 프로세스 관리: 백그라운드 작업 실행 및 모니터링 현재 방에는 코드 리뷰·장애 분석을 담당하는 aas-agent-aas-test-a5f9, E2E 테스트를 담당하는 aas-e2e-test가 함께 있습니다. 필요한 작업이 있으면 말씀해 주세요. 그리고 추가로 확인할 내용이 더 있습니다.";

// 2026-10-20-003·004: 말풍선은 이름표가 펼쳐진 모양. 전에는 폭 1.8~4.6·글자 0.188~0.216 이었다
describe("speechBubbleLayout (2026-10-20-004)", () => {
  it("짧은 말은 한 줄, 좁은 판, 본문 글자 0.105", () => {
    const b = speechBubbleLayout("네, 확인했습니다.", "마케팅 도우미");
    expect(b.body.fontSize).toBeCloseTo(0.105, 5);
    expect(b.body.lines).toBe(1);
    expect(b.width).toBeLessThan(2.2);
    expect(b.width).toBeGreaterThanOrEqual(0.9);
    expect(b.truncated).toBe(false);
    expect(b.more).toBeNull();
  });

  it("긴 말은 최대 폭 2.2 에서 줄을 바꾸고 글자 크기는 그대로", () => {
    const b = speechBubbleLayout("백그라운드 작업 실행 및 모니터링을 담당합니다. 필요한 작업이 있으면 말씀해 주세요.", "a");
    expect(b.width).toBeCloseTo(2.2, 5);
    expect(b.body.lines).toBeGreaterThan(1);
    expect(b.body.lines).toBeLessThanOrEqual(5);
    expect(b.body.fontSize).toBeCloseTo(0.105, 5);
  });

  it("5줄을 넘는 말은 끝을 … 로 줄이고 잘림 안내 자리를 둔다", () => {
    const b = speechBubbleLayout(LONG, "마케팅 도우미");
    expect(b.truncated).toBe(true);
    expect(b.text.endsWith("…")).toBe(true);
    expect(b.body.lines).toBe(5);
    expect(b.more).not.toBeNull();
    // 남긴 글은 5줄 폭 안에 들어간다
    expect(textWidthEm(b.text) * b.body.fontSize).toBeLessThanOrEqual(5 * b.body.maxWidth * 0.92 + 1e-9);
  });

  it("꼬리 끝이 이름표 자리(머리 바로 위)에 오고 위로 자란다", () => {
    for (const t of ["...", "짧은 말", LONG]) {
      const b = speechBubbleLayout(t, "x");
      expect(b.y - b.height / 2 - SPEECH_TAIL.h).toBeCloseTo(SPEECH_BUBBLE_BOTTOM, 5);
    }
  });

  it("머리 줄(이름)은 본문 위에 있고, 본문·잘림 안내는 판 안에 있다", () => {
    const b = speechBubbleLayout(LONG, "마케팅 도우미");
    expect(b.header.name.text).toBe("마케팅 도우미");
    expect(b.header.name.y).toBeGreaterThan(b.body.y);
    const bodyBottom = b.body.y - b.body.lines * b.body.fontSize * b.body.lineHeight;
    expect(b.more!.y).toBeLessThan(bodyBottom);
    expect(b.more!.y - b.more!.fontSize / 2).toBeGreaterThan(-b.height / 2);
    expect(b.header.dot.x + b.header.dot.r).toBeLessThan(b.width / 2);
  });
});
