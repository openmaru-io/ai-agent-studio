/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { AAS_WITHOUT_IMMERSIVE_SCREENS, aasDeviceOf, isOverlayOnlyType } from './overlayOnly';

describe('몰입 화면이 없는 장치', () => {
  it('눌러서 몰입 화면을 여는 장치는 무시 대상이다(전화부스·ATM 등이 장면을 비우던 문제)', () => {
    for (const t of ['phone_booth', 'sms_booth', 'atm', 'server_terminal', 'server_rack', 'qa_terminal', 'device_rack', 'test_bench', 'kanban_board'])
      expect(isOverlayOnlyType(t)).toBe(true);
  });

  it('탁구대·책상·회의 탁자 같은 장면 안 동작은 그대로 둔다', () => {
    for (const t of ['pingpong', 'desk_cubicle', 'computer', 'round_table', 'couch']) expect(isOverlayOnlyType(t)).toBe(false);
  });

  it('서버·QA·칸반 장치는 AAS 서랍으로 잇고, 전화·문자 부스·ATM 은 장식으로 둔다(계획 007 P5)', () => {
    expect(['server_terminal', 'server_rack', 'device_rack'].map(aasDeviceOf)).toEqual(['server', 'server', 'server']);
    expect(['qa_terminal', 'test_bench'].map(aasDeviceOf)).toEqual(['qa', 'qa']);
    expect(aasDeviceOf('kanban_board')).toBe('kanban');
    expect(aasDeviceOf('tv_status')).toBe('server'); // 한국 사무실 배치: 서버실 대신 상황판
    expect(aasDeviceOf('notice_board')).toBe('qa'); // QA 실험실 대신 게시판
    for (const t of ['tv_meeting', 'whiteboard']) expect(aasDeviceOf(t)).toBeNull(); // 모델이 같아도 장치가 아니다
    for (const t of ['atm', 'sms_booth', 'phone_booth', 'couch']) expect(aasDeviceOf(t)).toBeNull();
  });

  it('3D 캔버스는 몰입 상태에서도 내리지 않는다', () => {
    expect(AAS_WITHOUT_IMMERSIVE_SCREENS).toBe(true);
  });
});
