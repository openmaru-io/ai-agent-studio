/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// AAS(2026-10-20-004 §6): 말풍선 오른쪽 위 모서리에 붙는 「대화」·「상세」 묶음 단추. 장면 위 HTML 이다(WebGL 말풍선 안에는 단추를 넣을 수 없다).
// 전에는 따로 떨어진 두 알약이 말풍선 가운데 위에 떠 있었고 아이콘·마우스 올림·포커스 표시가 없었다.
// 아이콘은 명단 HUD 의 같은 동작(OfficeHud 의 ChatBubbleOutline·InfoOutlined)과 같다. 판 색·윤곽선은 말풍선과 같다.
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import ButtonBase from "@mui/material/ButtonBase";
import Box from "@mui/material/Box";

import { FOCUS_RING } from "@/lib/shellTokens";

type Action = "chat" | "detail";

const ITEMS: { action: Action; Icon: typeof ChatBubbleOutlineIcon }[] = [
  { action: "chat", Icon: ChatBubbleOutlineIcon },
  { action: "detail", Icon: InfoOutlinedIcon },
];

export function BubbleActions({
  labels,
  onAction,
  active,
  onHoverChange,
}: {
  labels: Record<Action, string>;
  onAction: (action: Action) => void;
  /** 이름표 호버(2026-10-20-007): 마우스가 있는 이름표 쪽(위 = 대화, 아래 = 상세)의 칸을 밝게 표시한다 */
  active?: Action | null;
  /** 묶음 위에 마우스가 들어오고 나감. 이름표 호버에서 단추로 옮기는 동안 닫지 않는 데 쓴다 */
  onHoverChange?: (hover: boolean) => void;
}) {
  return (
    <Box
      role="group"
      // 누름이 장면(에이전트 고르기·카메라)으로 새지 않게 막는다
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
      sx={{
        display: "inline-flex",
        alignItems: "stretch",
        height: 22,
        borderRadius: "7px",
        border: "1px solid rgba(255,255,255,0.14)",
        bgcolor: "rgba(27,31,38,0.92)", // 말풍선 판(LABEL_PLATE_COLOR #1b1f26)
        overflow: "hidden",
        whiteSpace: "nowrap",
        boxShadow: "0 1px 2px rgba(0,0,0,0.35)",
      }}
    >
      {ITEMS.map(({ action, Icon }, i) => (
        <ButtonBase
          key={action}
          onClick={() => onAction(action)}
          data-active={active === action ? "true" : undefined}
          sx={{
            gap: "4px",
            px: "8px",
            font: "inherit",
            fontSize: 11,
            lineHeight: 1,
            // 이름표 호버(active 가 있을 때): 고른 칸은 바탕 16%·밝은 글자, 다른 칸은 글자를 흐리게 해 차이를 분명히 한다
            color: active && active !== action ? "#8a919c" : "#c3c8d0",
            borderLeft: i ? "1px solid rgba(255,255,255,0.12)" : "none",
            "&:hover": { bgcolor: "rgba(255,255,255,0.08)", color: "#f7f8f8" },
            "&[data-active='true']": { bgcolor: "rgba(255,255,255,0.16)", color: "#f7f8f8" },
            "&:active": { bgcolor: "rgba(255,255,255,0.14)" },
            "&.Mui-focusVisible": { outline: `2px solid ${FOCUS_RING}`, outlineOffset: -2 },
          }}
        >
          <Icon sx={{ fontSize: 13 }} />
          {labels[action]}
        </ButtonBase>
      ))}
    </Box>
  );
}
