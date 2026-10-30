/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
// 화면 머리의 프로파일 고르기 — 스킬 목록(스펙 2026-10-27-013)과 API 키·토큰(스펙 2026-10-28-006)이 함께 쓴다.
// 「전체 프로파일」은 주소 profile=* — CRD 이름 규칙에 * 가 없어 실제 이름과 겹치지 않는다
import { Box, Theme } from '@mui/material';
import { visuallyHidden } from '@mui/utils';
import { useSnackbar } from 'notistack';
import { ChangeEvent, RefObject, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { t } from '@/i18n';
import { useMe } from '@/lib/data';

export const ALL_PROFILES = '*';

const readSaved = (key: string) => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};
const writeSaved = (key: string, p: string) => {
  try {
    window.localStorage.setItem(key, p);
  } catch {
    // 저장소를 못 쓰면 다음에는 처음 값 규칙으로 연다
  }
};

export type ProfileScopeOptions = {
  /** 화면 자료가 왔는가. 오기 전에는 처음 값을 정하지 않는다 */
  ready: boolean;
  /** 고를 수 있는 프로파일(「전체」 빼고), 보일 순서대로 */
  choices: string[];
  /** 선택을 그릴 만큼 프로파일이 여럿인가. 아니면 주소에 맞는 값이 없을 때 「전체」 */
  multi: boolean;
  primary?: string;
  /** 브라우저 저장 키 앞부분. 실제 키는 `<storageKey>:<POD id>` — 화면마다 따로 둔다 */
  storageKey: string;
  /** 없는 이름 알림의 「보이는 값」 이름 */
  labelOf: (p: string) => string;
  /** 화면만의 처음 값(스킬: 주소 open 으로 찾은 줄의 프로파일). 있으면 저장값보다 먼저 */
  initial?: () => string | undefined;
  /** 처음 열 때 행이 없는 프로파일을 건너뛴다(스펙 2026-10-28-006 R8). 주소·저장값으로 고른 값은 0행이어도 그대로 */
  hasRows?: (p: string) => boolean;
  /** 고를 때 주소에서 함께 바꿀 것(스킬: 호출 대상·열린 서랍을 지운다) */
  onPick?: (next: URLSearchParams) => void;
};

/**
 * 처음 값: 주소 → initial() → 이 POD 의 마지막 고른 값 → (행이 있는) 주 프로파일 → (행이 있는) 첫 값 → 「전체」. 정한 값은 주소에 replace.
 * 마지막 고른 값은 me(POD id)가 있어야 읽으므로 자료가 온 뒤 최대 2초 기다리고, 늦게 온 me 로는 바꾸지 않는다(주소가 이미 맞으면 다시 정하지 않는다).
 */
