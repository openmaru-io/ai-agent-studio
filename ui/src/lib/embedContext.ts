/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 다른 사이트에 붙은 채팅 위젯 안에서 그리는가(OMAI-1873). 화면은 이 값 하나로 위젯에서 쓸 수 없는 기능
// (관리자 요청·읽어 주기·받아쓰기·파일 첨부)을 끄고, 주소를 바꾸는 링크를 AAS 새 탭으로 연다. AAS 화면에서는 null 이다.
import { createContext, type ReactNode, useContext } from 'react';

export interface EmbedInfo {
  /** AAS 주소(끝 / 없이) */
  backendUrl: string;
  /** 입력 칸 바로 위에 둘 것(페이지 맥락 칩, 스펙 2026-11-15-002 A1) */
  composerTop?: ReactNode;
  /** 위젯 상태 저장소(embed/state 의 WidgetStore). 답 저장 단추가 쓴다(스펙 2026-11-18-012). 화면 쪽이 위젯 모듈을 불러오지 않게 unknown 으로 둔다 */
  widgetStore?: unknown;
}

export const EmbedContext = createContext<EmbedInfo | null>(null);

export const useEmbed = (): EmbedInfo | null => useContext(EmbedContext);
