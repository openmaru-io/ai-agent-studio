/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 내 메신저 계정 연결·연결 대기·다시 시작(스펙 2026-11-17-008 §5)
export default {
  'messenger.linkButton': '내 메신저 계정 연결',
  'messenger.linkedCount': '연결한 메신저 {n}개',
  'messenger.title': '내 메신저 계정 연결',
  'messenger.help': '이 AI 에이전트의 봇에게 메신저로 아무 말이나 보내면 연결 코드(8자리)를 받습니다. 그 코드를 아래에 넣으세요.',
  'messenger.which': '연결할 메신저',
  'messenger.hint.telegram': 'Telegram 에서 봇 이름을 검색하거나 소유자에게 받은 t.me 링크를 여세요.',
  'messenger.hint.slack': 'Slack 에서 앱 이름을 검색해 메시지를 보내세요. 메시지 칸이 없으면 소유자에게 앱의 메시지 탭을 켜 달라고 하세요.',
  'messenger.hint.discord': 'Discord 에서는 봇과 같은 서버에 있어야 봇에게 메시지를 보낼 수 있습니다.',
  'messenger.hint.mattermost': 'Mattermost 에서는 봇 계정이 같은 팀에 있어야 대화 상대 검색에 나옵니다.',
  'messenger.botOff': '이 봇이 지금 연결되어 있지 않습니다. 코드를 받지 못하면 소유자에게 알려 주세요.',
  'messenger.noBot': '{name} 님이 아직 이 AI 에이전트에 메신저를 연결하지 않았습니다. 소유자에게 메신저 연결을 요청하세요.',
  'messenger.code': '연결 코드',
  'messenger.link': '연결',
  'messenger.linked': '{name} 이(가) 연결되었습니다. 본인 계정이 아니면 바로 해제하세요.',
  'messenger.noDelivery': '이 메신저로는 대화만 되고 알림은 받지 못합니다.',
  'messenger.mine': '내가 연결한 메신저',
  'messenger.unlink': '해제',
  'messenger.whoIs': '{name} 은(는) 누구인가요',
  'messenger.whoUnknown': '누구인지 고르지 않음',
  'messenger.linkedBy': '{name} 님이 연결',
  'messenger.notAasUser': 'AAS 사용자 아님',
  'messenger.clearPending': '연결 대기 비우기',
  'messenger.inboxLinked': '메신저 계정 연결',
  'messenger.inboxLinkedText': '{member} 님이 {platform} 계정 {user} 을(를) {profile} 에 연결했습니다.',
  'messenger.notifyMe': '승인 요청·실패한 예약 작업 알림을 메신저로도 받기',
  'messenger.team': '팀 공지 대화방',
  'messenger.teamOff': '보내지 않음',
  'messenger.teamHelp': '실패한 예약 작업을 이 봇의 홈 채널(팀 그룹)로도 보냅니다. 그룹에서 /sethome 을 보내 홈 채널을 정하세요.',
  'messenger.teamSaved': '팀 공지 대화방을 바꿨습니다.',
  'messenger.sentToo': '메신저로도 보냄',
} as Record<string, string>;
