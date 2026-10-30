/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 서버가 언어와 상관없이 한국어 값으로 보내는 배지·플래그·표시 값. 화면은 이 값을 비교해 색과 필터를 정하고(한국어 그대로),
// 사람에게 보일 때만 serverTerm() 으로 현재 언어로 바꾼다. 서버가 새 값을 보내면 여기와 사전(terms.*)에 함께 더한다.
// 모르는 값은 그대로 돌려준다(서버가 이미 요청 언어로 만든 문장일 수 있다).
import { t } from '@/i18n';

/** 값이 고정인 항목: [서버 값, 사전 키] */
const EXACT: [string, string][] = [
  ['꺼짐', 'terms.off'], // i18n-ignore: 서버가 보내는 배지 값
  ['알림 없음', 'terms.noAlert'], // i18n-ignore: 서버가 보내는 배지 값
  ['전달 실패', 'terms.deliveryFailed'], // i18n-ignore: 서버가 보내는 배지 값(크론 작업이 실행은 성공했고 결과 전달만 실패, OMAI-1292)
  ['버전 여러 개', 'terms.multiVersion'], // i18n-ignore: 서버가 보내는 배지 값
  ['설치 목록에 없음', 'terms.notInInstallList'], // i18n-ignore: 서버가 보내는 배지 값
  ['설정에 없음', 'terms.notInConfig'], // i18n-ignore: 서버가 보내는 배지 값
  ['실행에서만 보임', 'terms.seenInRunsOnly'], // i18n-ignore: 서버가 보내는 배지 값
  ['등록됨', 'terms.registered'], // i18n-ignore: 서버가 보내는 배지 값
  ['비어 있음', 'terms.empty'], // i18n-ignore: 서버가 보내는 플래그 값
  ['만료됨', 'terms.expired'], // i18n-ignore: 서버가 보내는 플래그 값
  ['로그인 필요', 'terms.loginNeeded'], // i18n-ignore: 서버가 보내는 플래그 값(MCP OAuth 토큰 없음)
  ['설치되지 않음', 'terms.notInstalled'], // i18n-ignore: 서버가 보내는 플래그 값
  ['백업·임시 파일', 'terms.backupOrTemp'], // i18n-ignore: 서버가 보내는 플래그 값
  ['부르는 곳을 찾지 못함', 'terms.noCallers'], // i18n-ignore: 서버가 보내는 플래그 값
  ['쓰는 곳을 찾지 못함', 'terms.noUsage'], // i18n-ignore: 서버가 보내는 플래그 값
  ['백업으로 보임', 'terms.looksBackup'], // i18n-ignore: 서버가 보내는 플래그 값
  ['경로', 'terms.path'], // i18n-ignore: 서버가 보내는 메타 항목 이름
];

/** 숫자가 들어가는 항목: [패턴(첫 묶음이 숫자), 사전 키] */
const COUNTED: [RegExp, string][] = [
  [/^실패 (\d+)회$/, 'terms.failedTimes'], // i18n-ignore: 서버가 보내는 배지 값
  [/^(\d+)일 뒤 만료$/, 'terms.expiresInDays'], // i18n-ignore: 서버가 보내는 플래그 값
  [/^같은 값이 (\d+)곳에$/, 'terms.sameValueIn'], // i18n-ignore: 서버가 보내는 플래그 값
  [/^환경마다 버전이 다름 \((\d+)가지\)$/, 'terms.versionsDiffer'], // i18n-ignore: 서버가 보내는 플래그 값
];

/** 서버의 한국어 배지·플래그를 현재 언어로. 모르는 값은 그대로. */
export function serverTerm(value: string): string {
  const hit = EXACT.find(([ko]) => ko === value);
  if (hit) return t(hit[1]);
  for (const [re, key] of COUNTED) {
    const m = re.exec(value);
    if (m) return t(key, { n: m[1] });
  }
  return value;
}

export type BadgeTone = 'bad' | 'good' | 'warn';

/** 배지·플래그의 색. 실패·만료·비어 있음·설치되지 않음은 나쁨, 등록됨은 좋음, 나머지는 주의. */
export function badgeTone(value: string): BadgeTone {
  if (/^실패 |^만료됨$|^비어 있음$|^설치되지 않음$/.test(value)) return 'bad'; // i18n-ignore: 서버가 보내는 값과 맞대어 본다
  return value === '등록됨' ? 'good' : 'warn'; // i18n-ignore: 서버가 보내는 값과 맞대어 본다
}

/** 크론 작업 화면에서는 따로 「꺼짐」 상태 태그를 보이므로 배지 목록에서는 뺀다. */
export const isOffBadge = (value: string): boolean => value === '꺼짐'; // i18n-ignore: 서버가 보내는 배지 값
