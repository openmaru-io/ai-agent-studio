/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 화면들이 함께 쓰는 작은 표시 조각. 옛 화면(삭제됨. 커밋 3e3319d 의 aas/web/js/ui.js)의 tag·kv·sec·issueList·linkChip 과 같은 역할이다.
import CheckIcon from '@mui/icons-material/Check';
import {
  Alert,
  alpha,
  Box,
  Chip,
  IconButton,
  LinearProgress,
  NativeSelect,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import { createContext, MouseEvent, ReactNode, useContext } from 'react';
import { Link } from 'react-router-dom';

import { t } from '@/i18n';
import { openChat } from '@/lib/chatPopup';
import { MONO_FONT } from '@/lib/monoFont';
import { sectionIconFor } from '@/lib/sectionIcons';

import { type DrawerPage, pageFromLink } from './drawerPages';
import { useInDrawer } from './drawerScope';
import type { Tone } from './ListView';
import { PageTitle, VIEW_ICONS } from './PageTitle';
import { useUiOptional } from './UiContext';
/** DESIGN.md §3 Code Label 글꼴. JetBrains Mono 를 이미지에 번들한다(src/fonts.css). 정의는 lib/monoFont.ts. */
export const monoFont = MONO_FONT;

const color = (tone?: Tone | 'info') =>
  tone === 'bad' ? 'error' : tone === 'warn' ? 'warning' : tone === 'good' ? 'success' : tone === 'info' ? 'info' : 'default';

/** tone 'info' 는 DESIGN Sky(theme info) — 안내만 하는 항목(스펙 2026-10-24-003 D13) */
export function Tag({ tone, children }: { tone?: Tone | 'info'; children: ReactNode }) {
  return <Chip size="small" variant="outlined" color={color(tone)} label={children} sx={{ mr: 0.5 }} />;
}

/** Section 안인가. 서랍의 KV 가 제목을 겹쳐 달지 않게 한다 */
const InSectionContext = createContext(false);

/**
 * 항목·값 표. `hints` 는 항목 이름에 붙는 풍선말(이름 → 설명), `stack` 을 주면 600px 미만에서 항목 이름을 값 위로 쌓는다
 * (긴 항목 이름이 값 칸을 좁히는 서랍, 스펙 2026-10-19-011 D18). 둘 다 없으면 지금과 같다.
 */
export function KV({ pairs, hints, stack }: { pairs: [string, ReactNode][]; hints?: Record<string, string>; stack?: boolean }) {
  const shown = pairs.filter(([, v]) => v != null && v !== '');
  // 서랍 안에서는 표처럼 보이므로 머리줄(항목·값)을 두고, 섹션 밖이면 「기본 정보」 제목도 단다.
  // 머리줄은 보기용이다(aria-hidden) — 보조기기는 dt·dd 로 이미 쌍을 읽는다. 서랍 밖 화면은 그대로
  const inDrawer = useInDrawer();
  const inSection = useContext(InSectionContext);
  if (!shown.length) return null;
  const table = (
    <Box
      component="dl"
      className="aas-kv"
      sx={{ display: 'grid', gridTemplateColumns: stack ? { xs: '1fr', sm: 'max-content 1fr' } : 'max-content 1fr', columnGap: 2, rowGap: 0.5, m: 0 }}
    >
      {inDrawer && (
        <Box data-kv-head="" aria-hidden="true" className="aas-kv-head" sx={{ display: stack ? { xs: 'none', sm: 'contents' } : 'contents' }}>
          <Typography component="dt" variant="body2">
            {t('common.kv.key')}
          </Typography>
          <Typography component="dd" variant="body2" sx={{ m: 0 }}>
            {t('common.kv.value')}
          </Typography>
        </Box>
      )}
      {shown.map(([k, v]) => (
        <Box key={k} sx={{ display: 'contents' }}>
          <Typography component="dt" variant="body2" color="text.secondary" title={hints?.[k]} sx={stack ? { mt: { xs: 1, sm: 0 } } : undefined}>
            {k}
          </Typography>
          <Typography component="dd" variant="body2" sx={{ m: 0 }}>
            {v}
          </Typography>
        </Box>
      ))}
    </Box>
  );
  return inDrawer && !inSection ? <Section title={t('common.kv.title')}>{table}</Section> : table;
}

/** 눈에 보이는 이름표. 컨트롤의 접근성 이름은 컨트롤이 aria-label 로 따로 갖는다(그래서 이름표는 보조기기에서 숨긴다). */
export function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" component="div" aria-hidden="true" sx={{ mb: 0.25 }}>
        {label}
      </Typography>
      {children}
    </Box>
  );
}

