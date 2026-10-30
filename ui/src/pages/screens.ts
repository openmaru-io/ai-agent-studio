/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 화면 등록부. 여기에 없는 화면 id 는 홈으로 보낸다(App.tsx).
// 목록 화면(ListView → DataGrid → material-react-table)은 그 화면을 열 때만 받는다(OMAI-1127, 계획 2026-10-13-015 재검토 D3).
// 대시보드·대화·오피스·설정은 첫 화면에서 함께 받는다.
import { ComponentType, lazy } from 'react';

import { Chat } from '@/screens/Chat';
import { Dashboard } from '@/screens/Dashboard';
import { Office } from '@/screens/Office';
import { Settings } from '@/screens/Settings';
import { Preferences } from '@/screens/settings/Preferences';

const named = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) =>
  lazy(() => load().then((m) => ({ default: m[name] })));

export const SCREENS: Record<string, ComponentType> = {
  activity: named(() => import('@/screens/Activity'), 'Activity'),
  agents: named(() => import('@/screens/Agents'), 'Agents'),
  changes: named(() => import('@/screens/Changes'), 'Changes'),
  channels: named(() => import('@/screens/Channels'), 'Channels'),
  chat: Chat,
  connections: named(() => import('@/screens/Connections'), 'Connections'),
  credentials: named(() => import('@/screens/Inventory'), 'Credentials'),
  cron: named(() => import('@/screens/Cron'), 'Cron'),
  dashboard: Dashboard,
  flows: named(() => import('@/screens/Flows'), 'Flows'),
  libraries: named(() => import('@/screens/Inventory'), 'Libraries'),
  market: named(() => import('@/screens/Market'), 'Market'),
  models: named(() => import('@/screens/Models'), 'Models'),
  office: Office,
  preferences: Preferences,
  profiles: named(() => import('@/screens/Profiles'), 'Profiles'),
  settings: Settings,
  skills: named(() => import('@/screens/Skills'), 'Skills'),
  notices: named(() => import('@/screens/Notices'), 'Notices'),
  'soul-templates': named(() => import('@/screens/settings/SoulTemplates'), 'SoulTemplates'),
  tools: named(() => import('@/screens/Inventory'), 'Tools'),
  users: named(() => import('@/screens/Users'), 'Users'),
};
