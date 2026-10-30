/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 칸반 카드 본문을 항목별로 받는다(스펙 2026-10-18-002). 에이전트가 읽는 작업 지시는 카드 제목과 본문뿐이라
// 어디에서·무엇을·어떤 결과를 남길지를 질문으로 받아 Markdown 본문 하나로 만든다. 서버·Hermes 는 그대로 `body` 를 받는다.
// 칸 모양과 머리 글은 TFT 방 목적(2026-10-18-004, lib/roomBrief.ts·RoomForm)과 같다. 두 기능이 커밋된 뒤 하나로 합친다(§3-8).
import { Box, Stack, TextField, Typography } from '@mui/material';
import { ReactNode, RefObject, useId } from 'react';

import { DisclosureButton } from '@/components/DisclosureButton';
import { dictionaries, LANGS, t } from '@/i18n';
import { hiddenFilled } from '@/lib/hiddenFilled';

export const CARD_BRIEF_KEYS = ['goal', 'location', 'result', 'how', 'background', 'avoid', 'refs', 'ifStuck', 'notes'] as const;
export type CardBriefKey = (typeof CARD_BRIEF_KEYS)[number];
export type CardBrief = Partial<Record<CardBriefKey, string>>;

/** 늘 보이는 항목. 나머지와 우선순위는 「더 자세히 적기」 안에 둔다(디자인 리뷰 U1·R2) */
export const CARD_BRIEF_SHOWN: CardBriefKey[] = ['goal', 'location', 'result'];
export const CARD_BRIEF_REQUIRED: CardBriefKey[] = ['goal', 'result'];
/** AI 가 빠졌다고 알려 주면 칸에 묻는 항목(필수 둘과 작업 위치, 디자인 리뷰 S2) */
export const CARD_BRIEF_ASK: CardBriefKey[] = ['goal', 'result', 'location'];

/** Hermes 가 본문을 자르는 길이(`_CTX_MAX_BODY_BYTES = 8 * 1024`, 이름과 달리 글자 수)와 경고를 띄우는 길이 */
export const BODY_LIMIT = 8192;
export const BODY_WARN = 8000;

const head = (k: CardBriefKey) => t(`office.cardBrief.${k}.head`);

/** 본문 끝에 붙이는 안내 줄의 구분선. 방식을 바꿀 때 이 줄을 떼어 두 번 붙지 않게 한다 */
const FOOTER_RULE = '---';

/** 항목 값을 Markdown 하나로. 빈 항목은 넣지 않고, 머리는 `###`(Hermes 가 본문을 `## Body` 아래에 넣는다).
 *  끝에 결과 파일을 카드에 첨부하라는 안내 한 줄을 붙인다(R5 를 B 로 바꿈): OKE 시험 카드(2026-10-18)에서 에이전트가
 *  Hermes 시스템 프롬프트의 같은 지시를 따르지 않아 결과 파일이 임시 작업 폴더와 함께 지워졌다 */
export function buildCardBrief(b: CardBrief): string {
  const parts = CARD_BRIEF_KEYS.filter((k) => b[k]?.trim()).map((k) => `### ${head(k)}\n${b[k]!.trim()}`);
  return parts.length ? `${parts.join('\n\n')}\n\n${FOOTER_RULE}\n${t('office.cardBriefFooter')}` : '';
}

/** 글 끝의 안내 줄(두 언어 모두)을 뗀다 */
function stripFooter(src: string): string {
  for (const lang of LANGS) {
    const footer = dictionaries[lang]['office.cardBriefFooter'];
    if (!footer) continue;
    const tail = `${FOOTER_RULE}\n${footer}`;
    if (src.endsWith(tail)) return src.slice(0, -tail.length).trim();
  }
  return src;
}

export function missingRequired(b: CardBrief): CardBriefKey[] {
  return CARD_BRIEF_REQUIRED.filter((k) => !b[k]?.trim());
}

/** 두 언어의 머리 글 → 항목. 화면 언어가 바뀌어도 만든 글을 다시 읽는다 */
function headIndex(): Map<string, CardBriefKey> {
  const m = new Map<string, CardBriefKey>();
  for (const lang of LANGS)
    for (const k of CARD_BRIEF_KEYS) {
      const h = dictionaries[lang][`office.cardBrief.${k}.head`];
      if (h) m.set(h.trim().toLowerCase(), k);
    }
  return m;
}

