/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 서랍·펼친 양식이 열릴 때 첫 입력 칸에 커서를 둔다(autoFocus 속성 대신).
import { useEffect, useRef } from 'react';

export function useFocusOnMount<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return ref;
}
