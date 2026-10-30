/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 사람(사용자)을 고르거나 직접 적는 입력(OMAI-1229). AgentPicker·SkillPicker 와 같은 모양이다: 열면 전체 목록, 글자를 치면 포함 검색.
// 목록에 없는 글자도 그대로 값이 된다(freeSolo) — 담당은 팀 이름·예전에 적은 값이 있고, 새 주인은 아직 목록에 없는 이메일일 수 있다.
// 값은 입력 칸의 글자(문자열 하나)다. store 가 목록에서 고를 때 값으로 넣을 것을 정한다: 'name'(표시 이름) 또는 'email'.
// store='email' 에 showName 을 주면 칸에는 그 사람의 이름을 보이고 값은 이메일로 둔다(TFT 방 담당, 2026-10-20).
// 목록 항목의 둘째 줄은 이메일이 아니라 아이디·부서다(2026-10-20). 이메일로 거르는 것은 그대로다.
import type { SxProps, Theme } from '@mui/material';
import { Autocomplete, Box, Chip, createFilterOptions, TextField, Typography } from '@mui/material';
import type { Ref } from 'react';
import { useState } from 'react';

import { t } from '@/i18n';
import type { Person } from '@/lib/people';

const LIMIT = 100;
const contains = createFilterOptions<Person>({ limit: LIMIT, stringify: (p) => `${p.name} ${p.email} ${p.username ?? ''} ${p.department ?? ''}` });

/** 목록 항목: 이름, 그 아래 작게 아이디·부서 */
function PersonOption({ props, person }: { props: object; person: Person }) {
  const { key, ...rest } = props as typeof props & { key: string };
  return (
    <Box component="li" key={key} {...rest}>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="body2" noWrap>
          {person.name}
        </Typography>
        <Typography variant="caption" color="text.secondary" noWrap component="div">
          {[person.username, person.department].filter(Boolean).join(' · ')}
        </Typography>
      </Box>
    </Box>
  );
}

export function PersonPicker({
  label,
  value,
  onChange,
  people,
  store,
  showName = false,
  placeholder,
  inputRef,
  sx,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  people: Person[];
  store: 'name' | 'email';
  /** store='email' 일 때 칸에 이메일 대신 이름을 보인다. 값(onChange)은 그대로 이메일이다 */
  showName?: boolean;
  placeholder?: string;
  inputRef?: Ref<HTMLInputElement>;
  sx?: SxProps<Theme>;
}) {
  const named = showName && store === 'email';
  const text = (p: Person) => (store === 'email' && !named ? p.email : p.name);
  // named: 치는 동안의 글자. 고르면 비우고 값(이메일)의 사람 이름을 보인다. 목록에 없는 값(옛 담당 글자)은 그대로 보인다
  const [typed, setTyped] = useState<string | null>(null);
  const chosen = named ? people.find((p) => p.email.toLowerCase() === value.trim().toLowerCase()) : undefined;
  const shown = named ? (typed ?? (chosen ? chosen.name : value)) : value;
  // 입력이 목록 항목의 값과 정확히 같으면(이미 고른 값) 걸러 내지 않고 전체를 보여, 다른 사람으로 바꾸러 열었을 때 한 명만 보이지 않게 한다
  const filter = (opts: Person[], state: { inputValue: string; getOptionLabel: (o: Person) => string }) =>
    opts.some((p) => text(p) === state.inputValue) ? opts.slice(0, LIMIT) : contains(opts, state);
  // named 에서 이름을 다 치고 Enter 면, 그 이름이 한 사람뿐일 때 그 사람의 이메일을 값으로 한다
  const pick = (v: Person | string | null) => {
    if (!named || v === null) return;
    const byName = typeof v === 'string' ? people.filter((p) => p.name === v.trim()) : [];
    const person = typeof v === 'string' ? (byName.length === 1 ? byName[0] : undefined) : v;
    if (!person) return;
    setTyped(null);
    onChange(person.email);
  };
  return (
    <Autocomplete<Person, false, false, true>
      freeSolo
      openOnFocus
      size="small"
      options={people}
      inputValue={shown}
      onInputChange={(_, v, reason) => {
        if (!named) return onChange(v);
        if (reason === 'reset') return; // 고른 뒤 MUI 가 칸을 맞추는 호출. 보이는 글자는 값에서 정한다
        setTyped(v);
        onChange(v);
      }}
      onChange={(_, v) => pick(v)}
      filterOptions={filter}
      getOptionLabel={(o) => (typeof o === 'string' ? o : text(o))}
      isOptionEqualToValue={(a, b) => a.email === b.email}
      noOptionsText={t('common.personPickerNone')}
      sx={sx}
      slotProps={{ paper: { sx: { border: 1, borderColor: 'divider', backgroundImage: 'none' } } }}
      renderOption={(props, p) => <PersonOption props={props} person={p} />}
      renderInput={(params) => (
        <TextField
          {...params}
          inputRef={inputRef}
          label={label}
          placeholder={placeholder}
          slotProps={{ htmlInput: { ...params.inputProps, spellCheck: false } }}
        />
      )}
    />
  );
}

