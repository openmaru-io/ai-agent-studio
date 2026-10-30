/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 기간(?days=)을 주소에서 읽고 바꾼다. 허용 값이 아니거나 없으면 기본값이고, 기본값은 주소에서 뺀다.
import { useSearchParams } from 'react-router-dom';

export function useDays(allowed: number[], dflt: number): [number, (days: number) => void] {
  const [params, setParams] = useSearchParams();
  const raw = Number(params.get('days'));
  const days = allowed.includes(raw) ? raw : dflt;
  const set = (n: number) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (n === dflt) next.delete('days');
        else next.set('days', String(n));
        return next;
      },
      { replace: true }
    );
  return [days, set];
}
