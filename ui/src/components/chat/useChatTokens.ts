/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { useTheme } from '@mui/material';

import { ChatTokens, chatTokens } from '@/lib/chatTokens';

/** 지금 테마(다크·라이트)의 대화 화면 토큰 */
export const useChatTokens = (): ChatTokens => chatTokens[useTheme().palette.mode];
