/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 부서를 고르는 선택 전용 입력(스펙 2026-10-15-026, 디자인 리뷰 2B·3B·5A). PersonPicker·AgentPicker 와 같은 틀이다:
// 열면 전체 목록, 글자를 치면 포함 검색. 다른 점은 자유 입력을 끈 것이다 — 부서는 관리자가 사용자 메뉴의 부서 탭에서 정한 목록에서만 고른다.
// 값은 목록의 부서 이름이거나 비움(부서 없음)이다. 목록에 없는 현재 값(Keycloak 콘솔에서 직접 고친 경우 등)은 지우지 않고 보인다:
// 칸에 값을 그대로 두고 칸 아래에 호박색 도움말, 드롭다운에는 「목록에 없음」 알약과 함께 한 줄로 놓는다(5A).
// 상태: 불러오는 중이면 칸을 끄고 안내, 받지 못했으면 칸을 끄고 「다시 시도」, 목록이 비었으면 칸을 끄고 부서 탭 링크와 「목록 새로 고침」(3B).
import { Autocomplete, Box, Button, FormHelperText, TextField } from '@mui/material';
import { ReactNode, Ref, useId } from 'react';

import { t } from '@/i18n';

import { Pill } from './DataGrid';

export function DepartmentPicker({
  label,
  value,
  onChange,
  options,
  status,
  onRetry,
  current,
  disabled,
  error,
  helperText,
  inputRef,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** 부서 목록의 이름 */
  options: string[];
  /** 목록을 받는 상태 */
  status: 'loading' | 'error' | 'ready';
  /** 「다시 시도」「목록 새로 고침」: 목록을 다시 받는다 */
  onRetry: () => void;
  /** 이 사용자의 지금 부서(수정 창). 목록에 없으면 값을 지우지 않고 보인다 */
  current?: string;
  disabled?: boolean;
  error?: boolean;
  /** 칸 아래 도움말(서버 오류 등) */
  helperText?: ReactNode;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const helpId = useId();
  const offList = !!current && !options.includes(current);
  const list = offList ? [current as string, ...options] : options;
  const empty = status === 'ready' && options.length === 0 && !offList;
  const off = status !== 'ready' || empty;

  let help: ReactNode = helperText;
  let alert = false;
  if (!helperText) {
    if (status === 'loading') help = t('users.dept.pick.loading');
    else if (status === 'error') {
      alert = true;
      help = (
        <>
          {t('users.dept.pick.failed')}{' '}
          <Button size="small" color="inherit" sx={{ p: 0, minWidth: 0, textDecoration: 'underline', verticalAlign: 'baseline' }} onClick={onRetry}>
            {t('users.dept.pick.retry')}
          </Button>
        </>
      );
    } else if (empty)
      help = (
        <>
          {t('users.dept.pick.none')}{' '}
          <a href={`${window.location.pathname}#/users?tab=departments`} target="_blank" rel="noopener noreferrer">
            {t('users.dept.pick.openTab')}
          </a>
          {t('users.dept.pick.afterTab')}{' '}
          <Button size="small" color="inherit" sx={{ p: 0, minWidth: 0, textDecoration: 'underline', verticalAlign: 'baseline' }} onClick={onRetry}>
            {t('users.dept.pick.refresh')}
          </Button>
          {t('users.dept.pick.press')}
        </>
      );
    else if (offList && value === current) help = <Box component="span" sx={{ color: 'warning.main' }}>{t('users.dept.pick.offList')}</Box>;
  }

  return (
    <Box>
      <Autocomplete<string, false, false, false>
        openOnFocus
        size="small"
        options={list}
        value={value || null}
        onChange={(_, v) => onChange(v ?? '')}
        disabled={disabled || off}
        clearText={t('common.clear')}
        noOptionsText={t('users.dept.pick.noOptions')}
        isOptionEqualToValue={(a, b) => a === b}
        slotProps={{ paper: { sx: { border: 1, borderColor: 'divider', backgroundImage: 'none' } } }}
        renderOption={(props, name) => {
          const { key, ...rest } = props as typeof props & { key: string };
          return (
            <Box component="li" key={key} {...rest}>
              {name}
              {offList && name === current && <Pill tone="warn">{t('users.dept.notListed')}</Pill>}
            </Box>
          );
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            inputRef={inputRef}
            label={label}
            error={error}
            slotProps={{ htmlInput: { ...params.inputProps, spellCheck: false, 'data-field': 'department', 'aria-describedby': help ? helpId : undefined } }}
          />
        )}
      />
      {help && (
        <FormHelperText id={helpId} error={error} role={alert ? 'alert' : undefined} aria-busy={status === 'loading' || undefined} sx={{ mx: '14px' }}>
          {help}
        </FormHelperText>
      )}
    </Box>
  );
}
