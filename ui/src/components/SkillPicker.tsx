/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 스킬 이름을 검색해서 고르는 입력. 새 크론 작업과 크론 작업 서랍의 「실행할 스킬」이 같이 쓴다.
// 목록에 없는 이름도 그대로 적을 수 있다(freeSolo). 값은 입력 칸의 글자이므로 호출하는 쪽은 문자열 하나만 다룬다.
import type { SxProps, Theme } from '@mui/material';
import { Autocomplete, createFilterOptions, TextField } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import type { Ref } from 'react';
import { useMemo } from 'react';

import { t } from '@/i18n';
import { get } from '@/lib/api';

const LIMIT = 100;
const contains = createFilterOptions<string>({ limit: LIMIT });
// 입력이 목록의 이름과 정확히 같으면(이미 고른 값) 걸러 내지 않고 전체를 보여, 다른 스킬로 바꾸러 열었을 때 한 개만 보이지 않게 한다
const filter = (opts: string[], state: { inputValue: string; getOptionLabel: (o: string) => string }) =>
  opts.includes(state.inputValue) ? opts.slice(0, LIMIT) : contains(opts, state);

/** 그 프로파일에 있는 스킬 이름(정렬·중복 제거). 프로파일에 읽힌 스킬이 없으면 전체 이름을 쓴다 */
export function useSkillNames(profile?: string): string[] {
  const q = useQuery<{ skills: { name: string; profile?: string }[] }>({
    queryKey: ['skills'],
    queryFn: () => get('/api/skills'),
    staleTime: 120000,
  });
  return useMemo(() => {
    const all = q.data?.skills ?? [];
    const mine = profile ? all.filter((s) => s.profile === profile) : all;
    return [...new Set((mine.length ? mine : all).map((s) => s.name))].sort();
  }, [q.data, profile]);
}

export function SkillPicker({
  value,
  onChange,
  profile,
  inputRef,
  sx,
}: {
  value: string;
  onChange: (v: string) => void;
  /** 이 프로파일의 스킬을 먼저(그것만) 보인다 */
  profile?: string;
  inputRef?: Ref<HTMLInputElement>;
  sx?: SxProps<Theme>;
}) {
  const options = useSkillNames(profile);
  return (
    <Autocomplete
      freeSolo
      openOnFocus
      size="small"
      options={options}
      inputValue={value}
      onInputChange={(_, v) => onChange(v)}
      filterOptions={filter}
      noOptionsText={t('cronJob.skillNone')}
      sx={sx}
      slotProps={{ paper: { sx: { border: 1, borderColor: 'divider', backgroundImage: 'none' } } }}
      renderInput={(params) => (
        <TextField
          {...params}
          inputRef={inputRef}
          label={t('cronJob.skillToRun')}
          placeholder={t('cronJob.skillPlaceholder')}
          slotProps={{ htmlInput: { ...params.inputProps, spellCheck: false } }}
        />
      )}
    />
  );
}
