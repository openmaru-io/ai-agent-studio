/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 도움말 서랍(OMAI-1274). 상단 막대의 도움말 단추·`?` 키·계정 메뉴 「단축키」가 연다(주소 없이 openDrawer, 재검토 D3).
// - 맨 위: 「이어서 하기」(멈춘 가이드), 「이 화면에서 할 수 있는 일」(지금 화면의 가이드, 디자인 리뷰 1A). 아래는 주제 묶음.
// - 검색은 지금 언어의 제목·한 줄 설명만 찾고, 검색어가 있으면 탭과 상관없이 볼 수 있는 모든 가이드에서 찾는다(14A).
// - 가이드를 누르면 같은 서랍 안에서 무엇에 쓰는지·언제 필요한지·단계(제목과 설명)를 보이고, 아래 고정 줄의 「따라하기 시작」이 진행 카드를 띄운다(8A).
import type { SvgIconComponent } from '@mui/icons-material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import FormatListNumberedIcon from '@mui/icons-material/FormatListNumbered';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import ScheduleOutlinedIcon from '@mui/icons-material/ScheduleOutlined';
import SearchIcon from '@mui/icons-material/Search';
import SearchOffIcon from '@mui/icons-material/SearchOff';
import TimelapseIcon from '@mui/icons-material/Timelapse';
import { Box, Button, InputAdornment, List, ListItemButton, Tab, Tabs, TextField, Typography, useTheme } from '@mui/material';
import { ReactNode, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { t } from '@/i18n';
import { openChat } from '@/lib/chatPopup';
import { PRIMARY } from '@/lib/chatStore';
import { doneGuides, lastHelpTab, resumable, resumeGuide, saveHelpTab, useGuideRun } from '@/lib/guideRun';
import { GROUPS, Guide, GUIDES, guidesForView, matchesQuery } from '@/lib/guides';
import { guideSub, guideTitle, guideWhat, guideWhen, stepBody, stepTitle } from '@/lib/guideText';
import { dialogTokens, tabTokens } from '@/lib/shellTokens';
import { shortcuts, Viewer } from '@/lib/views';

import { PanelEmpty } from '../PanelEmpty';
import { tier1 } from '../tierButton';

export type HelpTab = 'user' | 'admin' | 'shortcuts';

function ShortcutsTable({ who }: { who: Viewer }) {
  return (
    <Box
      component="table"
      sx={{
        width: '100%',
        borderCollapse: 'collapse',
        '& th': { pb: 1, fontSize: 12, fontWeight: 500, color: 'text.secondary' },
        '& td': { py: 1, pr: 2, verticalAlign: 'top', borderTop: 1, borderColor: 'divider', fontSize: 14 },
        // 글쇠는 눌리는 단추처럼 아래 테두리를 두껍게 한다
        '& kbd': { display: 'inline-block', minWidth: 24, px: 0.75, py: '1px', fontFamily: 'inherit', fontSize: 12, textAlign: 'center', border: 1, borderBottomWidth: 2, borderColor: 'divider', borderRadius: '4px', bgcolor: 'action.hover' },
      }}
    >
      <thead>
        <tr>
          <Box component="th" sx={{ textAlign: 'left', pr: 2 }}>
            {t('shell.shortcutKey')}
          </Box>
          <Box component="th" sx={{ textAlign: 'left' }}>
            {t('shell.shortcutAction')}
          </Box>
        </tr>
      </thead>
      <tbody>
        {shortcuts(who).map(([k, d]) => (
          <tr key={k}>
            <td style={{ whiteSpace: 'nowrap' }}>
              <kbd>{k}</kbd>
            </td>
            <td>{d}</td>
          </tr>
        ))}
      </tbody>
    </Box>
  );
}

/** 묶음 제목. 오른쪽 숫자는 그 묶음에서 끝낸 가이드 수다 */
function GroupHead({ children, done, total }: { children: ReactNode; done?: number; total?: number }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'baseline', pl: 1.25, pr: '34px', pt: 2.5, pb: 0.75 }}>
      <Typography component="h3" sx={{ flex: 1, fontSize: 12, fontWeight: 600, color: 'text.secondary' }}>
        {children}
      </Typography>
      {total !== undefined && (
        <Typography component="span" aria-hidden sx={{ fontSize: 12, color: 'text.disabled', fontVariantNumeric: 'tabular-nums' }}>
          {`${done}/${total}`}
        </Typography>
      )}
    </Box>
  );
}

