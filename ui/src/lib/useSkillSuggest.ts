/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 입력창 「/」 목록의 스킬을 읽는다(스펙 2026-10-19-012 P4·P5). 목록을 처음 열 때 한 번 읽고, 주소(에이전트·프로파일·자리·방)가
// 바뀌면 버린다. 실패(warning)는 서버가 저장하지 않으므로 「다시 시도」는 바로 다시 읽는다(DD3·DD4).
import { useCallback, useEffect, useRef, useState } from 'react';

import { get } from '@/lib/api';

export interface SkillRow {
  command: string;
  name: string;
  description: string;
  /** 번역을 붙였을 때의 원문. 마우스 올림·거르기에 쓴다(스펙 2026-10-19-017 P6) */
  description_src?: string;
  usage: number;
  /** 회의실: 이 스킬을 가진 참가자 별칭 */
  agents?: string[];
}

/** 「/」 Hermes 내장 명령 한 줄(스펙 2026-10-26-010). 설명·인자 모양은 서버가 화면 언어로 준다 */
export interface CommandRow {
  command: string;
  name: string;
  description: string;
  /** 인자 모양(「<할 말>」·「[턴 수]」). 없으면 빈 글 */
  hint: string;
  /** 인자가 비면 보내지 않는다(steer·queue) */
  required: boolean;
  /** 답하는 중에도 보낼 수 있다(steer·queue, DC6) */
  while_busy?: boolean;
}

/** 「/」 플러그인 명령 한 줄(예: /작업). 설명은 플러그인이 쓴 그대로 */
export interface PluginCommandRow {
  command: string;
  name: string;
  description: string;
  hint: string;
}

export interface SkillList {
  skills: SkillRow[];
  /** 쓸 수 있는 명령(관리하지 않는 사람·회의실은 없음) */
  commands?: CommandRow[];
  /** 알아볼 명령 이름 — 허용 명령과 그 세션 Hermes 의 내장 명령 전부(스펙 2026-10-27-004 R2). 권한·목록 실패와 관계없이 온다.
   *  친 명령을 알아보고 실행할 수 없으면 보내기를 막는다(DC5) — 막지 않으면 /version 같은 글이 모델로 갔다 */
  command_names?: string[];
  /** 허용 명령의 별칭 → 정식 이름(/q → queue, 3단계 R10) */
  command_aliases?: Record<string, string>;
  /** 주인·관리자만 쓰는 명령 — 이 사람에게 빠졌으면 그 까닭을 보인다(3단계 R8) */
  owner_only?: string[];
  /** 같은 이름의 빠른·플러그인 명령이 있어 뺀 명령(R9) */
  commands_blocked?: string[];
  /** 그 에이전트의 Hermes 플러그인이 등록한 명령. 보이기만 한다 — 고르면 글로 보내고 플러그인 훅이 처리한다(command_names 에 없다) */
  plugin_commands?: PluginCommandRow[];
  /** 거짓이면 이 사람은 명령을 쓸 수 없다(오피스 1:1 관리하지 않는 사람, DC13) */
  commands_allowed?: boolean;
  warning?: string;
  /** 회의실: 목록을 읽지 못한 참가자 */
  failed?: string[];
  members?: string[];
}

export interface SkillSuggest {
  /** null 은 아직 읽지 않았거나 읽는 중 */
  data: SkillList | null;
  error: boolean;
  open: () => void;
  retry: () => void;
}

export function useSkillSuggest(url: string | null): SkillSuggest {
  const [data, setData] = useState<SkillList | null>(null);
  const [error, setError] = useState(false);
  const asked = useRef('');
  const seq = useRef(0);

  const load = useCallback(() => {
    if (!url) return;
    asked.current = url;
    const n = ++seq.current;
    setData(null);
    setError(false);
    get<SkillList>(url)
      .then((r) => {
        if (n !== seq.current) return;
        const failed = !!r?.warning && !(r.skills ?? []).length && !r.failed;
        setData({
          skills: r?.skills ?? [],
          warning: r?.warning,
          failed: r?.failed ?? [],
          members: r?.members,
          ...(r?.command_names
            ? {
                commands: r.commands ?? [],
                command_names: r.command_names,
                commands_blocked: r.commands_blocked ?? [],
                commands_allowed: r.commands_allowed !== false,
                command_aliases: r.command_aliases ?? {},
                owner_only: r.owner_only ?? [],
                plugin_commands: r.plugin_commands ?? [],
              }
            : {}),
        });
        setError(failed);
      })
      .catch(() => {
        if (n !== seq.current) return;
        setData({ skills: [] });
        setError(true);
      });
  }, [url]);

  useEffect(() => {
    seq.current++;
    asked.current = '';
    setData(null);
    setError(false);
  }, [url]);

  const open = useCallback(() => {
    if (url && asked.current !== url) load();
  }, [url, load]);

  return { data, error, open, retry: load };
}
