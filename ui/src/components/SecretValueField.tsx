/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 점으로 가린 비밀 값 칸. 오른쪽 아이콘으로 세션 안에서만 잠깐 확인한다(MCP 스펙 §11 결정 8A).
// MCP 서버 화면·템플릿 설치(스펙 2026-11-18-002)·자격 증명 화면 「새 비밀값」·스킬 화면 「값 넣기」 창(스펙 2026-11-18-004)이 함께 쓴다.
// 원래 profiles/McpServers.tsx 의 SecretField 였다 — 그 이름으로도 다시 내보낸다.
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import { IconButton, InputAdornment, TextField } from '@mui/material';
import { ReactNode, useId, useState } from 'react';

import { t } from '@/i18n';
import { MONO_FONT } from '@/lib/monoFont';

const TOUCH = { minHeight: 44, minWidth: 44 };

export function SecretValueField({
  label,
  value,
  onChange,
  error,
  helper,
  inputRef,
  required,
  disabled,
  invalid,
}: {
  /** 칸 레이블. 키 이름을 쓴다(늘 보이는 레이블, 자리표시자를 레이블로 쓰지 않는다) */
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** 있으면 오류 상태(aria-invalid)이고 도움말 자리에 보인다 */
  error?: string;
  /** 칸 아래 설명. 칸의 aria-describedby 로 묶인다 */
  helper?: ReactNode;
  inputRef?: (el: HTMLInputElement | null) => void;
  required?: boolean;
  disabled?: boolean;
  /** 오류 문구 없이 오류 상태만(칸 아래 다른 곳에 이유를 보일 때). 도움말은 그대로 남는다 */
  invalid?: boolean;
}) {
  const [shown, setShown] = useState(false);
  const helpId = useId();
  return (
    <TextField
      size="small"
      fullWidth
      required={required}
      disabled={disabled}
      label={label}
      type={shown ? 'text' : 'password'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      error={!!error || !!invalid}
      helperText={error || helper}
      inputRef={inputRef}
      slotProps={{
        htmlInput: {
          autoComplete: 'off',
          spellCheck: false,
          'aria-describedby': helper || error ? helpId : undefined,
          style: { fontFamily: MONO_FONT },
        },
        formHelperText: { id: helpId, component: 'div' } as object,
        input: {
          endAdornment: (
            <InputAdornment position="end">
              <IconButton
                size="small"
                edge="end"
                sx={TOUCH}
                disabled={disabled}
                aria-pressed={shown}
                aria-label={t(shown ? 'profiles.mcp.hide' : 'profiles.mcp.show', { label })}
                onClick={() => setShown((v) => !v)}
              >
                {shown ? <VisibilityOffOutlinedIcon fontSize="small" /> : <VisibilityOutlinedIcon fontSize="small" />}
              </IconButton>
            </InputAdornment>
          ),
        },
      }}
    />
  );
}
