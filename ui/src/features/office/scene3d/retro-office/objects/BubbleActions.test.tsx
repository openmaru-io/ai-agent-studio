/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BubbleActions } from "./BubbleActions";

const labels = { chat: "대화", detail: "상세" };

// 2026-10-20-004 §6: 말풍선 위 단추를 한 묶음(아이콘 + 글자)으로. 명단 HUD 와 같은 동작·아이콘
describe("BubbleActions", () => {
  it("대화·상세 두 단추를 한 묶음(group)으로 보이고, 누르면 그 동작을 알린다", async () => {
    const onAction = vi.fn();
    render(<BubbleActions labels={labels} onAction={onAction} />);
    const group = screen.getByRole("group");
    expect(group).toContainElement(screen.getByRole("button", { name: "대화" }));
    await userEvent.click(screen.getByRole("button", { name: "대화" }));
    await userEvent.click(screen.getByRole("button", { name: "상세" }));
    expect(onAction.mock.calls).toEqual([["chat"], ["detail"]]);
  });

  it("단추마다 아이콘이 있다(명단과 같은 말풍선·정보 아이콘)", () => {
    render(<BubbleActions labels={labels} onAction={() => {}} />);
    expect(screen.getByTestId("ChatBubbleOutlineIcon")).toBeInTheDocument();
    expect(screen.getByTestId("InfoOutlinedIcon")).toBeInTheDocument();
  });

  it("누름이 장면(에이전트 고르기)으로 새지 않는다", () => {
    const outer = vi.fn();
    render(
      <div onPointerDown={outer} onClick={outer}>
        <BubbleActions labels={labels} onAction={() => {}} />
      </div>
    );
    const btn = screen.getByRole("button", { name: "대화" });
    fireEvent.pointerDown(btn);
    fireEvent.click(btn);
    expect(outer).not.toHaveBeenCalled();
  });

  it("active 로 준 칸을 밝게 표시하고(이름표 호버), 마우스 들고 남을 알린다", async () => {
    const onHoverChange = vi.fn();
    render(<BubbleActions labels={labels} onAction={() => {}} active="detail" onHoverChange={onHoverChange} />);
    expect(screen.getByRole("button", { name: "상세" })).toHaveAttribute("data-active", "true");
    expect(screen.getByRole("button", { name: "대화" })).not.toHaveAttribute("data-active");
    await userEvent.hover(screen.getByRole("group"));
    await userEvent.unhover(screen.getByRole("group"));
    expect(onHoverChange.mock.calls).toEqual([[true], [false]]);
  });
});
