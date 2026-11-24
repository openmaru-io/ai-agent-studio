/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 상단 막대의 「MindWiki 열기」 단추(스펙 2026-11-23-019 4-2·L1~L5). 검색 칸 바로 오른쪽. MindWiki 를 함께 설치했을 때만(/api/me 의 mindwiki_url, G1·G4).
// 누를 때마다 새 탭을 열지 않고 MindWiki 탭 하나를 쓴다. 브라우저가 탭 전환을 막으면 알림으로 알린다(L3a, Design D7).
// 아이콘은 단색 MUI 아이콘이다 — MindWiki 의 단색 표지가 없어 Q5 의 대체안을 쓴다(DESIGN.md §1-3.4 브랜드 색 로고 금지).
import MenuBookOutlinedIcon from '@mui/icons-material/MenuBookOutlined';
import { Box, Button, Tooltip } from '@mui/material';
import { useSnackbar } from 'notistack';
import { useCallback } from 'react';

import { t } from '@/i18n';
import { useMe } from '@/lib/data';
import { MINDWIKI_TAB, openProductTab, type TabResult } from '@/lib/productTab';
import { shellMetrics } from '@/lib/shellTokens';

import { topbarButtonSx } from './topbarButton';

const TOAST_KEY = 'product-tab';

/** 상대 탭 열기 + 결과 알림. 상단 단추·저장 뒤 링크가 함께 쓴다(L3b). 단추를 다시 누르면 앞의 알림을 바꾼다(쌓지 않음, Design D7) */
export function useOpenMindwiki() {
  const { enqueueSnackbar, closeSnackbar } = useSnackbar();
  return useCallback(
    async (url: string, opts: { navigate?: boolean } = {}) => {
      closeSnackbar(TOAST_KEY);
      const finalNotice = () =>
        enqueueSnackbar(t('topbar.productTab.chooseTab', { product: 'MindWiki' }), { key: TOAST_KEY, variant: 'warning', autoHideDuration: 6000 });
      const show = (r: TabResult) => {
        if (r.kind === 'refused') return finalNotice();
        if (r.kind !== 'blocked') return;
        const reopen = r.reopen;
        enqueueSnackbar(t('topbar.productTab.alreadyOpen', { product: 'MindWiki' }), {
          key: TOAST_KEY,
          variant: 'warning',
          persist: true,
          action: (id) => (
            <>
              {reopen && (
                <Button
                  size="small"
                  color="inherit"
                  onClick={() => {
                    closeSnackbar(id);
                    void reopen().then((next) => (next.kind === 'refused' || next.kind === 'blocked' ? finalNotice() : undefined));
                  }}
                >
                  {t('topbar.productTab.reopen')}
                </Button>
              )}
              <Button size="small" color="inherit" onClick={() => closeSnackbar(id)}>
                {t('topbar.productTab.close')}
              </Button>
            </>
          ),
        });
      };
      show(await openProductTab(url, MINDWIKI_TAB, opts));
    },
    [enqueueSnackbar, closeSnackbar]
  );
}

export function MindwikiLinkButton() {
  const url = useMe().data?.mindwiki_url ?? '';
  const open = useOpenMindwiki();
  if (!url) return null; // 함께 설치하지 않은 곳(G1)
  const label = t('topbar.productTab.openMindwiki');
  return (
    <Tooltip title={label}>
      <Box component="button" type="button" onClick={() => void open(url)} aria-label={label} sx={topbarButtonSx(false)} data-testid="mindwiki-link">
        <MenuBookOutlinedIcon sx={{ fontSize: shellMetrics.iconButtonSize }} />
      </Box>
    </Tooltip>
  );
}