/**
 * 제목이 있는 묶음. `action` 을 주면 제목 옆에 둔다(스펙 2026-10-15-025). `indent` 를 주면 내용을 제목 글자 자리에서 시작한다(서랍 안은 늘 그렇다). `count` 를 주면 제목 옆에 개수 뱃지(DESIGN.md §4 Subtle Badge)로 보인다. 제목 글자에 숫자를 붙이지 않는다.
 * 서랍 안에서의 간격·제목 크기는 `DrawerHost` 가 `aas-section` 클래스로 정한다.
 */
export function Section({ title, count, indent, action, guide, children }: { title?: string; count?: number; indent?: boolean; action?: ReactNode; /** 가이드(따라하기)가 강조하는 자리의 data-guide 값 */ guide?: string; children?: ReactNode }) {
  // 제목 앞 아이콘: 번역 키 → 아이콘 표(lib/sectionIcons)에서 제목으로 찾는다. SVG 라 에어갭에서도 보인다
  const Icon = title ? sectionIconFor(title) : undefined;
  return (
    <InSectionContext.Provider value>
    <Box component="section" className="aas-section" data-guide={guide} sx={{ mt: 2 }}>
      {title && (
        <Typography
          variant="subtitle2"
          component="h3"
          className="aas-section-head"
          sx={{ mb: 0.5, display: 'flex', alignItems: 'center' }}
        >
          {Icon && <Icon aria-hidden sx={{ fontSize: 16, mr: 0.75, color: 'text.secondary', flexShrink: 0 }} />}
          <span>{title}</span>
          {count != null && (
            <Box
              component="span"
              className="aas-count"
              sx={(th) => ({
                ml: 1,
                px: 0.75,
                minWidth: 20,
                textAlign: 'center',
                fontSize: 11,
                fontWeight: 500,
                lineHeight: '18px',
                borderRadius: '2px',
                fontVariantNumeric: 'tabular-nums',
                color: 'text.secondary',
                bgcolor: alpha(th.palette.text.primary, 0.06),
                border: `1px solid ${alpha(th.palette.text.primary, 0.06)}`,
              })}
            >
              {count}
            </Box>
          )}
          {/* 제목 옆 동작(새 항목 추가 아이콘 등) */}
          {action && <Box component="span" sx={{ ml: 1, display: 'inline-flex', alignItems: 'center' }}>{action}</Box>}
        </Typography>
      )}
      {/* 제목 아래 내용은 감싸 둔다. 서랍 안에서는 drawerBodySx 가 이 상자를 제목 글자 자리만큼 들여 쓴다 */}
      {/* indent: 화면(서랍이 아닌 곳)에서도 내용을 제목 글자 자리(아이콘 16px + 6px)에서 시작한다. 아이콘이 없으면 제목 글자가 바로 시작하므로 들이지 않는다 */}
      {title ? (
        <Box className="aas-section-body" sx={indent && Icon ? { pl: '22px' } : undefined}>
          {children}
        </Box>
      ) : (
        children
      )}
    </Box>
    </InSectionContext.Provider>
  );
}

/** 줄로 나뉜 목록. 글머리표 대신 줄 사이 선으로 나눈다(서랍 안에서). */
export function RowList({ children }: { children: ReactNode }) {
  return (
    <Box component="ul" className="aas-list" sx={{ m: 0, pl: 2.5 }}>
      {children}
    </Box>
  );
}

/** 경로·주소·도구 이름처럼 그대로 읽어야 하는 값. 줄이 길면 아무 데서나 줄을 바꾼다. */
export function Mono({ children, block }: { children: ReactNode; block?: boolean }) {
  return (
    <Box
      component={block ? 'div' : 'span'}
      className="aas-mono"
      sx={{ fontFamily: monoFont, fontSize: 12, color: 'text.secondary', wordBreak: 'break-all' }}
    >
      {children}
    </Box>
  );
}

export interface Issue {
  /** bad 문제 · warn 주의 · info 안내(고장이 아니다 — 「주의」 거르기·긴급에서 뺀다, 스펙 2026-10-24-003 D13) */
  level: 'bad' | 'warn' | 'info' | string;
  text: string;
  /** 있으면 항목 끝에 그 화면으로 가는 칩(D5) */
  to?: { view: string; params?: Record<string, string> };
  /** 사람이 확인해 뺄 수 있는 주의·안내(문제는 아니다). IssueList 에 onAck 를 주면 확인 버튼이 생긴다. sig 는 서버가 기억하는 지문 */
  ack?: boolean;
  sig?: string;
  code?: string;
  package?: string;
  version?: string;
}

