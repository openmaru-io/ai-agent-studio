/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 지금 오피스에 있는 사람(계획 007 §3-3 G1, R6). 탭 줄 오른쪽 머리줄에 얼굴 최대 5개, 넘치면 +N. 나 혼자면 숨긴다.
import { Avatar, Box, Button, ButtonBase, Popover, Stack, Typography } from '@mui/material';
import { useState } from 'react';

import { faceUrl } from '@/features/office/avatars/face';
import type { Person } from '@/features/office/usePresence';
import { t } from '@/i18n';
import { coarseTouch } from '@/lib/chatTokens';

export function PresenceStrip({ people, onChangeFace }: { people: Person[]; onChangeFace: (seed: string) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  if (people.length <= 1) return null;
  const me = people.find((p) => p.me);
  return (
    <>
      <ButtonBase
        onClick={(e) => setAnchor(e.currentTarget)}
        aria-label={t('office.peopleHere', { n: people.length })}
        sx={{ minHeight: 36, ...coarseTouch, px: 1, borderRadius: '6px' }} // 탭 줄(36)과 같은 높이라 접속자 수가 바뀌어도 줄이 흔들리지 않는다(스펙 2026-10-19-005 G1)
      >
        <Stack direction="row" alignItems="center">
          {people.slice(0, 5).map((p, i) => (
            <Avatar
              key={p.id}
              alt={p.name}
              src={faceUrl(p.seed)}
              sx={{ width: 28, height: 28, ml: i ? -0.75 : 0, border: '2px solid #0f1011' }}
            />
          ))}
          {people.length > 5 && (
            <Typography component="span" sx={{ ml: 0.75, fontSize: 12, color: 'text.secondary' }}>
              +{people.length - 5}
            </Typography>
          )}
        </Stack>
      </ButtonBase>
      <Popover
        open={!!anchor}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <Box sx={{ p: 1.5, width: 260 }}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            {t('office.peopleHere', { n: people.length })}
          </Typography>
          <Stack component="ul" spacing={0.75} sx={{ listStyle: 'none', m: 0, p: 0 }}>
            {people.map((p) => (
              <Stack key={p.id} component="li" direction="row" spacing={1} alignItems="center">
                <Avatar alt="" src={faceUrl(p.seed)} sx={{ width: 24, height: 24 }} />
                <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>
                  {p.name}
                  {p.me ? ` (${t('office.me')})` : ''}
                </Typography>
                {p.email && (
                  <Typography variant="caption" color="text.secondary" noWrap>
                    {p.email}
                  </Typography>
                )}
              </Stack>
            ))}
          </Stack>
          {me && (
            <Button size="small" sx={{ mt: 1 }} onClick={() => onChangeFace(Math.random().toString(36).slice(2, 10))}>
              {t('office.changeFace')}
            </Button>
          )}
        </Box>
      </Popover>
    </>
  );
}