export function useProfileScope(o: ProfileScopeOptions) {
  const [params, setParams] = useSearchParams();
  const { enqueueSnackbar } = useSnackbar();
  const meQ = useMe();
  const me = meQ.data;
  const urlProfile = params.get('profile');
  const valid = (p: string | null): p is string => !!p && (p === ALL_PROFILES || o.choices.includes(p));
  const scope = valid(urlProfile) ? urlProfile : o.multi ? null : ALL_PROFILES;
  const key = me?.pod?.id ? `${o.storageKey}:${me.pod.id}` : null;

  const [meLate, setMeLate] = useState(false);
  const meSettled = !!me || meQ.isError || meLate;
  useEffect(() => {
    if (!o.ready || meSettled) return;
    const id = window.setTimeout(() => setMeLate(true), 2000);
    return () => window.clearTimeout(id);
  }, [o.ready, meSettled]);
  useEffect(() => {
    if (!o.ready || !o.multi || valid(urlProfile)) return;
    const hit = o.initial?.();
    if (!hit && !meSettled) return;
    const saved = key ? readSaved(key) : null;
    const rows = o.hasRows ?? (() => true);
    const next =
      hit ??
      (valid(saved)
        ? saved
        : o.primary && o.choices.includes(o.primary) && rows(o.primary)
          ? o.primary
          : (o.choices.find(rows) ?? (o.hasRows ? ALL_PROFILES : o.choices[0])));
    // 주소에 적힌 프로파일이 없어서 바꿀 때만 한 번 알린다. 저장값이 없어진 것은 사용자가 부른 것이 아니라 조용히(013 디자인 7A)
    if (urlProfile) enqueueSnackbar(t('skills.profileMissing', { name: urlProfile, to: o.labelOf(next) }), { variant: 'info' });
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set('profile', next);
        return p;
      },
      { replace: true }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.ready, o.multi, urlProfile, meSettled]);

  // 바꾼 뒤 화면 읽기 프로그램에 한 번 알리고, 표를 key 로 새로 만들면 선택 상자도 새로 생기므로 포커스를 다시 준다(013 디자인 11A)
  const [picked, setPicked] = useState<string | null>(null);
  const pickerRef = useRef<HTMLSelectElement | null>(null);
  useEffect(() => {
    if (picked && picked === scope) pickerRef.current?.focus();
  }, [picked, scope]);

  const pick = (p: string) => {
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        n.set('profile', p);
        o.onPick?.(n);
        return n;
      },
      { replace: true }
    );
    if (key) writeSaved(key, p);
    setPicked(p);
  };
  return { scope, pick, picked, pickerRef };
}

// 디자인 1A(013): 보이는 라벨 + 테두리 상자. DESIGN.md Inputs 「Sunken」 토큰, 32px(손가락 화면 44px), 값 14px 600. 부제가 <p> 라 MUI 입력(div) 대신 <select>
const pickerSx = (th: Theme) => {
  const dark = th.palette.mode === 'dark';
  return {
    height: 32,
    maxWidth: 240,
    minWidth: 0,
    flex: { xs: 1, sm: '0 1 auto' },
    px: 1,
    borderRadius: '4px',
    border: `1px solid ${dark ? 'rgba(255,255,255,0.08)' : 'rgba(17,24,39,0.10)'}`,
    bgcolor: dark ? 'rgba(0,0,0,0.25)' : 'rgba(17,24,39,0.04)',
    color: 'text.primary',
    font: 'inherit',
    fontSize: 14,
    fontWeight: 600,
    outline: 'none',
    '&:focus-visible': { borderColor: dark ? 'rgba(255,255,255,0.30)' : 'rgba(17,24,39,0.35)' },
    '@media (pointer: coarse)': { height: 44 },
    '& option, & optgroup': { bgcolor: 'background.paper', color: 'text.primary' },
  };
};

/** 부제에 넣는 「프로파일 [고르기 ▾]」. 부제가 <p> 라 span 으로 감싼다 */
export function ProfileScopePicker(props: {
  id: string;
  scope: string;
  choices: string[];
  labelOf: (p: string) => string;
  onPick: (p: string) => void;
  pickerRef: RefObject<HTMLSelectElement | null>;
  /** 고른 직후 화면 읽기 프로그램이 읽을 문장. 처음 열 때는 빈 값 */
  announce: string;
}) {
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, minWidth: 0, width: { xs: '100%', sm: 'auto' } }}>
      <Box component="label" htmlFor={props.id} sx={{ fontSize: 13, color: 'text.secondary', flexShrink: 0 }}>
        {t('skills.profileLabel')}
      </Box>
      <Box
        component="select"
        id={props.id}
        ref={props.pickerRef}
        value={props.scope}
        onChange={(e: ChangeEvent<HTMLSelectElement>) => props.onPick(e.target.value)}
        sx={pickerSx}
      >
        <optgroup label={t('skills.profileLabel')}>
          {props.choices.map((p) => (
            <option key={p} value={p}>
              {props.labelOf(p)}
            </option>
          ))}
        </optgroup>
        <option value={ALL_PROFILES}>{t('skills.profileAll')}</option>
      </Box>
      <Box component="span" aria-live="polite" sx={visuallyHidden}>
        {props.announce}
      </Box>
    </Box>
  );
}
