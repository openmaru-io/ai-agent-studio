/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 운영 화면의 목록 행에서 설정을 고치는 곳으로 보내는 「편집」 링크(스펙 ui/ops-edit-links.md, OMAI-1210).
// 편집할 수 있는 사람(관리자와 그 POD 의 주인)에게만 열을 그린다. 누르면 이동만 하고 상태를 바꾸지 않는다.
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import { Button } from '@mui/material';
import { Link } from 'react-router-dom';

import type { GridColumn } from '@/components/DataGrid';
import { t } from '@/i18n';

import { isAdmin, useMe } from './data';

export interface EditTarget {
  /** 화면 id (경로의 첫 마디) */
  to: string;
  params?: Record<string, string | undefined>;
}

export const editHref = ({ to, params }: EditTarget): string => {
  const qs = new URLSearchParams(Object.entries(params ?? {}).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)])).toString();
  return '/' + to + (qs ? '?' + qs : '');
};

/** 설정을 고칠 수 있는가: 관리자 또는 이 POD 의 주인. 아직 모르면 거짓(열을 그리지 않는다) */
export function useCanEditSettings(): boolean {
  const me = useMe().data;
  return isAdmin(me) || !!me?.owner;
}

/** 표 칸 안의 작은 글자 단추. 행을 눌러 서랍이 열리지 않게 이벤트를 멈춘다 */
export function EditLink({ target, name }: { target: EditTarget; name?: string }) {
  return (
    <Button
      component={Link}
      to={editHref(target)}
      size="small"
      variant="text"
      color="inherit"
      startIcon={<EditOutlinedIcon fontSize="small" />}
      aria-label={name ? t('common.editOf', { name }) : undefined}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      sx={{ minWidth: 0, color: 'text.secondary', textTransform: 'none', px: 0.75 }}
    >
      {t('common.edit')}
    </Button>
  );
}

/**
 * 표의 마지막 「편집」 열. target 이 null 을 주는 행은 빈 칸이다. 권한이 없으면 열 자체가 없다(결정 ④).
 * 사용: columns={[...열들, ...useEditColumn(row => ({ to: 'profiles', params: { name: row.name } }), (row) => row.name)]}
 */
export function useEditColumn<T>(target: (row: T) => EditTarget | null, rowName?: (row: T) => string): GridColumn<T>[] {
  const can = useCanEditSettings();
  if (!can) return [];
  return [
    {
      id: 'edit',
      label: t('common.edit'),
      value: () => '',
      sort: false,
      hideable: false,
      width: '88px',
      render: (row: T) => {
        const tg = target(row);
        return tg ? <EditLink target={tg} name={rowName?.(row)} /> : null;
      },
    },
  ];
}

// ── 변경 기록 행 → 그 변경이 일어난 설정(스펙 §3-3) ──
// 서버가 프로파일 변경을 f"{who} {프로파일} ..." 로 적어 detail 의 첫 낱말이 프로파일 이름이다. 읽을 수 없는 행은 null.
const PANE_OF: Record<string, string | undefined> = {
  profile_soul: 'soul',
  profile_soul_revert: 'soul',
  // 작업 지침(AGENTS.md). 「확인함」도 그 탭으로 보낸다(2026-10-19-004 §10 H3·L4)
  profile_agents: 'agents',
  profile_agents_revert: 'agents',
  profile_agents_ack: 'agents',
  profile_config: 'config',
  profile_config_revert: 'config',
  profile_env_set: 'env',
  profile_env_clear: 'env',
  profile_skill: 'skills',
  profile_toolset: 'tools',
  profile_mcp: 'tools',
  profile_gateway: 'channels',
  profile_model: undefined,
  profile_describe: undefined,
  profile_create: undefined,
  profile_rename: undefined,
};
const firstWord = (d?: string) => (d ?? '').trim().split(/\s+/)[0] ?? '';

export function changeEditTarget(row: { kind: string; detail?: string; failed?: boolean }): EditTarget | null {
  const word = firstWord(row.detail);
  // 인증 파일: 「<프로파일> <경로>」. 성공한 줄만 그 파일 줄로 바로 간다(?file=, 2026-10-22-004 R12)
  if (row.kind === 'profile_credential_put' || row.kind === 'profile_credential_clear') {
    const file = (row.detail ?? '').trim().split(/\s+/)[1];
    return !row.failed && word && file ? { to: 'profiles', params: { name: word, pane: 'env', file } } : null;
  }
  if (row.kind in PANE_OF) {
    if (!word || word.includes('/')) return null;
    return { to: 'profiles', params: { name: word, pane: PANE_OF[row.kind] } };
  }
  if (row.kind.startsWith('cron_') && !row.kind.startsWith('cron_office_')) {
    const [profile, job] = word.split('/');
    return profile && job ? { to: 'profiles', params: { name: profile, pane: 'cron' } } : null;
  }
  if (row.kind === 'skill_create' || row.kind === 'skill_upload') {
    const [profile, name] = word.split('/');
    return name ? { to: 'skills', params: { tab: 'all', profile, q: name } } : null;
  }
  if (row.kind === 'skill_save' || row.kind === 'skill_revert') {
    const parts = word.split('/').filter(Boolean);
    const i = parts.lastIndexOf('SKILL.md');
    // skills/<분류>/<스킬>/SKILL.md → 스킬 이름. profiles/<p>/ 로 시작하면 그 프로파일, 아니면 어느 프로파일인지 몰라 전체(스펙 2026-10-27-013 §4-5)
    const profile = parts[0] === 'profiles' && parts[1] ? parts[1] : '*';
    return i > 0 ? { to: 'skills', params: { tab: 'all', profile, q: parts[i - 1] } } : null;
  }
  return null;
}