/** 가이드 상세의 구역 제목(가이드 제목 h3 아래) */
/** 상세 소제목 아이콘 크기와 간격. 내용은 아이콘 다음, 제목 글자가 시작하는 자리에 맞춰 들여쓴다 */
const HEAD_ICON = 18;
const HEAD_GAP = 8;
const DETAIL_INDENT = `${HEAD_ICON + HEAD_GAP}px`;

function DetailHead({ icon, children }: { icon: SvgIconComponent; children: ReactNode }) {
  const Icon = icon;
  return (
    <Typography component="h4" variant="body2" sx={{ display: 'flex', alignItems: 'center', gap: `${HEAD_GAP}px`, fontWeight: 600, mt: 2, mb: 0.5 }}>
      <Icon aria-hidden sx={{ fontSize: HEAD_ICON, color: 'text.secondary', flexShrink: 0 }} />
      {children}
    </Typography>
  );
}

export interface HelpDrawerProps {
  who: Viewer;
  initialTab?: HelpTab;
  /** 「따라하기 시작」: 도움말 서랍을 닫고 그 가이드를 시작한다 */
  onStart: (id: string) => void;
}

export function HelpDrawer({ who, initialTab, onStart }: HelpDrawerProps) {
  const loc = useLocation();
  const view = loc.pathname.split('/').filter(Boolean)[0] ?? 'dashboard';
  const run = useGuideRun();
  const saved = lastHelpTab();
  const [tab, setTab] = useState<HelpTab>(
    initialTab ?? (who.admin && (saved === 'admin' || saved === 'user') ? (saved as HelpTab) : 'user')
  );
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Guide | null>(null);
  const done = useMemo(doneGuides, [run]);
  const resume = resumable();
  const theme = useTheme();
  const mode = theme.palette.mode;
  const tk = dialogTokens[mode];
  const accent = tabTokens[mode].accent;

  const visible = GUIDES.filter((g) => who.admin || g.audience === 'user');
  const changeTab = (v: HelpTab) => {
    setTab(v);
    setOpen(null);
    if (who.admin && v !== 'shortcuts') saveHelpTab(v);
  };

  const askAi = () => openChat({ kind: 'chat', agent: PRIMARY, text: t('guides.askAiText') });

  const stateOf = (g: Guide) => (resume?.id === g.id ? 'doing' : done.has(g.id) ? 'done' : 'todo');
  const row = (g: Guide, showAdmin = false) => {
    const st = stateOf(g);
    const Icon = st === 'done' ? CheckCircleOutlineIcon : st === 'doing' ? TimelapseIcon : RadioButtonUncheckedIcon;
    return (
      <li key={g.id} style={{ listStyle: 'none' }}>
        <ListItemButton
          onClick={() => setOpen(g)}
          data-guide-row={g.id}
          sx={{ minHeight: 44, borderRadius: '8px', gap: 1.25, px: 1.25, '& .row-go': { opacity: 0 }, '&:hover .row-go, &.Mui-focusVisible .row-go': { opacity: 1 } }}
        >
          <Icon
            aria-hidden
            sx={{ fontSize: 18, flexShrink: 0, color: st === 'done' ? '#27a644' : st === 'doing' ? 'text.secondary' : 'text.disabled' }}
          />
          <Box component="span" sx={{ flex: 1, minWidth: 0 }}>
            <Typography component="span" variant="body2" sx={{ display: 'block', color: st === 'done' ? 'text.secondary' : tk.title }}>
              {guideTitle(g)}
              {showAdmin && g.audience === 'admin' && (
                <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.75 }}>
                  {t('guides.adminMark')}
                </Typography>
              )}
            </Typography>
          </Box>
          <Typography
            component="span"
            variant="caption"
            sx={{ flexShrink: 0, px: 0.875, py: '1px', borderRadius: '10px', fontVariantNumeric: 'tabular-nums', color: st === 'doing' ? tk.title : 'text.secondary', bgcolor: 'action.hover' }}
          >
            {st === 'doing' && resume ? `${resume.step + 1}/${g.steps.length}` : t('guides.stepCount', { n: g.steps.length })}
          </Typography>
          <ChevronRightIcon className="row-go" aria-hidden sx={{ fontSize: 18, color: 'text.secondary', mr: -0.5, transition: 'opacity 120ms' }} />
          <Box component="span" sx={visuallyHiddenSx}>
            {t(`guides.state.${st}`)}
          </Box>
        </ListItemButton>
      </li>
    );
  };

  if (open) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100%', '& > p, & > h3, & > h4, & > ol': { maxWidth: '72ch' } }}>
        <Button size="small" color="inherit" startIcon={<ArrowBackIcon />} onClick={() => setOpen(null)} sx={{ alignSelf: 'flex-start', mb: 1.5, ml: -1, color: 'text.secondary', '&:hover': { color: tk.title } }}>
          {t('guides.back')}
        </Button>
        <Typography variant="h6" component="h3" sx={{ fontSize: 20, fontWeight: 600, lineHeight: 1.35, letterSpacing: '-0.01em', color: tk.title }}>
          {guideTitle(open)}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 1.5, lineHeight: 1.6 }}>
          {guideSub(open)}
        </Typography>
        {/* 무엇에 쓰는지·언제 필요한지·어떻게 하는지를 사용자 말로 */}
        <DetailHead icon={InfoOutlinedIcon}>{t('guides.detail.what')}</DetailHead>
        <Typography variant="body2" sx={{ pl: DETAIL_INDENT, lineHeight: 1.65 }}>
          {guideWhat(open)}
        </Typography>
        <DetailHead icon={ScheduleOutlinedIcon}>{t('guides.detail.when')}</DetailHead>
        <Typography variant="body2" sx={{ pl: DETAIL_INDENT, lineHeight: 1.65 }}>
          {guideWhen(open)}
        </Typography>
        <DetailHead icon={FormatListNumberedIcon}>{t('guides.detail.how')}</DetailHead>
        {/* 단계는 차례가 있으므로 번호 원과 잇는 세로선으로 그린다. 원은 위 문단과 같은 들여쓰기 선에서 시작한다 */}
        <Box component="ol" sx={{ m: 0, mt: 0.5, pl: DETAIL_INDENT, flex: 1, listStyle: 'none' }}>
          {open.steps.map((s, i) => (
            <Box component="li" key={s.id} sx={{ position: 'relative', display: 'flex', gap: 1.5, pb: i === open.steps.length - 1 ? 0 : 2 }}>
              {i < open.steps.length - 1 && <Box aria-hidden sx={{ position: 'absolute', left: 11, top: 26, bottom: 2, width: '1px', bgcolor: 'divider' }} />}
              <Box
                aria-hidden
                sx={{ width: 24, height: 24, flexShrink: 0, borderRadius: '50%', border: `1px solid ${tk.edge}`, bgcolor: 'action.hover', display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 600, color: accent, fontVariantNumeric: 'tabular-nums' }}
              >
                {i + 1}
              </Box>
              <Box sx={{ minWidth: 0, pt: '2px' }}>
                <Typography variant="body2" data-step-title sx={{ fontWeight: 600, color: tk.title }}>
                  {stepTitle(open, i)}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25, lineHeight: 1.6 }}>
                  {stepBody(open, i)}
                </Typography>
              </Box>
            </Box>
          ))}
        </Box>
        {/* 고정 동작 줄: 단계가 길어도 「따라하기 시작」이 늘 보인다(디자인 리뷰 8A) */}
        <Box sx={{ position: 'sticky', bottom: -24, mx: -2, mt: 2, px: 2, py: 1.5, bgcolor: 'background.paper', borderTop: 1, borderColor: 'divider', display: 'flex', justifyContent: 'flex-end' }}>
          <Button variant="outlined" color="inherit" sx={tier1} startIcon={<PlayArrowOutlinedIcon />} onClick={() => onStart(open.id)}>
            {t('guides.start')}
          </Button>
        </Box>
      </Box>
    );
  }

  const audience = tab === 'admin' ? 'admin' : 'user';
  const here = q ? [] : guidesForView(view, who.admin).filter((g) => g.audience === audience);
  const hereIds = new Set(here.map((g) => g.id));
  const found = q ? visible.filter((g) => matchesQuery(guideTitle(g), q) || matchesQuery(guideSub(g), q)) : [];
  const resumeGuideItem = resume && GUIDES.find((g) => g.id === resume.id);

  const mine = visible.filter((g) => g.audience === audience);
  const doneCount = mine.filter((g) => done.has(g.id)).length;

  return (
    <Box sx={{ maxWidth: 720 }}>
      <TextField
        size="small"
        fullWidth
        type="search"
        placeholder={t('guides.search')}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        slotProps={{
          htmlInput: { 'aria-label': t('guides.search') },
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon aria-hidden sx={{ fontSize: 18, color: 'text.secondary' }} />
              </InputAdornment>
            ),
          },
        }}
        sx={{ mb: 1, '& .MuiOutlinedInput-root': { borderRadius: '8px', bgcolor: 'action.hover' } }}
      />
      {!q && (
        <Tabs value={tab} onChange={(_, v: HelpTab) => changeTab(v)} aria-label={t('guides.tabs')} variant="scrollable" sx={{ mb: 1 }}>
          <Tab value="user" label={t('guides.tab.user')} />
          {who.admin && <Tab value="admin" label={t('guides.tab.admin')} />}
          <Tab value="shortcuts" label={t('guides.tab.shortcuts')} />
        </Tabs>
      )}
      {!q && tab === 'shortcuts' ? (
        <ShortcutsTable who={who} />
      ) : q ? (
        found.length ? (
          <List disablePadding>{found.map((g) => row(g, true))}</List>
        ) : (
          <PanelEmpty
            icon={SearchOffIcon}
            title={t('guides.empty', { q })}
            sub={t('guides.emptySub')}
            action={
              <Button startIcon={<AutoAwesomeOutlinedIcon />} size="small" variant="outlined" color="inherit" onClick={askAi}>
                {t('guides.askAi')}
              </Button>
            }
          />
        )
      ) : (
        <>
          {mine.length > 0 && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 1.25, pt: 1.5, pb: 0.5 }}>
              <Box aria-hidden sx={{ flex: 1, height: 4, borderRadius: 2, bgcolor: tabTokens[mode].line, overflow: 'hidden' }}>
                <Box sx={{ height: '100%', width: `${(doneCount / mine.length) * 100}%`, bgcolor: '#27a644', borderRadius: 2 }} />
              </Box>
              <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                {t('guides.progress', { done: doneCount, total: mine.length })}
              </Typography>
            </Box>
          )}
          {resumeGuideItem && !run.run && (
            <ListItemButton onClick={resumeGuide} sx={{ minHeight: 48, mt: 1.5, borderRadius: '8px', px: 1.25, gap: 1.25, border: `1px solid ${tk.edge}`, bgcolor: 'action.hover' }}>
              <TimelapseIcon aria-hidden sx={{ fontSize: 18, color: tk.title }} />
              <Typography variant="body2" sx={{ flex: 1, color: tk.title, fontWeight: 500 }}>
                {t('guides.resume', { name: guideTitle(resumeGuideItem), step: resume!.step + 1, total: resumeGuideItem.steps.length })}
              </Typography>
              <ChevronRightIcon aria-hidden fontSize="small" />
            </ListItemButton>
          )}
          {/* 지금 화면의 가이드는 테두리 판으로 묶어 다른 묶음보다 먼저 보이게 한다 */}
          {here.length > 0 && (
            <Box sx={{ mt: 1.5, pb: 0.5, border: `1px solid ${tk.edge}`, borderRadius: '10px', bgcolor: 'action.hover' }}>
              <Box sx={{ mt: -1.25 }}>
                <GroupHead>{t('guides.here')}</GroupHead>
              </Box>
              <List disablePadding sx={{ px: 0.5 }}>
                {here.map((g) => row(g))}
              </List>
            </Box>
          )}
          {GROUPS.map((grp) => {
            const items = visible.filter((g) => g.group === grp && g.audience === audience && !hereIds.has(g.id));
            if (!items.length) return null;
            return (
              <Box key={grp}>
                <GroupHead done={items.filter((g) => done.has(g.id)).length} total={items.length}>
                  {t(`guides.group.${grp}`)}
                </GroupHead>
                <List disablePadding>{items.map((g) => row(g))}</List>
              </Box>
            );
          })}
          {audience === 'admin' && !visible.some((g) => g.audience === 'admin') && <PanelEmpty icon={SearchOffIcon} title={t('guides.noAdmin')} />}
          <Box sx={{ mt: 3, pt: 2, borderTop: 1, borderColor: 'divider' }}>
            <Button size="small" color="inherit" startIcon={<AutoAwesomeOutlinedIcon />} onClick={askAi} sx={{ color: 'text.secondary', '&:hover': { color: tk.title } }}>
              {t('guides.askAiAll')}
            </Button>
          </Box>
        </>
      )}
    </Box>
  );
}

const visuallyHiddenSx = {
  border: 0,
  clip: 'rect(0 0 0 0)',
  height: '1px',
  margin: '-1px',
  overflow: 'hidden',
  padding: 0,
  position: 'absolute',
  whiteSpace: 'nowrap',
  width: '1px',
} as const;
