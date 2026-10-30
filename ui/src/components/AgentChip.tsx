/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 에이전트 이름 칩: 「● 이름」. 점 색은 이름 글자로 정해(hueOf) 어느 화면에서나 같은 에이전트는 같은 색이다.
// 표시 전용이다. 눌러야 하는 곳은 바깥의 버튼·링크 안에 넣는다. 이름은 한 글자열 한 노드로 그려 글자 검색이 그대로 맞는다.
import { Box } from '@mui/material';
import { visuallyHidden } from '@mui/utils';
import { ReactNode } from 'react';

import { useChatTokens } from '@/components/chat/useChatTokens';
import { chatMetrics, chatType, hueOf } from '@/lib/chatTokens';

/** 8px 색 점. 이름이 같으면 색이 같다. 보조기기에는 숨긴다(이름 글자가 이미 있다). */
export function AgentDot({ name }: { name: string }) {
  return <Box aria-hidden="true" component="span" sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: hueOf(name), flexShrink: 0 }} />;
}

export type AgentChipSize = 'sm' | 'md';
/** pill=에이전트(알약), square=프로파일(모서리 4px). 점 색 계산은 같다. */
export type AgentChipShape = 'pill' | 'square';

/** colorKey: 점 색을 정할 글자. 제목을 보이더라도 3D 이름표와 같은 색이 되게 별칭을 넘긴다. 없으면 보이는 이름이다. */
export function AgentChip({
  name,
  colorKey,
  size = 'md',
  shape = 'pill',
  dim,
  title,
}: {
  name: string;
  colorKey?: string;
  size?: AgentChipSize;
  shape?: AgentChipShape;
  dim?: boolean;
  title?: string;
}) {
  const tk = useChatTokens();
  const sm = size === 'sm';
  return (
    <Box
      component="span"
      data-agent-chip={shape === 'square' ? 'profile' : ''}
      title={title}
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: sm ? 0.5 : 0.75,
        verticalAlign: 'middle',
        minWidth: 0,
        maxWidth: chatMetrics.chipMax,
        height: sm ? 20 : undefined,
        px: sm ? 1 : 1.25,
        py: sm ? 0 : 0.5,
        borderRadius: shape === 'square' ? '4px' : 999,
        fontSize: sm ? chatType.meta : chatType.meta + 1,
        lineHeight: 1.3,
        border: `1px solid ${tk.line}`,
        color: tk.text,
        opacity: dim ? 0.45 : 1,
      }}
    >
      <AgentDot name={colorKey ?? name} />
      <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {name}
      </Box>
    </Box>
  );
}

/** 프로파일 칩: 에이전트 칩과 같은 점 색에 모서리 4px 사각. */
export function ProfileChip(props: Omit<Parameters<typeof AgentChip>[0], 'shape'>) {
  return <AgentChip {...props} shape="square" />;
}

/** 설치본 목록 → {id: 에이전트 이름}. 이름을 짓지 않은 설치본은 넣지 않는다(칩이 id 를 그대로 보인다). */
export function podLabels(pods: { id: string; name?: string }[] | undefined): Record<string, string> {
  return Object.fromEntries((pods ?? []).filter((p) => p.name).map((p) => [p.id, p.name as string]));
}

/** 에이전트 여러 개: 줄바꿈하며 나열하고 max(기본 4) 개를 넘으면 「+N」 으로 줄인다.
 *  names 는 설치본 id, labels 가 있으면 칩에는 그 이름을 보이고 id 는 풍선말·점 색 기준으로 둔다(스펙 2026-10-18-011).
 *  표 칸용 옵션(스펙 2026-10-19-006 DD8~DD10): shape 는 칩 모양(프로파일은 square), nowrap 은 한 줄(칩은 56~88px 사이에서 줄며 말줄임,
 *  lead·「+N」은 줄지 않는다), lead 는 첫 칩 앞의 표시, moreLabel 은 「+N」을 낭독기에 읽힐 글(있으면 「+N」 글자는 낭독기에서 숨긴다). */
export function AgentChips({
  names,
  labels,
  size = 'sm',
  max = 4,
  shape = 'pill',
  nowrap = false,
  lead,
  moreLabel,
}: {
  names: string[];
  labels?: Record<string, string>;
  size?: AgentChipSize;
  max?: number;
  shape?: AgentChipShape;
  nowrap?: boolean;
  lead?: ReactNode;
  moreLabel?: (rest: string[]) => string;
}) {
  const shown = names.slice(0, max);
  const hidden = names.slice(max).map((n) => labels?.[n] || n);
  return (
    <Box
      component="span"
      sx={{ display: 'inline-flex', flexWrap: nowrap ? 'nowrap' : 'wrap', gap: 0.5, alignItems: 'center', ...(nowrap ? { minWidth: 0, maxWidth: '100%' } : {}) }}
    >
      {lead}
      {shown.map((n) => {
        const chip = <AgentChip key={n} name={labels?.[n] || n} colorKey={n} title={labels?.[n] ? n : undefined} size={size} shape={shape} />;
        // 한 줄일 때 칩은 56~88px 사이에서 줄어든다 — 160px 칸에서 칩이 점만 남던 것(Profiles.tsx 의 같은 버그, DD8).
        // 짧은 이름(6자 이하, main·ops 등)은 줄이지 않는다 — 모두 고르게 줄면 「main」이 「m…」이 됐다(가짜 서버 캡처 2026-10-19)
        const short = (labels?.[n] || n).length <= 6;
        return nowrap ? (
          <Box key={n} component="span" data-chip-slot="" sx={{ display: 'flex', flex: short ? '0 0 auto' : '0 1 auto', minWidth: short ? undefined : 56, maxWidth: 88 }}>
            {chip}
          </Box>
        ) : (
          chip
        );
      })}
      {hidden.length > 0 && (
        <>
          <Box
            component="span"
            title={hidden.join(', ')}
            aria-hidden={moreLabel ? true : undefined}
            sx={{ fontSize: chatType.meta, color: 'text.secondary', flexShrink: 0 }}
          >
            +{hidden.length}
          </Box>
          {moreLabel && (
            <Box component="span" sx={visuallyHidden}>
              {moreLabel(hidden)}
            </Box>
          )}
        </>
      )}
    </Box>
  );
}
