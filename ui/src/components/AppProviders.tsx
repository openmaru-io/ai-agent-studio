/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { SnackbarProvider } from 'notistack';
import { ReactNode } from 'react';

import { toastComponents } from './AppToast';
import { ConfirmProvider } from './ConfirmDialog';
import { I18nProvider } from './I18n';
import { ThemeModeProvider } from './ThemeMode';
import { UiProvider } from './UiContext';

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeModeProvider>
      <SnackbarProvider
        maxSnack={3}
        autoHideDuration={4000}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        // 가이드 카드가 떠 있으면 알림을 그 위로 올린다. 값은 GuideRunner 의 GlobalStyles 가 --aas-guide-offset 으로 준다(OMAI-1274)
        classes={{ containerAnchorOriginBottomRight: 'aas-snack-bottom-right' }}
        Components={toastComponents}
      >
        <I18nProvider>
          <UiProvider>
            <ConfirmProvider>{children}</ConfirmProvider>
          </UiProvider>
        </I18nProvider>
      </SnackbarProvider>
    </ThemeModeProvider>
  );
}
