/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 스킬 AI 요약(스펙 docs-plan/marketplace/skill-ai-summary.md, 2026-10-17-002). 스킬 허브 서랍과 스킬 서랍이 함께 쓴다.
// 서버가 저장해 둔 요약을 읽고, 없거나 판이 바뀌었으면 열 때 바로 만든다(사용자 결정 Q1). 「다시 요약」은 10분에 한 번(Q2).
// 스킬 화면의 「개요」 탭은 autoDelay 만큼 머문 뒤에만 만든다(스펙 2026-11-06-003 R1·D3). 표 서랍·스킬 허브는 지금처럼 바로(D9).
// 만든 사람은 보이지 않는다(Q4). 요약은 신뢰할 수 없는 원문에서 나왔으므로 마크다운으로 렌더하지 않고 글자 그대로 보인다.
import { Alert, Box, Button, LinearProgress, Stack, Typography } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ReactNode, useEffect, useId, useRef, useState } from 'react';

import { Tag } from '@/components/bits';
import { DisclosureButton } from '@/components/DisclosureButton';
import { getLang, t } from '@/i18n';
import { ApiError, get, post } from '@/lib/api';
import { fmtTs } from '@/lib/format';

export type SummaryTarget = { ns: string; name: string } | { id: string };

export type SummaryBody = {
  one_line: string;
  use_when: string[];
  what_it_does: string[];
  strengths: string[];
  requires: string[];
  cautions: string[];
};

export type SummaryView = {
  enabled: boolean;
  lang: string;
  summary: SummaryBody | null;
  at: string;
  model: string;
  stale: boolean;
  src: string;
  other: { lang: string; summary: SummaryBody } | null;
};

const query = (target: SummaryTarget): string =>
  'id' in target
    ? `id=${encodeURIComponent(target.id)}`
    : `ns=${encodeURIComponent(target.ns)}&name=${encodeURIComponent(target.name)}`;

const LISTS: [keyof SummaryBody, string][] = [
  ['use_when', 'market.summary.useWhen'],
  ['what_it_does', 'market.summary.whatItDoes'],
  ['strengths', 'market.summary.strengths'],
  ['requires', 'market.summary.requires'],
  ['cautions', 'market.summary.cautions'],
];

// 요약은 가드레일 제외 보조 별칭(cogentai-aas-aux)으로 만든다. 사용자에게는 제품 모델 이름(cogentai-aas)으로 보인다.
const shownModel = (model: string): string => (model === 'cogentai-aas-aux' ? 'cogentai-aas' : model);

function errorText(err: unknown): string {
  if (err instanceof ApiError && err.reason) {
    const key = `market.summary.err.${err.reason}`;
    const text = t(key);
    if (text !== key) return text;
  }
  return err instanceof Error ? err.message : String(err);
}

const summaryKey = (lang: string, target: SummaryTarget) => ['skill-summary', lang, query(target)];

/** 요약 상태(꺼짐·오류·없음·있음)를 부모도 읽는다. AiSummary 와 같은 질의 키라 요청이 늘지 않는다(스펙 2026-11-06-003 OV-H1) */
export function useSummaryView(target: SummaryTarget) {
  const lang = getLang();
  return useQuery<SummaryView>({
    queryKey: summaryKey(lang, target),
    queryFn: () => get<SummaryView>(`/api/skill/summary?${query(target)}`),
  });
}

/**
 * facts: 서버가 아는 사실(필요한 환경변수·MCP·외부 호스트). 모델 답과 섞지 않고 「쓰려면 필요한 것」 아래에 따로 보인다.
 * actions: 요약 단추 옆에 둘 것(「AI 에게 더 묻기」 대화 단추).
 * autoDelay: 없는 요약을 스스로 만들기 전에 기다릴 시간(ms). 주지 않으면 열자마자 만든다. 기다리는 동안 닫히면 만들지 않는다.
 */