/** 자유 글을 항목으로 나눈다(디자인 리뷰 J2). 아는 `###` 머리는 그 칸으로, 머리가 없거나 모르는 머리의 글은 「추가 설명」으로.
 *  모르는 `###` 줄은 지우지 않고 앞 항목의 글로 남긴다(사람이 적은 Markdown 을 잃지 않게). 규칙은 회의방 parseBrief 와 같다 */
export function parseCardBrief(text: string): CardBrief {
  const src = stripFooter((text ?? '').replace(/\r\n?/g, '\n').trim());
  if (!src) return {};
  const heads = headIndex();
  const out: CardBrief = {};
  let cur: CardBriefKey | null = null;
  const buf: string[] = [];
  const flush = () => {
    const v = buf.join('\n').trim();
    if (v) {
      const k = cur ?? 'notes';
      out[k] = out[k] ? `${out[k]}\n\n${v}` : v;
    }
    buf.length = 0;
  };
  for (const line of src.split('\n')) {
    const m = /^###\s+(.+?)\s*$/.exec(line);
    const k = m ? heads.get(m[1].toLowerCase()) : undefined;
    if (k) {
      flush();
      cur = k;
    } else buf.push(line);
  }
  flush();
  return out;
}

/** 칸마다 아래 줄에 보일 글: AI 가 채움(무채색) 또는 빠진 항목 질문(호박색) */
export type FieldNote = { text: string; warn: boolean };

/** 항목 칸 묶음. 회의방 RoomForm 과 같은 모양(fieldset·legend, 라벨을 위로 올려 예시가 처음부터 보이게, 간격 1.25, 최대 8줄) */
export function BriefFields({
  values,
  onChange,
  more,
  onMore,
  notes = {},
  refs,
  extra,
  disabled,
}: {
  values: CardBrief;
  onChange: (k: CardBriefKey, v: string) => void;
  more: boolean;
  onMore: () => void;
  notes?: Partial<Record<CardBriefKey, FieldNote>>;
  refs?: Partial<Record<CardBriefKey, RefObject<HTMLInputElement | null>>>;
  /** 「더 자세히 적기」 안 맨 끝에 둘 것(우선순위) */
  extra?: ReactNode;
  /** 「더 자세히 적기」를 막는다(카드 추가가 AI 로 나누는 동안). 지금 화면에서는 생기지 않는 상태다(스펙 2026-10-19-005 G6·R14) */
  disabled?: boolean;
}) {
  const moreId = useId();
  const field = (k: CardBriefKey) => {
    const note = notes[k];
    return (
      <TextField
        key={k}
        size="small"
        multiline
        maxRows={8}
        required={CARD_BRIEF_REQUIRED.includes(k)}
        label={t(`office.cardBrief.${k}.q`)}
        placeholder={t(`office.cardBrief.${k}.example`)}
        value={values[k] ?? ''}
        onChange={(e) => onChange(k, e.target.value)}
        inputRef={refs?.[k]}
        helperText={note?.text}
        slotProps={{
          inputLabel: { shrink: true },
          formHelperText: { sx: note?.warn ? { color: 'warning.main' } : undefined },
        }}
      />
    );
  };
  // 접으면 적은 칸도 숨는다. 숨은 글 칸에 값이 있으면 단추 옆에 개수를 보인다(우선순위는 세지 않는다, G13·R13)
  const hidden = more ? 0 : hiddenFilled(CARD_BRIEF_KEYS, CARD_BRIEF_SHOWN, values);
  return (
    <Box component="fieldset" sx={{ border: 0, m: 0, p: 0, minWidth: 0 }}>
      <Typography component="legend" variant="subtitle2" sx={{ mb: 1 }}>
        {t('office.cardBriefLegend')}
      </Typography>
      <Stack spacing={1.25}>
        {CARD_BRIEF_SHOWN.map(field)}
        {/* 펼쳐지는 칸은 한 묶음(id)이라 단추의 aria-controls 가 가리킨다(스펙 2026-10-19-005 O3) */}
        {more && (
          <Stack id={moreId} spacing={1.25}>
            {CARD_BRIEF_KEYS.filter((k) => !CARD_BRIEF_SHOWN.includes(k)).map(field)}
            {extra}
          </Stack>
        )}
        <Stack direction="row" alignItems="center" spacing={1}>
          <DisclosureButton
            open={more}
            onToggle={onMore}
            controls={moreId}
            disabled={disabled}
            label={t(more ? 'office.briefLess' : 'office.briefMore')}
          />
          {hidden > 0 && (
            <Typography variant="caption" color="text.secondary">
              {t('office.briefHiddenFilled', { count: hidden })}
            </Typography>
          )}
        </Stack>
      </Stack>
    </Box>
  );
}