/** 여러 사람을 고르는 입력(TFT 방 구성원, 2026-10-18). 값은 이메일 목록이고 칩에는 이름을 보인다.
 *  목록에 없는 이메일도 적고 Enter 를 누르면 들어간다(옛 방식 사용자·아직 목록에 없는 사람). 이메일 모양이 아니면 서버가 거절한다 */
export function PersonMultiPicker({
  label,
  value,
  onChange,
  people,
  helperText,
  fixed = [],
  chip,
  error = false,
  disabled = false,
  inputRef,
}: {
  label: string;
  value: string[];
  onChange: (emails: string[]) => void;
  people: Person[];
  helperText?: string;
  /** 지울 수 없는 사람(담당). 칩에 삭제 단추를 두지 않는다 */
  fixed?: string[];
  /** 칩 하나의 모양을 바꾼다(팀 관리자 지정 창의 부서를 옮긴 사람, OMAI-1434 DD4). label 은 이름, muted 면 줄을 그은 회색 칩 */
  chip?: (email: string) => { label?: string; title?: string; muted?: boolean } | undefined;
  error?: boolean;
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const byEmail = new Map(people.map((p) => [p.email.toLowerCase(), p]));
  const nameOf = (email: string) => byEmail.get(email.toLowerCase())?.name || email;
  const keep = new Set(fixed.map((x) => x.toLowerCase()));
  return (
    <Autocomplete<Person | string, true, false, true>
      multiple
      freeSolo
      openOnFocus
      disableCloseOnSelect
      disabled={disabled}
      size="small"
      options={people}
      value={value}
      onChange={(_, v) => {
        const next = v.map((x) => (typeof x === 'string' ? x.trim() : x.email)).filter(Boolean);
        const out = [...new Set([...fixed, ...next].map((x) => x.toLowerCase()))];
        onChange(out);
      }}
      filterOptions={(opts, state) => contains((opts as Person[]).filter((p) => !value.some((v) => v.toLowerCase() === p.email.toLowerCase())), state)}
      getOptionLabel={(o) => (typeof o === 'string' ? nameOf(o) : o.name)}
      isOptionEqualToValue={(a, b) => (typeof a === 'string' ? a : a.email).toLowerCase() === (typeof b === 'string' ? b : b.email).toLowerCase()}
      noOptionsText={t('common.personPickerNone')}
      slotProps={{ paper: { sx: { border: 1, borderColor: 'divider', backgroundImage: 'none' } } }}
      renderTags={(vals, getTagProps) =>
        vals.map((v, i) => {
          const email = typeof v === 'string' ? v : v.email;
          const { key, onDelete, ...rest } = getTagProps({ index: i });
          const look = chip?.(email);
          return (
            <Chip
              key={key}
              size="small"
              label={look?.label || nameOf(email)}
              title={look?.title ?? email}
              onDelete={keep.has(email.toLowerCase()) ? undefined : onDelete}
              {...rest}
              {...(look?.muted ? { 'data-moved': '' } : {})}
              sx={look?.muted ? { color: 'text.disabled', '& .MuiChip-label': { textDecoration: 'line-through' } } : undefined}
            />
          );
        })
      }
      renderOption={(props, p) => <PersonOption props={props} person={p as Person} />}
      renderInput={(params) => (
        <TextField
          {...params}
          inputRef={inputRef}
          label={label}
          error={error}
          helperText={helperText}
          slotProps={{ htmlInput: { ...params.inputProps, spellCheck: false } }}
        />
      )}
    />
  );
}
