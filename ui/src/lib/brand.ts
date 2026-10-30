/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 설치 브랜드(OPENMARU · MSAP · AINP). COP Console(getProductInfo.ts·brandLogos.ts)·Observ(version.js)와 같은 방식이다(OMAI-1299, 스펙 2026-10-17-013).
// 서버가 index.html 을 보낼 때 <head> 에 window.__RUNTIME_CONFIG__.PRODUCT_NAME(「MSAP_CogentAI」 등)을 넣는다(aas/web/server.py _index_html).
// 로고는 세 브랜드 모두 번들에 들어 있다(에어갭). 변형 이름: h 가로·검정 글자, rwh 가로·흰 글자(어두운 배경), wh 가로·흰색 단색, v·rwv·wv 는 세로형.
import AINP_h from '@/assets/logo/AINP_CogentAI_h.svg';
import AINP_rw_h from '@/assets/logo/AINP_CogentAI_rw_h.svg';
import AINP_rw_v from '@/assets/logo/AINP_CogentAI_rw_v.svg';
import AINP_v from '@/assets/logo/AINP_CogentAI_v.svg';
import AINP_w_h from '@/assets/logo/AINP_CogentAI_w_h.svg';
import AINP_w_v from '@/assets/logo/AINP_CogentAI_w_v.svg';
import MSAP_h from '@/assets/logo/MSAP_CogentAI_h.svg';
import MSAP_rw_h from '@/assets/logo/MSAP_CogentAI_rw_h.svg';
import MSAP_rw_v from '@/assets/logo/MSAP_CogentAI_rw_v.svg';
import MSAP_v from '@/assets/logo/MSAP_CogentAI_v.svg';
import MSAP_w_h from '@/assets/logo/MSAP_CogentAI_w_h.svg';
import MSAP_w_v from '@/assets/logo/MSAP_CogentAI_w_v.svg';
import OM_h from '@/assets/logo/OPENMARU_CogentAI_h.svg';
import OM_rw_h from '@/assets/logo/OPENMARU_CogentAI_rw_h.svg';
import OM_rw_v from '@/assets/logo/OPENMARU_CogentAI_rw_v.svg';
import OM_v from '@/assets/logo/OPENMARU_CogentAI_v.svg';
import OM_w_h from '@/assets/logo/OPENMARU_CogentAI_w_h.svg';
import OM_w_v from '@/assets/logo/OPENMARU_CogentAI_w_v.svg';

export type BrandKey = 'OPENMARU' | 'MSAP' | 'AINP';

export interface BrandLogos {
  h: string;
  rwh: string;
  wh: string;
  v: string;
  rwv: string;
  wv: string;
}

export const BRAND_LOGOS: Record<BrandKey, BrandLogos> = {
  OPENMARU: { h: OM_h, rwh: OM_rw_h, wh: OM_w_h, v: OM_v, rwv: OM_rw_v, wv: OM_w_v },
  MSAP: { h: MSAP_h, rwh: MSAP_rw_h, wh: MSAP_w_h, v: MSAP_v, rwv: MSAP_rw_v, wv: MSAP_w_v },
  AINP: { h: AINP_h, rwh: AINP_rw_h, wh: AINP_w_h, v: AINP_v, rwv: AINP_rw_v, wv: AINP_w_v },
};

declare global {
  interface Window {
    __RUNTIME_CONFIG__?: { PRODUCT_NAME?: string | null };
  }
}

/** 서버가 넣은 값. 넣지 않았거나 자리표시자(%…%)면 빈 값 — OPENMARU 가 된다 */
function rawProductName(): string {
  const v = typeof window === 'undefined' ? '' : window.__RUNTIME_CONFIG__?.PRODUCT_NAME;
  return v && !v.startsWith('%') ? v : '';
}

export function brandKey(): BrandKey {
  const name = rawProductName().trim().replace(/_/g, ' ').toUpperCase();
  if (name.startsWith('MSAP')) return 'MSAP';
  if (name.startsWith('AINP')) return 'AINP';
  return 'OPENMARU';
}

export function brandLogos(): BrandLogos {
  return BRAND_LOGOS[brandKey()];
}

/** 로고에 적힌 이름 — 「MSAP CogentAI」 */
export function brandProduct(): string {
  return `${brandKey()} CogentAI`;
}
