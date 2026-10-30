/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 한/영 전환. 언어를 바꾸면 아래 화면 트리를 key 로 다시 그려 모든 문장이 한 번에 바뀐다(열려 있던 서랍·입력 중이던 값은 닫힌다).
// 채팅 상태는 이 바깥에 있어 유지된다. 서버가 언어별로 번역해 주는 응답(비밀값·스킬 설명 등)은 질의 캐시를 비워 새 언어로 다시 읽고,
// 웹소켓은 hello 의 언어로 번역하므로 새로 연다(스펙 2026-10-21-007).
import { QueryClientContext } from '@tanstack/react-query';
import { createContext, Fragment, ReactNode, useCallback, useContext, useMemo, useState } from 'react';

import { getLang, Lang, setLang as storeLang, t, Vars } from '@/i18n';
import { wsClient } from '@/lib/ws';

interface I18nCtx {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: string, vars?: Vars) => string;
}

const Ctx = createContext<I18nCtx>({ lang: 'ko', setLang: () => undefined, t });

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setState] = useState<Lang>(getLang);
  const qc = useContext(QueryClientContext); // 시험처럼 QueryClientProvider 없이 쓰는 곳도 있다
  const setLang = useCallback(
    (next: Lang) => {
      if (next === getLang()) return;
      storeLang(next);
      wsClient.changeLang(); // 먼저 연결을 바꿔야 다시 읽는 요청이 새 언어로 간다(새 연결 전에는 HTTP 로 읽는다)
      void qc?.resetQueries(); // 무효만 하면 새 응답이 올 때까지(서버가 처음 만들면 몇 초) 옛 언어가 보인다 — 처음 열 때처럼 비우고 다시 읽는다
      setState(next);
    },
    [qc]
  );
  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang]);
  return (
    <Ctx.Provider value={value}>
      <Fragment key={lang}>{children}</Fragment>
    </Ctx.Provider>
  );
}

export const useI18n = (): I18nCtx => useContext(Ctx);

/** 컴포넌트에서 t 를 부르는 훅. 언어가 바뀌면 트리가 다시 그려지므로 t 자체는 같은 함수다. */
export const useT = (): typeof t => useContext(Ctx).t;
