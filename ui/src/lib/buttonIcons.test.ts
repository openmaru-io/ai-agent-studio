/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 자주 쓰는 동작 단추 앞의 아이콘(OMAI-1280). 같은 동작은 화면이 달라도 같은 아이콘이다.
// 문장 안의 밑줄 글자 단추(부서 고르기의 다시 시도 등)는 링크처럼 읽히므로 넣지 않는다.
// 새 단추가 같은 글자를 쓰면서 아이콘을 빠뜨리거나 다른 아이콘을 달면 여기서 실패한다.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');

/** 단추 글자의 번역 키 → startIcon 아이콘 */
const ICONS: Record<string, string> = {
  'editor.copy': 'ContentCopyOutlinedIcon',
  'cron.copyError': 'ContentCopyOutlinedIcon',
  'flows.copyPath': 'ContentCopyOutlinedIcon',
  'common.copy': 'ContentCopyOutlinedIcon',
  'users.result.copy': 'ContentCopyOutlinedIcon',
  'cron.copyAck': 'ContentCopyOutlinedIcon',
  'cron.copyAllAck': 'ContentCopyOutlinedIcon',
  // 글자가 「복사함」으로 바뀌어도 같은 복사 단추다(첫 번역 키가 copied)
  'profiles.mcp.copied': 'ContentCopyOutlinedIcon',
  'editor.download': 'DownloadOutlinedIcon',
  'market.publishDownload': 'DownloadOutlinedIcon',
  'dashboard.retry': 'RefreshIcon',
  'skills.zipRetry': 'RefreshIcon',
  'profiles.mcp.catalogRetry': 'RefreshIcon',
  'office.meetingRetry': 'RefreshIcon',
  'chat.files.reload': 'RefreshIcon',
  'office.meetingFileReload': 'RefreshIcon',
  'market.tagsRefresh': 'RefreshIcon',
  'agents.create': 'AddIcon',
  'profiles.create': 'AddIcon',
  'skills.create': 'AddIcon',
  'office.create': 'AddIcon',
  'office.newBoard': 'AddIcon',
  'office.newRoom': 'AddIcon',
  'settings.goalAdd': 'AddIcon',
  'office.addCard': 'AddIcon',
  'profiles.envAddButton': 'AddIcon',
  'profiles.mcp.new': 'AddIcon',
  'cronJob.newCreate': 'AddIcon',
  'agents.delete': 'DeleteOutlineIcon',
  'cronJob.delete': 'DeleteOutlineIcon',
  'profiles.deleteForever': 'DeleteOutlineIcon',
  'market.deleteProfile': 'DeleteOutlineIcon',
  'market.remove': 'DeleteOutlineIcon',
  'office.editDelete': 'DeleteOutlineIcon',
  'profiles.envClear': 'DeleteOutlineIcon',
  'profiles.mcpTest': 'NetworkCheckOutlinedIcon',
  'profiles.chan.test': 'NetworkCheckOutlinedIcon',
  'models.probe': 'NetworkCheckOutlinedIcon',
  'office.cronRunNow': 'PlayArrowOutlinedIcon',
  'office.dispatchNow': 'PlayArrowOutlinedIcon',
  'requests.send': 'SendOutlinedIcon',
  'office.inboxSend': 'SendOutlinedIcon',
  'chat.resend': 'SendOutlinedIcon',
  'office.commentPost': 'SendOutlinedIcon',
  // 다른 화면으로 가는 단추는 가는 화면의 제목 아이콘(PageTitle.tsx 의 VIEW_ICONS)
  'dashboard.toAgents': 'SmartToyOutlinedIcon',
  'changes.toProfiles': 'BadgeOutlinedIcon',
  'market.openProfile': 'BadgeOutlinedIcon',
  'users.adminOnlyGo': 'DashboardOutlinedIcon',
  'cron.manageButton': 'ScheduleOutlinedIcon',
  'flows.cronActions': 'ScheduleOutlinedIcon',
  'editor.edit': 'EditOutlinedIcon',
  'profiles.envChange': 'EditOutlinedIcon',
  'flows.edit': 'EditOutlinedIcon',
  'editor.versionsBtn': 'HistoryOutlinedIcon',
  'flows.versions': 'HistoryOutlinedIcon',
  'editor.revert': 'UndoOutlinedIcon',
  'editor.revertAll': 'UndoOutlinedIcon',
  'soulTpl.revertTo': 'UndoOutlinedIcon',
  'market.restore': 'RestoreFromTrashOutlinedIcon',
  'editor.showDiff': 'CompareArrowsOutlinedIcon',
  // 펼치기만 하는 단추는 펼침 아이콘을 돌리지 않고 앞에 둔다(접고 펼치는 단추는 DisclosureButton, 스펙 2026-10-19-005 R5)
  'skills.zipMore': 'ExpandMoreIcon',
  // 미리 보기 켜고 끄기(aria-pressed)는 미리 보기 아이콘(R6·R10)
  'office.cardPreview': 'PreviewOutlinedIcon',
  'mdfield.preview': 'PreviewOutlinedIcon',
  'editor.compareTwo': 'CompareArrowsOutlinedIcon',
  'cron.askButton': 'AutoAwesomeOutlinedIcon',
  'guides.askAi': 'AutoAwesomeOutlinedIcon',
};