/** 안내가 아닌(고칠 것인) 항목. 「주의」 표시·개수는 이것만 센다 */
export const actionable = <I extends Pick<Issue, 'level'>>(issues: I[] | null | undefined): I[] => (issues ?? []).filter((i) => i.level !== 'info');

/** 안내는 맨 뒤로. 나머지 순서는 그대로 */
export const issueOrder = <I extends Pick<Issue, 'level'>>(issues: I[]): I[] => [...actionable(issues), ...issues.filter((i) => i.level === 'info')];

export function IssueList({ issues, onAck }: { issues?: Issue[] | null; onAck?: (issue: Issue) => void }) {
  if (!issues || issues.length === 0) return <Tag tone="good">{t('common.noIssues')}</Tag>;
  return (
    <RowList>
      {issueOrder(issues).map((i, n) => (
        <li key={n}>
          <Tag tone={i.level === 'bad' ? 'bad' : i.level === 'info' ? 'info' : 'warn'}>
            {i.level === 'bad' ? t('common.problem') : i.level === 'info' ? t('common.info') : t('common.caution')}
          </Tag>{' '}
          {i.text}
          {i.to && (
            <>
              {' '}
              <LinkChip to={i.to.view} params={i.to.params}>
                {t('common.issueOpen')}
              </LinkChip>
            </>
          )}
          {i.ack && onAck && (
            <Tooltip title={t('common.issueAck')}>
              <IconButton size="small" aria-label={t('common.issueAck')} onClick={() => onAck(i)} sx={{ ml: 0.5, p: 0.25 }}>
                <CheckIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          )}
        </li>
      ))}
    </RowList>
  );
}

interface LinkChipProps {
  children: ReactNode;
  /** 이동할 화면 id. 있으면 링크로, 없으면 버튼으로 그린다. */
  to?: string;
  params?: Record<string, string | number | null | undefined>;
  onClick?: () => void;
  /** onClick 으로 다른 화면을 여는 칩의 그 화면 id. 아이콘만 고른다(to 가 있으면 to 를 쓴다) */
  view?: string;
  /** 서랍 안에서 누르면 메뉴를 옮기지 않고 같은 서랍에 여는 대상(스펙 2026-10-26-003 §5-3). 서랍 밖이면 지금처럼 to 로 옮긴다.
   *  true 면 to·params 로 찾는다(pageFromLink — 프로파일·에이전트·스킬·작업·스킬 연결도) */
  page?: DrawerPage | null | true;
}

/**
 * 서랍 안 링크를 눌렀을 때: 서랍 안이고 왼쪽 단추·수정 키 없음이면 메뉴를 옮기지 않고 그 서랍에서 열고 true 를 돌려준다(라우터 이동을 막는다).
 * Ctrl·⌘·Shift·가운데 단추는 막지 않는다 — 새 탭·창에서 그 메뉴로 열린다. 이때 임시 서랍을 치우면 지금 서랍이 닫히므로 부르는 쪽이 치우지 않는다(리뷰 A1)
 */
export function useOpenInDrawer() {
  const ui = useUiOptional();
  return (e: MouseEvent, page?: DrawerPage | null) => {
    // 서랍 안인지는 누른 자리로 본다 — 서랍 본문은 목록 화면이 만들어 넘기므로(DrawerSpec.body) 만든 곳의 문맥(useInDrawer)은 서랍 밖이다
    const inDrawer = !!(e.currentTarget as Element | null)?.closest?.('[data-drawer-body]');
    if (!page || !inDrawer || !ui || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return false;
    e.preventDefault();
    void ui.navigateDrawer(page);
    return true;
  };
}

/** 다른 화면으로 가는 칩 앞의 아이콘: 가는 화면의 제목 아이콘(VIEW_ICONS)이다. 화면을 모르면 그리지 않는다 */
function viewChipIcon(view?: string) {
  const Icon = view ? VIEW_ICONS[view] : undefined;
  return Icon ? <Icon aria-hidden /> : undefined;
}

export function LinkChip({ children, to, params, onClick, view, page }: LinkChipProps) {
  const ui = useUiOptional();
  const openHere = useOpenInDrawer();
  const icon = viewChipIcon(to ?? view);
  if (to) {
    const qs = new URLSearchParams(
      Object.entries(params ?? {})
        .filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => [k, String(v)])
    ).toString();
    return (
      <Chip
        component={Link}
        to={'/' + to + (qs ? '?' + qs : '')}
        onClick={(e: MouseEvent) => {
          if (openHere(e, page === true ? pageFromLink(to, params) : page)) return;
          ui?.dismissTransient();
        }}
        clickable
        size="small"
        variant="outlined"
        icon={icon}
        label={children}
        sx={{ mr: 0.5, mb: 0.5 }}
      />
    );
  }
  return (
    <Chip clickable size="small" variant="outlined" icon={icon} label={children} onClick={onClick} sx={{ mr: 0.5, mb: 0.5 }} />
  );
}

