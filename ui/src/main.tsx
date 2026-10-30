/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import './fonts.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';

import { App } from './App';
import { AppProviders } from './components/AppProviders';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15000 } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AppProviders>
          <App />
        </AppProviders>
      </HashRouter>
    </QueryClientProvider>
  </StrictMode>
);
