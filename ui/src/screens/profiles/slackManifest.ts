/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// Slack 앱 설정 파일(manifest). 「Slack 앱 만드는 법」에서 복사해 Slack 앱 설정 › Paste a manifest 에 붙인다(스펙 2026-11-23-002 D2).
// `hermes slack manifest` 결과에서 슬래시 명령·assistant 화면·반응 이모지를 뺀 최소 버전이다.
// 주제별 매뉴얼 『Slack 봇 연결하기 따라 하기』 2.1 과 같은 내용이다. 바꾸면 매뉴얼도 함께 고친다.
const manifest = {
  display_information: { name: 'AAS Agent', description: 'AAS AI Agent' },
  features: {
    app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    bot_user: { display_name: 'AAS Agent', always_online: true },
  },
  oauth_config: {
    scopes: {
      bot: [
        'app_mentions:read',
        'channels:history',
        'channels:read',
        'chat:write',
        'files:read',
        'files:write',
        'groups:history',
        'groups:read',
        'im:history',
        'im:read',
        'im:write',
        'mpim:history',
        'mpim:read',
        'users:read',
      ],
    },
  },
  settings: {
    event_subscriptions: { bot_events: ['app_mention', 'message.channels', 'message.groups', 'message.im', 'message.mpim'] },
    interactivity: { is_enabled: true },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false,
  },
};

export const SLACK_MANIFEST = JSON.stringify(manifest, null, 2);
