/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 에이전트(프로파일·자리)를 검색해서 고르는 입력(OMAI-1225). 스킬을 고르는 SkillPicker 와 같은 모양이다:
// 열면 전체 목록, 글자를 치면 포함 검색. 다른 점은 목록에 있는 것만 고른다는 것이다(없는 에이전트는 서버가 거절한다).
// 값은 문자열 하나다. 빈 선택이 있는 곳(emptyLabel)은 입력을 지우면 ''(예: 「빈 상태에서 시작」·「담당 없음」)이고 그 문구가 흐린 글자로 보인다.
import type { SxProps, Theme } from '@mui/material';
import { Autocomplete, Box, createFilterOptions, TextField } from '@mui/material';
import type { Ref } from 'react';

import { t } from '@/i18n';

export interface AgentOption {
  value: string;
  /** 목록과 입력 칸에 보이는 글자(표시 이름·별칭 등) */
  label: string;
  /** 있으면 고를 수 없고 흐리게 보이며 이 이유가 오른쪽에 붙는다(예: 「가득 참 3/3」, 스펙 2026-10-19-018 디자인 DD8) */
  disabledReason?: string;
}

const filter = createFilterOptions<AgentOption>({ limit: 200, stringify: (o) => `${o.label} ${o.value}` });

export function AgentPicker({
  label,
  value,
  onChange,
  options,
  emptyLabel,
  inputRef,
  sx,
}: {
  /** 눈에 보이는 라벨이자 접근 이름 */
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: AgentOption[];
  /** 있으면 비울 수 있고(지우기 ×), 비었을 때 입력 칸에 이 문구가 보인다 */
  emptyLabel?: string;
  inputRef?: Ref<HTMLInputElement>;
  sx?: SxProps<Theme>;
}) {
  const clearable = emptyLabel !== undefined;
  return (
    <Autocomplete<AgentOption, false, boolean, false>
      openOnFocus
      autoHighlight
      size="small"
      options={options}
      value={options.find((o) => o.value === value) ?? null}
      onChange={(_, o) => onChange(o?.value ?? '')}
      isOptionEqualToValue={(a, b) => a.value === b.value}
      getOptionLabel={(o) => o.label}
      getOptionDisabled={(o) => !!o.disabledReason}
      renderOption={(props, o) => {
        const { key, ...rest } = props as typeof props & { key: string };
        return (
          <Box component="li" key={key} {...rest} sx={{ display: 'flex', gap: 1, justifyContent: 'space-between' }}>
            <span>{o.label}</span>
            {o.disabledReason && (
              <Box component="span" sx={{ color: 'text.secondary', fontSize: 12, flexShrink: 0 }}>
                {o.disabledReason}
              </Box>
            )}
          </Box>
        );
      }}
      filterOptions={filter}
      disableClearable={!clearable as boolean}
      noOptionsText={t('common.agentPickerNone')}
      clearText={t('common.agentPickerClear')}
      sx={sx}
      slotProps={{ paper: { sx: { border: 1, borderColor: 'divider', backgroundImage: 'none' } } }}
      renderInput={(params) => (
        <TextField
          {...params}
          inputRef={inputRef}
          label={label}
          placeholder={emptyLabel}
          slotProps={{ htmlInput: { ...params.inputProps, spellCheck: false } }}
        />
      )}
    />
  );
}