export function AiSummary({
  target,
  facts,
  actions,
  autoDelay,
}: {
  target: SummaryTarget;
  facts?: ReactNode;
  actions?: ReactNode;
  autoDelay?: number;
}) {
  const qc = useQueryClient();
  const key = summaryKey(getLang(), target);
  const q = useSummaryView(target);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [open, setOpen] = useState(false);
  const listId = useId();
  const tried = useRef(false);

  const run = (refresh: boolean) => {
    setBusy(true);
    setErr(null);
    post<SummaryView>('/api/skill/summary', { ...target, refresh })
      .then((v) => qc.setQueryData(key, v))
      .catch((e: unknown) => setErr(e))
      .finally(() => setBusy(false));
  };

  const d = q.data;
  // 열 때 자동으로 만든다: 이 언어 요약이 없거나, 마켓 패키지 판이 바뀌었을 때 한 번(실패하면 단추로 다시 한다).
  // autoDelay 가 있으면 그만큼 머문 뒤에 만든다 — 닫히면(스킬·탭을 바꾸면) 타이머를 지워 목록을 훑을 때 LLM 을 부르지 않는다(D3·OV-M2)
  useEffect(() => {
    if (!d || !d.enabled || tried.current || busy) return;
    if (!d.summary || d.stale) {
      const make = () => {
        tried.current = true;
        run(false);
      };
      if (!autoDelay) {
        make();
        return;
      }
      const id = window.setTimeout(make, autoDelay);
      return () => window.clearTimeout(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d]);

  // 읽지 못했거나(요약 경로가 없는 서버) 꺼져 있으면 요약은 숨기고 대화 단추만 남긴다
  if (q.error || (d && !d.enabled)) return actions ? <Box>{actions}</Box> : null;
  if (!d) return null;

  const shown = d.summary ?? d.other?.summary ?? null;
  return (
    <Box data-testid="ai-summary">
      {busy && (
        <Box sx={{ mb: 1 }}>
          <LinearProgress />
          <Typography variant="caption" color="text.secondary">
            {t('market.summary.working')}
          </Typography>
        </Box>
      )}
      {!!err && (
        <Alert severity="warning" sx={{ mb: 1 }}>
          {errorText(err)}
        </Alert>
      )}
      {shown && (
        <>
          <Typography sx={{ fontWeight: 500 }}>{shown.one_line}</Typography>
          {!d.summary && d.other && (
            <Typography variant="caption" color="text.secondary" component="p">
              {t('market.summary.otherLang')}
            </Typography>
          )}
          <Box id={listId}>
          {LISTS.filter(([k]) => open || k === 'use_when').map(([k, label]) => {
            const items = shown[k] as string[];
            const extra = k === 'requires' && facts;
            if (!items.length && !extra) return null;
            return (
              <Box key={k} sx={{ mt: 1 }}>
                <Typography variant="caption" color="text.secondary" component="h4" sx={{ fontWeight: 600 }}>
                  {t(label)}
                </Typography>
                {items.length > 0 && (
                  <Box component="ul" sx={{ my: 0.25, pl: 2.5, fontSize: 14 }}>
                    {items.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </Box>
                )}
                {extra && (
                  <Box sx={{ mt: 0.5 }} aria-label={t('market.summary.facts')}>
                    {facts}
                  </Box>
                )}
              </Box>
            );
          })}
          </Box>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1, flexWrap: 'wrap' }}>
            {/* 접고 펼치는 공통 단추(스펙 2026-10-19-005). 색은 지금처럼 기본색(R8) */}
            <DisclosureButton
              open={open}
              onToggle={() => setOpen((v) => !v)}
              controls={listId}
              color="primary"
              label={open ? t('market.summary.less') : t('market.summary.more')}
            />
            {d.summary && (
              <Typography variant="caption" color="text.secondary">
                {t('market.summary.meta', { at: fmtTs(d.at), model: shownModel(d.model) })}
              </Typography>
            )}
            {d.stale && <Tag tone="warn">{t('market.summary.stale', { src: d.src })}</Tag>}
          </Stack>
        </>
      )}
      <Box sx={{ mt: 1 }}>
        {(!!d.summary || !!err) && (
          <Button size="small" variant="outlined" disabled={busy} onClick={() => run(true)} sx={{ mr: 1, mb: 0.5 }}>
            {t('market.summary.refresh')}
          </Button>
        )}
        {actions}
      </Box>
    </Box>
  );
}
