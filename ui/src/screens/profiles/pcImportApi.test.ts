/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  applyCommands,
  detectOs,
  errText,
  exportCommand,
  importCommands,
  namesLine,
  outputPath,
  pcProfile,
  pollEvery,
  rejectKind,
  repackCommand,
  replaceCommands,
  secretsTodo,
  shortName,
  stageLabels,
  stageName,
  stageRows,
  type StatusResp,
} from './pcImportApi';

describe('PC 가져오기 계산(OMAI-1136 §10)', () => {
  it('브라우저 정보로 OS 를 고른다. 맥의 「darwin」을 윈도우로 읽지 않는다', () => {
    expect(detectOs({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })).toBe('mac');
    expect(detectOs({ userAgent: 'Mozilla/5.0 (darwin) jsdom' })).toBe('mac');
    expect(detectOs({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).toBe('windows');
    expect(detectOs({ userAgentData: { platform: 'Windows' }, userAgent: '' })).toBe('windows');
    expect(detectOs({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })).toBe('linux');
  });

  it('명령과 만들어질 파일은 프로파일 이름 칸 값으로 만들고, 이름에 쓰지 않는 글자는 뺀다', () => {
    expect(exportCommand('mac', 'work')).toBe('hermes profile export work -o ~/hermes-work.tar.gz');
    expect(exportCommand('windows', 'work')).toBe('hermes profile export work -o $env:USERPROFILE\\hermes-work.tar.gz');
    expect(outputPath('windows', 'default')).toBe('%USERPROFILE%\\hermes-default.tar.gz');
    expect(pcProfile(' my work; rm -rf ')).toBe('myworkrm-rf');
    expect(pcProfile('   ')).toBe('default');
  });

  it('다시 묶는 명령은 최상위 폴더만 묶는다(「-C 폴더 .」는 「.」 항목이 생겨 서버 검사가 거절한다)', () => {
    for (const os of ['mac', 'linux', 'windows'] as const) {
      const cmd = repackCommand(os, 'hermes-default.tar.gz');
      expect(cmd).toContain('hermes-default-small.tar.gz');
      expect(cmd).toMatch(/sessions/);
      expect(cmd).not.toMatch(/ \.$/m);
    }
  });

  it('PC 적용 명령: 맥·리눅스는 같고 윈도우는 PowerShell 이다', () => {
    expect(applyCommands('mac', 'f.tar.gz')).toEqual(applyCommands('linux', 'f.tar.gz'));
    expect(applyCommands('windows', 'f.tar.gz').unpack).toContain('Split-Path (hermes config env-path)');
  });

  it('진행 단계: replace 는 사본·바꾸기 둘 다 진행 중, 검사는 늘 끝남', () => {
    expect(stageRows('import')).toEqual(['done', 'now', 'wait', 'wait', 'wait', 'wait']);
    expect(stageRows('config')).toEqual(['done', 'now', 'wait', 'wait', 'wait', 'wait']);
    expect(stageRows('replace')).toEqual(['done', 'done', 'now', 'now', 'wait', 'wait']);
    expect(stageRows('skills')).toEqual(['done', 'done', 'done', 'done', 'now', 'wait']);   // 기본 스킬 맞추기(2026-10-27-011 D10)
    expect(stageRows('restart')).toEqual(['done', 'done', 'done', 'done', 'done', 'now']);
    expect(stageRows('cleanup')).toEqual(['done', 'done', 'done', 'done', 'done', 'now']);
    expect(stageName('replace')).toBe('바꾸기');
    expect(stageName('config')).toBe('가져오기');
  });

  it('비밀 묶음이 있으면 여덟 줄이고 secrets·env·skills 는 그 줄만 진행 중이다(DD14, 2026-10-27-011 D10)', () => {
    expect(stageLabels(true)).toEqual(['검사', '가져오기', '사본', '바꾸기', '인증 파일', '비밀값', '기본 스킬 맞추기', '재시작']);
    expect(stageRows('replace', true)).toEqual(['done', 'done', 'now', 'now', 'wait', 'wait', 'wait', 'wait']);
    expect(stageRows('env', true)).toEqual(['done', 'done', 'done', 'done', 'done', 'now', 'wait', 'wait']);
    expect(stageRows('skills', true)).toEqual(['done', 'done', 'done', 'done', 'done', 'done', 'now', 'wait']);
    expect(stageRows('cleanup', true)).toEqual(['done', 'done', 'done', 'done', 'done', 'done', 'done', 'now']);
    expect(stageName('secrets', true)).toBe('인증 파일');
    expect(stageName('restart', true)).toBe('재시작');
  });

  it('이름 목록은 처음 3개, 「외 N개」는 개수 필드로 센다(DD21·DD22)', () => {
    expect(namesLine(['a', 'b', 'c', 'd', 'e'], 5, false)).toEqual({ shown: ['a', 'b', 'c'], more: 2, omitted: 0 });
    expect(namesLine(['a', 'b', 'c', 'd'], 30, true)).toEqual({ shown: ['a', 'b', 'c', 'd'], more: 0, omitted: 26 });
    expect(namesLine(['a', 'b'], 25, false)).toEqual({ shown: ['a', 'b'], more: 0, omitted: 23 });
  });

  it('할 일의 비밀값은 필요한 키·넣지 못한 키·읽을 수 없음·확인하지 못함을 합친다(DD10)', () => {
    expect(
      secretsTodo({
        secrets_needed: ['A_KEY'],
        env_failed: [{ name: 'B_KEY', reason: 'x' }],
        env_skipped: [
          { name: 'C_KEY', reason: 'unreadable' },
          { name: 'D_KEY', reason: 'exists' },
          { name: 'A_KEY', reason: 'unchecked' },
        ],
      })
    ).toEqual(['A_KEY', 'B_KEY', 'C_KEY']);
  });

  it('진행 중일 때만 다시 읽고, 끝난 상태면 멈춘다', () => {
    const at = (state: string) => ({ job: { state }, profile: 'main', owner: '' }) as unknown as StatusResp;
    expect(pollEvery(at('running'))).toBeGreaterThan(0);
    for (const s of ['uploaded', 'rejected', 'done', 'failed', 'rolled_back', 'rollback_failed', 'cancelled']) expect(pollEvery(at(s))).toBe(false);
    expect(pollEvery(undefined)).toBe(false);
  });

  it('거절 이유를 갈래로 묶고, 오류 코드는 사전 문장으로 바꾼다', () => {
    // 2026-10-22-003 R2·R3·DD17: 옛 규칙(credential·link·plugins) → oldRule, store_failed → retry, no_content → noContent
    for (const r of ['bad_path', 'multi_root', 'not_archive', 'empty']) expect(rejectKind(r)).toBe('archive');
    for (const r of ['credential', 'link', 'plugins']) expect(rejectKind(r)).toBe('oldRule');
    expect(rejectKind('store_failed')).toBe('retry');
    expect(rejectKind('no_content')).toBe('noContent');
    expect(rejectKind('too_many')).toBe('size');
    expect(errText('quota', { used: 1024 * 1024, quota: 2 * 1024 * 1024 })).toBe('AI 에이전트 작업공간의 저장 공간이 모자랍니다(1.0 MB / 2.0 MB).');
    expect(errText('nope')).toBe('처리하지 못했습니다. 잠시 뒤 다시 해 주세요.');
    // 내보내기 전용 한도가 찼다(스펙 2026-10-24-002 R15) — 올리기의 busy 문구(「다른 파일을 올리는 중」)를 쓰지 않는다
    expect(errText('busy_export')).toBe('다른 내보내기가 진행 중입니다. 잠시 뒤 다시 해 주세요.');
  });

  it('다른 프로파일이 가져오는 중이어도 다시 읽어 끝나면 막기를 푼다(OMAI-1444 OV3)', () => {
    expect(pollEvery({ job: null, profile: 'research', owner: '', busy_profile: 'main' })).toBeGreaterThan(0);
    expect(pollEvery({ job: null, profile: 'research', owner: '' })).toBe(false);
  });

  it('main 이 아닌 프로파일의 PC 넣기 명령: 새 이름으로 import, 바꾸기는 보관 → 지우기 → 같은 이름 import(OMAI-1444 R13)', () => {
    const f = 'hermes-research-2026-10-23.tar.gz';
    expect(importCommands('mac', f, 'research-aas')).toEqual({
      import: `hermes profile import ~/Downloads/${f} --name research-aas`,
      cron: 'hermes -p research-aas cron list\nhermes -p research-aas cron pause <id>',
      check: 'hermes -p research-aas config',
    });
    expect(importCommands('windows', f, 'x').import).toBe(`hermes profile import $env:USERPROFILE\\Downloads\\${f} --name x`);
    expect(replaceCommands('linux', f, 'research')).toEqual({
      backup: 'hermes profile export research -o ~/hermes-research-backup.tar.gz',
      remove: 'hermes profile delete research',
      import: `hermes profile import ~/Downloads/${f} --name research`,
    });
  });

  it('단추 이름 칸은 24자를 넘으면 말줄임표(OMAI-1444 DD2)', () => {
    expect(shortName('research')).toBe('research');
    expect(shortName('a'.repeat(24))).toBe('a'.repeat(24));
    expect(shortName('a'.repeat(25))).toBe('a'.repeat(23) + '…');
  });
});
