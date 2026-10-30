/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
// zip 올리기 공용 부품(스펙 2026-10-29-002 DD15). 작업공간 「새 스킬 › zip 올리기」(OMAI-1195 §3-6 DR1~DR17)와
// 스킬 마켓 「스킬 허브에 게시」가 같이 쓴다 — 드롭 영역·파일 칩·스크립트 확인·파일 목록이 두 화면에서 어긋나지 않게.
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FolderZipOutlinedIcon from '@mui/icons-material/FolderZipOutlined';
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import { Alert, Box, Button, Checkbox, CircularProgress, FormControlLabel, Stack, Theme, Typography } from '@mui/material';
import { RefObject, useEffect, useRef, useState } from 'react';

import { Mono } from '@/components/bits';
import { tier2 } from '@/components/tierButton';
import { getLang, t } from '@/i18n';
import { api, ApiError } from '@/lib/api';

export const ZIP_MAX = 512 * 1024; // 서버 UPLOAD_MAX 와 같은 값(OMAI-1195 R2, 설치 묶음 한도 — 2026-10-29-002 R1). 보내기 전에 화면이 먼저 거른다
export const FILES_SHOWN = 50;

export interface ZipFile {
  path: string;
  size: number;
}
export interface ZipScript {
  path: string;
  summary: string;
  hosts: string[];
}

/** 파일을 그대로 보내는 요청(zip). api.ts 의 post 는 JSON 만 보내서 여기서 같은 규칙(X-AAS, 로그인 만료, 오류 본문)으로 따로 보낸다. */
export async function sendZip<T>(url: string, file: File): Promise<T> {
  const r = await fetch(url, { method: 'POST', body: file, headers: { 'Content-Type': 'application/zip', 'X-AAS': '1', 'Accept-Language': getLang() } });
  if (r.status === 401) {
    api.toLogin('/auth/login?next=' + encodeURIComponent(window.location.pathname + window.location.hash));
    throw new Error(t('common.loginRequired'));
  }
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new ApiError(body.error || r.statusText, r.status);
  return body;
}

/** 고른 파일이 보낼 수 있는지 — 아니면 오류 문구(보내기 전에 화면이 거른다, DR7). */
export function zipProblem(f: File): string {
  if (!/\.zip$/i.test(f.name)) return t('skills.zipNotZip');
  if (f.size > ZIP_MAX) return t('skills.zipTooBig');
  return '';
}

const wash = (th: Theme) => (th.palette.mode === 'dark' ? 'rgba(255,255,255,' : 'rgba(17,24,39,');

