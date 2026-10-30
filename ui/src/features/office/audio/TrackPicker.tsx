/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 배경음악 곡 줄(스펙 2026-10-21-014 §5-5). 오피스 하단 메뉴와 설정 › 내 화면이 같은 묶음 순서·곡 줄 모양을 쓴다.
// 곡 줄 둘째 줄의 작곡자·라이선스가 CC BY 곡(Carefree)의 화면 출처 표기다.
// 설정 화면의 Select 는 자식마다 role=option·클릭 처리를 덮어써 묶음 제목(ListSubheader)도 선택지가 되므로, 묶음 대신 분위기를 둘째 줄에 붙인다.
import { Box, Typography } from '@mui/material';

import { t } from '@/i18n';

import { type Mood, MOODS, type Track, TRACKS } from './tracks';

export const moodLabel = (m: Mood) => t(`office.mood.${m}`);

/** 분위기 순서대로 묶은 곡 */
export const TRACK_GROUPS = MOODS.map((mood) => ({ mood, tracks: TRACKS.filter((x) => x.mood === mood) }));

/** 곡 이름, 둘째 줄에 작곡·연주자와 라이선스. withMood 면 둘째 줄 앞에 분위기를 붙인다(묶음 제목을 쓸 수 없는 Select 용) */
export function TrackLabel({ track, subColor = 'text.secondary', withMood = false }: { track: Track; subColor?: string; withMood?: boolean }) {
  return (
    <Box component="span" sx={{ display: 'grid', minWidth: 0 }}>
      <Typography component="span" sx={{ fontSize: 13, lineHeight: 1.4 }}>
        {track.title}
      </Typography>
      <Typography component="span" sx={{ fontSize: 11, lineHeight: 1.4, color: subColor }}>
        {withMood ? `${moodLabel(track.mood)} · ` : ''}
        {track.credit} · {track.license}
      </Typography>
    </Box>
  );
}
