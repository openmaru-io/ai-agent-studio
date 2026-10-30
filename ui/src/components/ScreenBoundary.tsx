/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 화면 하나의 오류 경계(App.tsx ViewPage). 경계가 없으면 화면 오류가 앱 전체를 내려 빈 화면이 된다.
// 목록 화면은 지연 로딩이라(pages/screens.ts) 다시 배포 뒤 옛 index.html 이 가리키는 옛 묶음이 404 다(사용자 보고 2026-10-21).
// 이때는 새로 고쳐 새 index.html 을 받는다. 배포 중 옛·새 파드가 섞여 또 실패하면 안내와 「새로 고침」 단추를 보이고,
// 30초마다 다시 새로 고친다(배포가 끝나면 열린다). 30초 간격은 탭마다 sessionStorage 로 센다(lib/chunkError.ts).
import RefreshIcon from '@mui/icons-material/Refresh';
import { Alert, Box, Button } from '@mui/material';
import { Component, type ReactNode } from 'react';

import { t } from '@/i18n';
import { isChunkError, keepReloading, page } from '@/lib/chunkError';

import { PageTitle } from './PageTitle';

export class ScreenBoundary extends Component<{ title: string; children: ReactNode }, { error: unknown; failed: boolean }> {
  state = { error: null as unknown, failed: false };

  static getDerivedStateFromError(error: unknown) {
    return { error, failed: true };
  }

  private stop?: () => void;

  componentDidCatch(error: unknown) {
    if (isChunkError(error)) this.stop = keepReloading();
  }

  componentWillUnmount() {
    this.stop?.();
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const { error } = this.state;
    const message = isChunkError(error) ? t('common.newVersion') : t('common.screenFailed', { error: error instanceof Error ? error.message : String(error) });
    return (
      <Box>
        <PageTitle gutterBottom>{this.props.title}</PageTitle>
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" startIcon={<RefreshIcon />} onClick={() => page.reload()}>
              {t('common.refresh')}
            </Button>
          }
        >
          {message}
        </Alert>
      </Box>
    );
  }
}