/** 드롭 영역 + 숨은 파일 입력(DR12). sub 는 보조 문구. */
export function ZipDropZone({ show, busy, onPick, pickRef, sub }: { show: boolean; busy: boolean; onPick: (f: File | undefined) => void; pickRef: RefObject<HTMLInputElement | null>; sub: string }) {
  const [dragging, setDragging] = useState(false);
  return (
    <>
      {show && (
        <Box
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            onPick(e.dataTransfer.files[0]);
          }}
          sx={(th) => ({
            minHeight: 120,
            p: 2,
            borderRadius: '12px',
            border: '1px dashed',
            borderColor: `${wash(th)}${dragging ? '0.18' : th.palette.mode === 'dark' ? '0.08' : '0.10'})`,
            bgcolor: dragging ? `${wash(th)}${th.palette.mode === 'dark' ? '0.06' : '0.04'})` : `${wash(th)}0.02)`,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            justifyContent: 'center',
            gap: 0.5,
          })}
        >
          <FolderZipOutlinedIcon fontSize="small" sx={{ color: 'text.secondary' }} />
          <Typography variant="body2">{t('skills.zipDrop')}</Typography>
          <Typography variant="caption" color="text.secondary">
            {sub}
          </Typography>
          <Button size="small" variant="outlined" color="inherit" sx={{ ...tier2, mt: 0.5, width: { xs: '100%', sm: 'auto' } }} disabled={busy} onClick={() => pickRef.current?.click()}>
            {t('skills.zipPick')}
          </Button>
        </Box>
      )}
      <input
        ref={pickRef}
        type="file"
        accept=".zip,application/zip"
        aria-label={t('skills.zipInputLabel')}
        hidden
        onChange={(e) => {
          onPick(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
    </>
  );
}

/** 고른 파일 한 줄: 이름·크기·교체·제거. */
export function ZipFileChip({ file, checking, busy, onReplace, onRemove }: { file: File; checking: boolean; busy: boolean; onReplace: () => void; onRemove: () => void }) {
  return (
    <Stack direction="row" spacing={1} alignItems="center">
      <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>
        {`${file.name} (${Math.max(1, Math.round(file.size / 1024))}KiB)`}
      </Typography>
      {checking && <CircularProgress size={14} color="inherit" />}
      <Button size="small" variant="outlined" color="inherit" sx={tier2} disabled={busy} onClick={onReplace}>
        {t('skills.zipReplace')}
      </Button>
      <Button size="small" variant="outlined" color="inherit" sx={tier2} disabled={busy} onClick={onRemove}>
        {t('skills.zipRemove')}
      </Button>
    </Stack>
  );
}

/** 스크립트 확인: 대화상자 없이 amber 상자 + 확인 체크(DR8·DR11). 스크립트가 없으면 그리지 않는다. */
export function ScriptReview({ scripts, confirmed, onConfirm }: { scripts: ZipScript[]; confirmed: boolean; onConfirm: (v: boolean) => void }) {
  if (!scripts.length) return null;
  return (
    <Alert severity="warning" icon={<WarningAmberRoundedIcon fontSize="small" />}>
      <Typography variant="body2" sx={{ fontWeight: 500 }}>
        {t('skills.zipScriptWarn', { count: scripts.length })}
      </Typography>
      {scripts.map((sc) => (
        <Box key={sc.path} sx={{ mt: 0.5 }}>
          <Mono>{sc.path}</Mono>
          {` — ${sc.summary || t('skills.zipNoSummary')}`}
          <Typography variant="caption" component="div" color="text.secondary">
            {sc.hosts.length ? t('skills.zipScriptHosts', { hosts: sc.hosts.join(', ') }) : t('skills.zipNoHosts')}
          </Typography>
        </Box>
      ))}
      <FormControlLabel sx={{ mt: 0.5 }} control={<Checkbox size="small" checked={confirmed} onChange={(e) => onConfirm(e.target.checked)} />} label={t('skills.zipConfirm')} />
    </Alert>
  );
}

/** 파일 목록: 스크립트가 위로, 50개까지 보이고 「나머지 N개 보기」(DR15, 스펙 2026-10-19-005 G8·R5). */
export function ZipFileList({ files, scripts }: { files: ZipFile[]; scripts: ZipScript[] }) {
  const [showAll, setShowAll] = useState(false);
  const firstNew = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (showAll) firstNew.current?.focus();
  }, [showAll]);
  const scriptPaths = new Set(scripts.map((x) => x.path));
  const ordered = [...files].sort((a, b) => Number(scriptPaths.has(b.path)) - Number(scriptPaths.has(a.path)));
  const shown = showAll ? ordered : ordered.slice(0, FILES_SHOWN);
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        {t('skills.zipFiles', { count: files.length })}
      </Typography>
      <Box component="ul" sx={{ m: 0, pl: 2.5, fontSize: 13 }}>
        {shown.map((f, i) => (
          <li key={f.path} {...(showAll && i === FILES_SHOWN ? { ref: firstNew, tabIndex: -1 } : {})}>
            <Mono>{f.path}</Mono>
            {` ${f.size}B`}
          </li>
        ))}
      </Box>
      {!showAll && ordered.length > FILES_SHOWN && (
        // 펼치기만 하는 단추: 같은 펼침 아이콘을 앞에 두고 돌리지 않는다(다시 접기가 없다, 스펙 2026-10-19-005 R5)
        <Button size="small" variant="text" color="inherit" startIcon={<ExpandMoreIcon />} onClick={() => setShowAll(true)}>
          {t('skills.zipMore', { count: ordered.length - FILES_SHOWN })}
        </Button>
      )}
    </Box>
  );
}
