/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 입력칸의 「말로 입력」(스펙 2026-10-22-005 §3-10·§3-10-1)
export default {
  'voice.label': '말로 입력',
  'voice.finishLabel': '녹음 끝내기',
  'voice.cancelRecording': '녹음 취소',
  'voice.cancelTranscribe': '받아쓰기 취소',
  'voice.tooltip': '말로 입력 · 최대 1분 · 녹음은 저장하지 않습니다',
  'voice.blocked': 'AI 에이전트 작업공간이 연결되지 않아 말로 입력을 쓸 수 없습니다',
  'voice.blockedMine': '내 AI 에이전트 작업공간이 연결되지 않아 말로 입력을 쓸 수 없습니다',
  'voice.otherWindow': '다른 창에서 녹음 중입니다',
  'voice.asking': '브라우저 알림에서 마이크를 허용하세요',
  'voice.denied': '주소창 왼쪽의 사이트 정보 아이콘에서 마이크를 허용하세요',
  'voice.notFound': '마이크를 찾지 못했습니다',
  'voice.inUse': '다른 프로그램이 마이크를 쓰고 있습니다',
  'voice.micError': '마이크를 열지 못했습니다',
  'voice.silent': '소리가 들리지 않습니다. 마이크를 확인하세요',
  'voice.tenLeft': '10초 남았습니다',
  'voice.autoStopped': '1분이 되어 녹음을 끝냈습니다',
  'voice.recording': '녹음 중',
  'voice.transcribing': '받아쓰는 중…',
  'voice.empty': '말소리를 알아듣지 못했습니다',
  'voice.hint': '받아쓴 글을 확인하고 Enter 로 보내세요',
  'voice.busy': '지금 받아쓰기가 많습니다. 다시 시도를 눌러 주세요',
  'voice.failed': '받아쓰지 못했습니다. 다시 시도를 눌러 주세요',
  'voice.failedFinal': '받아쓰지 못했습니다',
  'voice.tooLong': '녹음이 너무 깁니다. 짧게 나눠 말해 주세요',
  'voice.waitConnection': 'AI 에이전트 작업공간 연결이 끊겼습니다. 연결되면 다시 시도를 눌러 주세요',
  'voice.failedShort': '받아쓰기 실패',
  'voice.retry': '다시 시도',
  'voice.dismiss': '녹음 버리기',
  'voice.sendBlocked': '받아쓰기가 끝나면 보낼 수 있습니다',
  'voice.started': '녹음을 시작했습니다',
  'voice.stopped': '녹음을 끝냈습니다. 받아쓰는 중입니다',
  'voice.discarded': '녹음을 버렸습니다',
  'voice.inserted': '받아쓴 글을 입력칸에 넣었습니다. 확인하고 Enter 로 보내세요',
  // 스트리밍 받아쓰기(OMAI-1554, 스펙 2026-10-31-001 D21~D24)
  'voice.tooltipStream': '말로 입력 · 최대 {min}분 · 녹음은 저장하지 않습니다',
  'voice.autoStoppedAt': '최대 길이({time})가 되어 녹음을 끝냈습니다',
  'voice.streamBusy': '실시간 받아쓰기가 많아 녹음을 끝낸 뒤 받아씁니다',
  'voice.finishing': '마무리하는 중…',
  'voice.recovering': '연결이 끊겨 마저 받아쓰는 중…',
  'voice.loginRequired': '로그인이 끝났습니다. 다시 로그인하세요',
  'voice.forbidden': '이 AI 에이전트 작업공간에서는 말로 입력을 쓸 수 없습니다',
  // 2차 인식(스펙 2026-11-01-001 D12·D13·D18·D19)
  'voice.refining': '다듬는 중…',
  'voice.refined': '받아쓴 글을 다듬었습니다',
  'voice.undo': '되돌리기',
  'voice.refinedInserted': '받아쓴 글을 다듬었습니다. 확인하고 Enter 로 보내세요',
} as Record<string, string>;
