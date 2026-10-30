/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 상단 막대 위 공지 띠(스펙 공지 바 4-5, 디자인 리뷰 1A·1B·1C·2A·3E·5B·5C·6A·6B).
// 띠에는 제목만 두고 내용·기간은 제목의 풍선말로 보인다. 닫기만 오른쪽 끝, 나머지는 가운데 정렬(4-5, 사용자 2026-10-26).
// 한 번에 공지 하나를 보이고 「1/3」과 이전·다음 단추로 넘긴다. 자동으로 넘기지 않는다(읽는 도중 바뀌지 않게).
// 띠는 첫 화면 묶음에 들어가므로 dayjs·날짜 고르개를 쓰지 않고 시각은 Intl 로 적는다(9-14 E10).
// 띠 자체에는 live 영역을 두지 않는다. 새 공지를 읽어 주는 숨은 영역은 NoticeLive 가 AppShell 에 늘 붙여 둔다(E4).
import type { SvgIconComponent } from '@mui/icons-material';
import BuildOutlinedIcon from '@mui/icons-material/BuildOutlined';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CloseIcon from '@mui/icons-material/Close';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import EventBusyOutlinedIcon from '@mui/icons-material/EventBusyOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import NewReleasesOutlinedIcon from '@mui/icons-material/NewReleasesOutlined';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { Box, Button, Collapse, IconButton, Stack, Tooltip, Typography, useMediaQuery } from '@mui/material';
import { visuallyHidden } from '@mui/utils';
import { type MouseEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import { localeOf, t } from '@/i18n';
import { noticeTokens,shellColors } from '@/lib/shellTokens';
import { Notice, NoticeKind, useNotices } from '@/lib/useNotices';

import { DisclosureButton } from './DisclosureButton';

export const NOTICE_ICONS: Record<NoticeKind, SvgIconComponent> = {
  info: InfoOutlinedIcon,
  feature: NewReleasesOutlinedIcon,
  maintenance: BuildOutlinedIcon,
  deprecation: EventBusyOutlinedIcon,
  outage: ErrorOutlineIcon,
};

/** 종류의 면·글자·아이콘 색(1A) */
export function noticeTone(kind: NoticeKind): { bg: string; text: string; icon: string; line: string } {
  if (kind === 'outage') return noticeTokens.high;
  if (kind === 'maintenance' || kind === 'deprecation') return noticeTokens.mid;
  return { ...noticeTokens.low, icon: noticeTokens.low.icon[kind] };
}

/** 「바로 가기」 주소. AAS 안 경로(#/…)와 http(s) 만 받는다(서버도 같은 규칙으로 거른다) */
export function noticeLink(link: string): { href: string; external: boolean } | null {
  const s = (link || '').trim();
  if (s.startsWith('#/')) return { href: s, external: false };
  if (/^https?:\/\/\S+$/i.test(s)) return { href: s, external: true };
  return null;
}

const pad = (x: number) => String(x).padStart(2, '0');
const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const weekday = (d: Date) => new Intl.DateTimeFormat(localeOf(), { weekday: 'short' }).format(d);
/** 「10/26(일) 00:00」. 보는 사람의 브라우저 시간대. 자정은 다음 날 00:00 으로 적힌다(24:00 없음) */
export const noticeWhen = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}(${weekday(d)}) ${hm(d)}`;
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** 띠의 기간(5C): 작업·장애에만. 같은 날이면 「~22:00까지」, 다른 날이면 「~10/26(일) 00:00까지」 */
export function noticeUntil(n: Pick<Notice, 'kind' | 'ends_at'>, now: Date = new Date()): string {
  if (n.kind !== 'maintenance' && n.kind !== 'outage') return '';
  const end = new Date(n.ends_at);
  if (Number.isNaN(end.getTime())) return '';
  return t('notice.until', { time: sameDay(end, now) ? hm(end) : noticeWhen(end) });
}

/** 펼친 판의 전체 기간 「10/25(토) 22:00 ~ 10/26(일) 00:00」 */
export function noticeRange(n: Pick<Notice, 'starts_at' | 'ends_at'>): string {
  const a = new Date(n.starts_at);
  const b = new Date(n.ends_at);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return '';
  return `${noticeWhen(a)} ~ ${noticeWhen(b)}`;
}

/** 띠 위 단추(28×28, 아이콘 16, 무채색). 띠는 늘 어두운 면이라 포커스 링은 흰색이다 */
const iconBtnSx = {
  width: 28,
  height: 28,
  color: 'inherit',
  flexShrink: 0,
  '& svg': { fontSize: 16 },
  '&.Mui-focusVisible': { outline: `2px solid ${shellColors.menuActiveText}`, outlineOffset: -2 },
} as const;

const linkSx = {
  color: 'inherit',
  fontWeight: 500,
  textDecoration: 'underline',
  textUnderlineOffset: 2,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 0.25,
  whiteSpace: 'nowrap',
  '&:focus-visible': { outline: `2px solid ${shellColors.menuActiveText}`, outlineOffset: 1, borderRadius: 2 },
} as const;

/** 제목 풍선말(넓은 화면): 셸 면 위에 종류 색 왼쪽 선, 제목·내용 전체·기간 */
function NoticeTip({ n, accent }: { n: Notice; accent: string }) {
  return (
    <Box data-notice-tip="" sx={{ borderLeft: `2px solid ${accent}`, pl: 1.5, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      <Box component="span" sx={{ fontWeight: 700, color: shellColors.menuActiveText, overflowWrap: 'anywhere' }}>
        {n.title}
      </Box>
      {n.body && (
        <Box component="span" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: shellColors.menuText }}>
          {n.body}
        </Box>
      )}
      <Box component="span" data-notice-range="" sx={{ fontSize: 12, color: shellColors.menuText, opacity: 0.7, fontVariantNumeric: 'tabular-nums' }}>
        {noticeRange(n)}
      </Box>
    </Box>
  );
}

const tipSlotProps = {
  tooltip: {
    sx: {
      bgcolor: shellColors.shellBg,
      border: `1px solid ${noticeTokens.edge}`,
      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
      borderRadius: 1.5,
      px: 1.75,
      py: 1.25,
      maxWidth: 440,
      fontSize: noticeTokens.fontSize,
      fontWeight: 400,
      lineHeight: 1.6,
    },
  },
  arrow: { sx: { color: shellColors.shellBg, '&::before': { border: `1px solid ${noticeTokens.edge}` } } },
} as const;

function NoticeLinkView({ link, preview }: { link: string; preview?: boolean }) {
  const l = noticeLink(link);
  if (!l) return null;
  return (
    <Box
      component="a"
      href={l.href}
      {...(l.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      {...(preview ? { tabIndex: -1, onClick: (e: MouseEvent) => e.preventDefault() } : {})}
      sx={linkSx}
    >
      {t('notice.go')}
      {l.external && <OpenInNewIcon aria-hidden sx={{ fontSize: 12 }} />}
    </Box>
  );
}

export interface NoticeBarViewProps {
  /** 보일 공지(정렬된 것, 닫은 것 뺀 것) */
  items: Notice[];
  onDismiss?: (n: Notice) => void;
  /** 좁은 화면(600px 미만) 규칙: 아이콘·제목만, 나머지는 「자세히」에서 */
  narrow?: boolean;
  /** 관리 화면 미리 보기: 닫기·넘기기·링크가 동작하지 않는다 */
  preview?: boolean;
  /** 펼침 등 동작을 끈다(prefers-reduced-motion) */
  reduceMotion?: boolean;
}

/** 띠 한 줄과 펼친 판. 관리 화면 미리 보기도 이 부품을 폭만 바꿔 그린다(5F) */
export function NoticeBarView({ items, onDismiss, narrow = false, preview = false, reduceMotion = false }: NoticeBarViewProps) {
  // 보던 공지 id 기준으로 순번을 지킨다. 그 공지가 빠지면 같은 순번(넘치면 마지막)을 보인다(2A)
  const [pos, setPos] = useState<{ id: number | null; idx: number }>({ id: null, idx: 0 });
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  const titleRef = useRef<HTMLElement>(null);
  const panelId = useId();

  const found = items.findIndex((n) => n.id === pos.id);
  const idx = found >= 0 ? found : Math.max(0, Math.min(pos.idx, items.length - 1));
  const cur = items[idx];
  const total = items.length;

  // 좁은 화면에서 제목이 잘렸는지 잰다(넓은 화면은 풍선말이 제목 전체를 보인다)
  useLayoutEffect(() => {
    const measure = () => {
      const ti = titleRef.current;
      setCut(!!(ti && ti.scrollWidth > ti.clientWidth));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [cur?.id, cur?.title, narrow]);

  if (!cur) return null;
  const tone = noticeTone(cur.kind);
  const Icon = NOTICE_ICONS[cur.kind];
  const kindName = t(`notice.kind.${cur.kind}`);
  const until = noticeUntil(cur);
  const link = noticeLink(cur.link);
  // 「자세히」는 좁은 화면(터치)에만: 글·기간·바로 가기가 띠에 없거나 제목이 잘렸을 때. 넓은 화면은 풍선말
  const more = narrow && (cut || !!(cur.body || until || link));
  const outageIdx = cur.kind === 'outage' ? -1 : items.findIndex((n) => n.kind === 'outage');
  const go = (i: number) => {
    const j = (i + total) % total;
    setPos({ id: items[j].id, idx: j });
    setOpen(false);
  };
  const dismiss = () => {
    // 닫으면 같은 순번에 다음 공지가 온다
    setPos({ id: null, idx });
    setOpen(false);
    onDismiss?.(cur);
  };
  const motion = reduceMotion ? 0 : 160;

  return (
    <Box
      component="aside"
      aria-label={t('notice.region')}
      data-notice-kind={cur.kind}
      sx={{
        background: tone.bg,
        color: tone.text,
        borderBottom: `1px solid ${tone.line === 'transparent' ? noticeTokens.edge : tone.line}`,
        fontSize: noticeTokens.fontSize,
      }}
    >
      {/* 닫기 칸과 같은 폭의 빈 칸을 왼쪽에 두어 가운데 묶음이 닫기 단추 유무와 관계없이 띠 가운데에 온다 */}
      <Box sx={{ height: noticeTokens.height, display: 'grid', gridTemplateColumns: '28px minmax(0, 1fr) 28px', alignItems: 'center', columnGap: 1, px: narrow ? 1 : { xs: 1, sm: 3 } }}>
        <span aria-hidden />
        <Box data-notice-center="" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1, minWidth: 0, overflow: 'hidden' }}>
          <Icon aria-hidden sx={{ fontSize: 16, color: tone.icon, flexShrink: 0 }} />
          {narrow ? (
            <Box component="span" sx={visuallyHidden}>
              {kindName}
            </Box>
          ) : (
            <Box component="span" data-notice-kind-name="" sx={{ fontSize: noticeTokens.kindFontSize, fontWeight: 500, color: tone.icon, flexShrink: 0, whiteSpace: 'nowrap' }}>
              {kindName}
              <Box component="span" aria-hidden sx={{ ml: 0.5 }}>
                ·
              </Box>
            </Box>
          )}
          <Tooltip
            title={narrow ? '' : <NoticeTip n={cur} accent={tone.icon} />}
            arrow
            placement="bottom"
            enterDelay={200}
            enterNextDelay={200}
            describeChild
            slotProps={tipSlotProps}
          >
            <Box
              component="strong"
              ref={titleRef}
              data-notice-title=""
              {...(narrow ? {} : { tabIndex: 0 })}
              sx={{
                fontWeight: 700,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                minWidth: 0,
                flexShrink: 1,
                ...(narrow
                  ? {}
                  : {
                      cursor: 'help',
                      textDecoration: 'underline dotted',
                      textDecorationColor: 'currentColor',
                      textDecorationThickness: 1,
                      textUnderlineOffset: 4,
                      borderRadius: 0.5,
                      '&:focus-visible': { outline: `2px solid ${shellColors.menuActiveText}`, outlineOffset: 2 },
                    }),
              }}
            >
              {cur.title}
            </Box>
          </Tooltip>
          {!narrow && cur.body && (
            // 띠에는 보이지 않지만 화면 읽기 프로그램은 제목 다음에 내용을 읽는다
            <Box component="span" sx={visuallyHidden}>
              {cur.body}
            </Box>
          )}
          {!narrow && until && (
            <Box component="span" data-notice-until="" sx={{ whiteSpace: 'nowrap', flexShrink: 0, opacity: 0.85 }}>
              {until}
            </Box>
          )}
          {!narrow && link && (
            <Box component="span" sx={{ flexShrink: 0, display: 'inline-flex' }}>
              <NoticeLinkView link={cur.link} preview={preview} />
            </Box>
          )}
          {more && (
            <DisclosureButton
              open={open}
              onToggle={() => setOpen((v) => !v)}
              controls={panelId}
              label={t('notice.more')}
              sx={{ color: 'inherit', minWidth: 0, flexShrink: 0, py: 0, height: 28, fontSize: 12, '&.Mui-focusVisible': { boxShadow: `0 0 0 2px ${shellColors.menuActiveText}` } }}
            />
          )}
          {outageIdx >= 0 && (
            <Tooltip title={t('notice.outageDot')}>
              <IconButton aria-label={t('notice.outageDot')} disabled={preview} onClick={() => go(outageIdx)} sx={iconBtnSx}>
                <Box component="span" sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: noticeTokens.outageDot }} />
              </IconButton>
            </Tooltip>
          )}
          {total > 1 && (
            <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
              <IconButton aria-label={t('notice.prev')} disabled={preview} onClick={() => go(idx - 1)} sx={iconBtnSx}>
                <ChevronLeftIcon />
              </IconButton>
              <Box component="span" data-notice-pos="" sx={{ minWidth: 28, textAlign: 'center', fontSize: 12, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                {`${idx + 1}/${total}`}
              </Box>
              <IconButton
                aria-label={t('notice.next', { pos: `${((idx + 1) % total) + 1}/${total}` })}
                disabled={preview}
                onClick={() => go(idx + 1)}
                sx={iconBtnSx}
              >
                <ChevronRightIcon />
              </IconButton>
            </Box>
          )}
        </Box>
        {cur.dismissible ? (
          <IconButton aria-label={t('notice.close')} disabled={preview} onClick={dismiss} sx={iconBtnSx}>
            <CloseIcon />
          </IconButton>
        ) : (
          <span aria-hidden />
        )}
      </Box>
      <Collapse in={open && more} timeout={motion} unmountOnExit>
        <Box id={panelId} sx={{ px: narrow ? 1 : { xs: 1, sm: 3 }, pb: 1.25, pt: 0.25, display: 'flex', flexDirection: 'column', gap: 0.5, lineHeight: 1.6 }}>
          <Box component="span" sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
            {cur.title}
          </Box>
          {cur.body && (
            <Box component="span" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {cur.body}
            </Box>
          )}
          <Box component="span" data-notice-range="" sx={{ opacity: 0.85 }}>
            {noticeRange(cur)}
          </Box>
          {link && (
            <Box>
              <NoticeLinkView link={cur.link} preview={preview} />
            </Box>
          )}
        </Box>
      </Collapse>
    </Box>
  );
}

/** 모든 화면의 공지 띠. 공지가 없으면 아무것도 그리지 않는다(셸 그대로) */
export function NoticeBar() {
  const { all, visible, dismiss } = useNotices();
  const narrow = useMediaQuery('(max-width:599.95px)');
  const reduce = useMediaQuery('(prefers-reduced-motion: reduce)');
  // 첫 값은 동작 없이 바로 그리고, 그 뒤에 생기고 사라질 때만 150ms 로 접고 편다(2A)
  const [settled, setSettled] = useState(false);
  const loaded = all !== undefined;
  useEffect(() => {
    if (loaded) setSettled(true);
  }, [loaded]);
  // 사라지는 동안에도 마지막 공지를 그린다(빈 띠가 접히지 않게)
  const [held, setHeld] = useState<Notice[]>([]);
  useEffect(() => {
    if (visible.length) setHeld(visible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.map((n) => `${n.id}:${n.updated_ts}`).join(',')]);
  const shown = visible.length ? visible : held;
  return (
    <Collapse in={visible.length > 0} appear={false} timeout={reduce || !settled ? 0 : 150} unmountOnExit>
      <NoticeBarView items={shown} onDismiss={dismiss} narrow={narrow} reduceMotion={reduce} />
    </Collapse>
  );
}

/**
 * 화면 밖 읽기 영역 두 개(6B·E4). 공지 개수와 관계없이 늘 붙어 있다. 처음 받은 목록은 읽지 않고,
 * 그 뒤 새로 생긴 공지만 장애는 role=alert 에 「장애: <제목>」, 다른 종류는 role=status 에 「공지: <종류> <제목>」으로 한 번 읽는다.
 */
export function NoticeLive() {
  const { all } = useNotices();
  const seen = useRef<Set<number> | null>(null);
  const [alertText, setAlertText] = useState('');
  const [statusText, setStatusText] = useState('');
  const sig = all ? all.map((n) => n.id).join(',') : null;
  useEffect(() => {
    if (!all) return;
    if (!seen.current) {
      seen.current = new Set(all.map((n) => n.id));
      return;
    }
    const known = seen.current;
    const fresh = all.filter((n) => !known.has(n.id));
    fresh.forEach((n) => known.add(n.id));
    const outage = fresh.filter((n) => n.kind === 'outage');
    const other = fresh.filter((n) => n.kind !== 'outage');
    if (outage.length) setAlertText(outage.map((n) => t('notice.liveOutage', { title: n.title })).join(' '));
    if (other.length) setStatusText(other.map((n) => t('notice.liveOther', { kind: t(`notice.kind.${n.kind}`), title: n.title })).join(' '));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  return (
    <>
      <Box role="alert" data-notice-live="alert" sx={visuallyHidden}>
        {alertText}
      </Box>
      <Box role="status" data-notice-live="status" sx={visuallyHidden}>
        {statusText}
      </Box>
    </>
  );
}

/** 서랍의 공지 한 건: 종류 색 왼쪽 줄, 제목 → 본문(4줄 접기) → 기간·바로 가기. 닫은 공지는 흐리게 하고 되살리기 단추를 둔다 */
function NoticeRow({ n, hidden, onRestore }: { n: Notice; hidden: boolean; onRestore: () => void }) {
  const Icon = NOTICE_ICONS[n.kind];
  const accent = noticeTone(n.kind).icon;
  const bodyRef = useRef<HTMLElement>(null);
  const bodyId = useId();
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el && !expanded) setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [n.body, expanded]);
  const link = noticeLink(n.link);
  return (
    <Box
      component="li"
      data-notice-row={n.id}
      sx={{
        position: 'relative',
        py: 1.75,
        pl: 2,
        pr: 0.5,
        borderBottom: 1,
        borderColor: 'divider',
        '&:last-of-type': { borderBottom: 0 },
        '&::before': { content: '""', position: 'absolute', left: 0, top: 14, bottom: 14, width: 3, borderRadius: 1.5, bgcolor: accent, opacity: hidden ? 0.35 : 1 },
      }}
    >
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minHeight: 28 }}>
        <Icon aria-hidden sx={{ fontSize: 16, color: accent }} />
        <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary' }}>
          {t(`notice.kind.${n.kind}`)}
        </Typography>
        <Box sx={{ flex: 1 }} />
        {hidden && (
          <Button size="small" variant="text" onClick={onRestore} sx={{ fontSize: 12, minWidth: 0 }}>
            {t('notice.restore')}
          </Button>
        )}
      </Stack>
      <Box sx={{ opacity: hidden ? 0.6 : 1 }}>
        <Typography variant="subtitle2" component="h3" sx={{ fontWeight: 700, lineHeight: 1.45, mt: 0.25, overflowWrap: 'anywhere' }}>
          {n.title}
        </Typography>
        {n.body && (
          <>
            <Typography
              id={bodyId}
              ref={bodyRef}
              variant="body2"
              color="text.secondary"
              sx={{
                mt: 0.75,
                lineHeight: 1.65,
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                ...(expanded ? {} : { display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }),
              }}
            >
              {n.body}
            </Typography>
            {(clamped || expanded) && (
              <DisclosureButton
                open={expanded}
                onToggle={() => setExpanded((v) => !v)}
                controls={bodyId}
                label={t(expanded ? 'notice.less' : 'notice.expand')}
                sx={{ mt: 0.25, ml: -0.75, fontSize: 12, minWidth: 0 }}
              />
            )}
          </>
        )}
        <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1} sx={{ mt: 1, flexWrap: 'wrap' }}>
          <Typography variant="caption" color="text.secondary" component="span" data-notice-range="" sx={{ fontVariantNumeric: 'tabular-nums' }}>
            {noticeRange(n)}
          </Typography>
          {link && (
            <Box sx={{ fontSize: 13, color: 'primary.main' }}>
              <NoticeLinkView link={n.link} />
            </Box>
          )}
        </Stack>
      </Box>
    </Box>
  );
}

/** 계정 메뉴 「지금 공지 N」의 상세 서랍(3D). 닫은 공지는 줄마다 「다시 띠에 보이기」로 되살린다 */
export function NoticeList() {
  const { all, isDismissed, restore } = useNotices();
  const list = all ?? [];
  if (!list.length) return <Typography color="text.secondary">{t('notice.listEmpty')}</Typography>;
  return (
    <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
      {list.map((n) => (
        <NoticeRow key={n.id} n={n} hidden={n.dismissible && isDismissed(n)} onRestore={() => restore(n)} />
      ))}
    </Box>
  );
}