function sources(dir: string): [string, string][] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return ['i18n', 'test'].includes(name) ? [] : sources(p);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [[p, readFileSync(p, 'utf-8')] as [string, string]] : [];
  });
}

/** 파일 안의 <Button …>글자</Button> 마다 [여는 태그, 첫 번역 키] */
function buttons(text: string): { open: string; key: string }[] {
  const out: { open: string; key: string }[] = [];
  for (const m of text.matchAll(/<Button\b/g)) {
    let i = m.index + m[0].length;
    let depth = 0;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    const body = text.slice(i + 1, text.indexOf('</Button>', i));
    const key = /t\('([^']+)'/.exec(body)?.[1];
    if (key) out.push({ open: text.slice(m.index, i + 1), key });
  }
  return out;
}

describe('동작 단추 아이콘(OMAI-1280)', () => {
  const all = sources(SRC).flatMap(([p, text]) => buttons(text).map((b) => ({ ...b, file: p.slice(SRC.length + 1) })));

  it('정한 글자의 단추는 정한 아이콘을 startIcon 으로 단다', () => {
    for (const b of all) {
      const want = ICONS[b.key];
      if (want) expect(b.open, `${b.file} ${b.key}`).toMatch(new RegExp(`startIcon=\\{\\s*<${want}\\b`)); // 포매터가 아이콘을 다음 줄로 내릴 수 있다
    }
  });

  it('표의 키는 모두 화면 코드의 단추에 있다', () => {
    const used = new Set(all.map((b) => b.key));
    for (const k of Object.keys(ICONS)) expect(used, k).toContain(k);
  });
});

// 접고 펼치는 단추는 공통 부품만 쓴다(스펙 2026-10-19-005). 화면이 Button 에 aria-expanded 를 직접 붙이면 아이콘·포커스 링·손가락 높이가 빠진다.
// 번역 키를 읽지 않으므로 t(조건 ? … : …) 로 글자를 고르는 단추도 걸린다(외부 검토 O1). IconButton·ButtonBase·메뉴의 aria-expanded 는 대상이 아니다
describe('접고 펼치는 단추(DisclosureButton)', () => {
  it('<Button> 에 aria-expanded 를 직접 붙이지 않는다', () => {
    const bad: string[] = [];
    for (const [p, text] of sources(SRC)) {
      if (p.endsWith('DisclosureButton.tsx')) continue;
      for (const m of text.matchAll(/<Button\b/g)) {
        let i = m.index + m[0].length;
        let depth = 0;
        for (; i < text.length; i++) {
          const c = text[i];
          if (c === '{') depth++;
          else if (c === '}') depth--;
          else if (c === '>' && depth === 0) break;
        }
        if (/\baria-expanded=/.test(text.slice(m.index, i))) bad.push(`${p.slice(SRC.length + 1)}:${text.slice(0, m.index).split('\n').length}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