export function ScreenLoading({ title, error, context }: { title: string; error?: string | null; context?: string }) {
  // 서랍 안에서는 머리에 이미 제목이 있어 진행 막대(또는 오류)만 그린다(사용자 보고 2026-10-14)
  const inDrawer = useInDrawer();
  return (
    <Box>
      {!inDrawer && (
        <PageTitle gutterBottom context={context}>
          {title}
        </PageTitle>
      )}
      {error ? <Alert severity="error">{error}</Alert> : <LinearProgress aria-label={t('common.loading')} />}
    </Box>
  );
}

export interface Column {
  label: string;
  num?: boolean;
}

export function DataTable({ columns, rows }: { columns: Column[]; rows: ReactNode[][] }) {
  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          {columns.map((c) => (
            <TableCell key={c.label} align={c.num ? 'right' : 'left'}>
              {c.label}
            </TableCell>
          ))}
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((r, i) => (
          <TableRow key={i}>
            {r.map((cell, k) => (
              <TableCell key={k} align={columns[k]?.num ? 'right' : 'left'}>
                {cell}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function PeriodSelect({
  days,
  options,
  onChange,
}: {
  days: number;
  options: number[];
  onChange: (days: number) => void;
}) {
  return (
    <NativeSelect value={days} onChange={(e) => onChange(Number(e.target.value))} inputProps={{ 'aria-label': t('common.period') }}>
      {options.map((d) => (
        <option key={d} value={d}>{t('common.lastDays', { count: d, days: d })}</option>
      ))}
    </NativeSelect>
  );
}

// 「쓰는 곳」에 적힌 이름(스킬 x / 예약 작업 y / 스크립트 z)을 눌러 해당 화면으로 간다. 서버(aas/assets/inventory.py)가 붙이는 접두어다.
// 옛 접두어 「크론」·「Cron」도 받는다(OMAI-1313 에서 「예약 작업」·「Scheduled job」으로 바꿈, 이미 받아 둔 응답이 있을 수 있다).
export function UsedByLinks({ labels, more }: { labels?: string[] | null; more?: number }) {
  if (!labels || labels.length === 0) return <Typography color="text.secondary">{t('common.usedByEmpty')}</Typography>;
  return (
    <>
      {labels.map((l) => {
        const m = /^(스킬|예약 작업|크론|스크립트|scheduled job|cron|skill|script)[\s:]+(.+)$/i.exec(l);
        const view = !m || /스크립트|script/i.test(m[1]) ? 'tools' : /스킬|skill/i.test(m[1]) ? 'skills' : 'cron';
        const name = (m ? m[2] : l).split('/').pop() ?? '';
        return (
          <LinkChip
            key={l}
            to={view}
            params={{ tab: view === 'cron' ? 'profiles' : 'all', q: view === 'cron' ? name.split(/[\s/]/)[0] : name }}
          >
            {l}
          </LinkChip>
        );
      })}
      {more != null && more > labels.length && (
        <Typography component="span" variant="caption" color="text.secondary">{t('common.andMore', { count: more - labels.length })}</Typography>
      )}
    </>
  );
}

interface ChatChipProps {
  /** 대화할 에이전트(지금 POD 의 프로파일 이름) */
  agent: string;
  /** 새 대화를 열고 입력창에 채워 둘 글(보내지는 않는다) */
  text?: string;
  children: ReactNode;
}

/** 누르면 화면을 떠나지 않고 공통 대화 팝업을 연다(OMAI-1115). 예전에는 /chat?agent= 로 옮겨 갔다. */
export function ChatChip({ agent, text, children }: ChatChipProps) {
  return (
    <Chip
      clickable
      size="small"
      variant="outlined"
      icon={viewChipIcon('chat')}
      label={children}
      onClick={() => openChat({ kind: 'chat', agent, text })}
      sx={{ mr: 0.5, mb: 0.5 }}
    />
  );
}
