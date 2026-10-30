/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 오피스: 에이전트가 앉아 일하는 3D 사무실(Claw3D)과 자리·TFT 방 기록. 3D 장면은 이 화면에서만 불러온다.
import { Alert, Box, Chip, LinearProgress, MenuItem, Stack, Tab, Tabs, TextField, Typography, useMediaQuery } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { lazy, ReactNode, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { AgentChip } from '@/components/AgentChip';
import { KV, LinkChip, ScreenLoading, Tag } from '@/components/bits';
import { PageTitle } from '@/components/PageTitle';
import { TabCountBadge } from '@/components/TabCountBadge';
import { useUi } from '@/components/UiContext';
import { useFillHeight } from '@/components/useFillHeight';
import { UserChip } from '@/components/UserChip';
import { RouteDrawerContent, useOpenParam, useParamPatch, useRouteDrawerValue } from '@/components/useRouteDrawer';
import { ALL, departmentOptions, filterAgents, filterPeople, initialDepartment, readDepartment, writeDepartment } from '@/features/office/adminScope';
import { AgentChat } from '@/features/office/AgentChat';
import { AgentCron } from '@/features/office/AgentCron';
import { useAmbient } from '@/features/office/ambient';
import { faceUrl } from '@/features/office/avatars/face';
import { type Banner, readBannerOff, writeBannerOff } from '@/features/office/banner';
import { bubbles, isAway } from '@/features/office/bubbles';
import { OfficeCard, toBoard, useOfficeCards } from '@/features/office/cards';
import { BoardPanel, ServerPanel } from '@/features/office/DevicePanels';
import { DeskDeleteDialog, deskOccupant, EditPanel } from '@/features/office/EditPanel';
import { greetingLines } from '@/features/office/greetings';
import { hudRooms, sceneStatus, STATUS_LABEL, statusChanges } from '@/features/office/hud';
import { InboxPanel } from '@/features/office/InboxPanel';
import { meetingForRoom, meetingSeatsByAgent, roomOfScreen, roomPlace, roomsInMeeting, roomStatuses, toStandup, useActiveMeetingsState } from '@/features/office/meetings';
import { agentName, ServerAgent, toOfficeAgents } from '@/features/office/model';
import { Office2D } from '@/features/office/Office2D';
import { useOfficeChanged } from '@/features/office/officeChanged';
import { HudBanner, OfficeHud } from '@/features/office/OfficeHud';
import { publishPosition, usePeoplePositions } from '@/features/office/people';
import { PresenceStrip } from '@/features/office/PresenceStrip';
import type { CameraNudge } from '@/features/office/scene3d/retro-office/core/cameraFocus';
import type { FurnitureItem } from '@/features/office/scene3d/retro-office/core/types';
import type { AasEditorApi, AasEditorState } from '@/features/office/scene3d/retro-office/RetroOffice3D';
import { canUseWebGL, SceneBoundary } from '@/features/office/SceneBoundary';
import { useInbox, waiting } from '@/features/office/useInbox';
import { useOfficeLayout } from '@/features/office/useOfficeLayout';
import { useOfficeState } from '@/features/office/useOfficeState';
import { Person, usePresence } from '@/features/office/usePresence';
import { getLang, t } from '@/i18n';
import { agentProfileLabel } from '@/lib/agentLabel';
import { ApiError, get, post } from '@/lib/api';
import { openChat } from '@/lib/chatPopup';
import { isAdmin, useMe } from '@/lib/data';
import { officeTitle } from '@/lib/officeName';
import { openRoomChat, useRoomChatPopup } from '@/lib/roomChatPopup';
import { useWsState } from '@/lib/ws';
import { Room, Seat, tftRooms } from '@/screens/office/forms';
import { Kanban } from '@/screens/office/Kanban';
import { Meeting } from '@/screens/office/Meeting';
import { useRoomEditor } from '@/screens/office/Tables';

const OfficeScene = lazy(() => import('@/features/office/OfficeScene'));
// 자리·TFT 방 탭은 공통 표(표 라이브러리 vendor-grid)를 쓴다. 첫 화면 묶음에 들어가지 않게 그 탭을 열 때만 받는다(재검토 D3)
const SeatsTab = lazy(() => import('@/screens/office/Tables').then((m) => ({ default: m.SeatsTab })));
const RoomsTab = lazy(() => import('@/screens/office/Tables').then((m) => ({ default: m.RoomsTab })));

interface OfficeData {
  seats: Seat[];
  rooms: Room[];
  pods: { id: string; owner: string; profiles: { name: string; seated: boolean }[] }[];
  problems: { level: string; text: string }[];
  can_edit: boolean;
  /** 오피스 API 를 쓸 수 있는 사람(칸반 카드·회의 말하기). 어느 에이전트·방인지는 서버가 거른다. */
  can_act?: boolean;
  /** 부서 슬로건·목표 현수막(스펙 2026-10-15-018): 문구가 있는 부서와 내 부서 */
  banners?: Banner[];
  mine?: string;
  /** 내 에이전트의 자리 — 칸반 「카드 추가」 담당의 처음 값(OMAI-1286) */
  my_seat?: string;
  /** 관리자에게만: 「볼 부서」 콤보박스 후보(AAS 부서 목록 + 목록에 없는 내 부서, 스펙 2026-10-22-002) */
  departments?: string[];
}

// 회의와 TFT 방은 서로 오가므로 붙이고, 관리자 설정인 배치는 끝에 둔다(스펙 2026-10-20-019)
const TABS = [
  ['room', 'office.title'],
  ['kanban', 'office.kanban'],
  ['meeting', 'office.tabMeeting'],
  ['rooms', 'office.tabRooms'],
  ['seats', 'office.tabSeats'],
] as const;

const STATUS: Record<string, { label: string; tone?: 'bad' | 'good' }> = {
  working: { label: 'office.statusWorking', tone: 'good' },
  idle: { label: 'office.statusIdle' },
  error: { label: 'office.statusError', tone: 'bad' },
};

function AgentPanel({
  agent,
  rooms,
  cards,
  canAct,
  onChat,
}: {
  agent: ServerAgent;
  rooms: Room[];
  cards: OfficeCard[];
  canAct: boolean;
  /** 대화 팝업을 연다(OMAI-1115). */
  onChat: (alias: string) => void;
}) {
  const own = cards.filter((c) => c.assignee === agent.alias && c.status !== 'done');
  const st = STATUS[agent.status] ?? STATUS.idle;
  const mine = rooms.filter((r) => r.status !== 'closed' && r.seats.includes(agent.alias));
  const [tab, setTab] = useState<'info' | 'chat' | 'cron'>('info');
  // owner_email 은 관리자에게만 온다 — 주인과 관리자만 「새 크론」을 본다
  return (
    <Stack spacing={1.5}>
      <Tabs value={tab} onChange={(_, v: 'info' | 'chat' | 'cron') => setTab(v)} aria-label={t('office.panelTabs')}>
        <Tab value="info" label={t('office.panelInfo')} />
        <Tab value="chat" label={t('office.agentChat')} />
        <Tab value="cron" label={t('office.agentCron')} />
      </Tabs>
      {tab === 'chat' && <AgentChat alias={agent.alias} />}
      {tab === 'cron' && <AgentCron alias={agent.alias} canAct={canAct} createProfile={agent.mine || agent.owner_email !== undefined ? agent.profile : undefined} />}
      {tab === 'info' && (
        <Stack spacing={1.5}>
          <KV
            pairs={[
              [
                t('office.panelStatus'),
                <Tag key="s" tone={st.tone}>
                  {t(st.label)}
                </Tag>,
              ],
              ...(agent.owner_name ? [[t('office.panelOwner'), <UserChip key="u" name={agent.owner_name} />] as [string, ReactNode]] : []),
              [t('office.panelPod'), <AgentChip key="p" name={agent.pod_name || agent.pod} colorKey={agent.pod} title={agent.pod_name ? agent.pod : undefined} size="sm" />],
              [t('office.panelProfile'), agent.profile],
              [t('office.panelRole'), agent.role],
              [t('office.panelTeam'), agent.team],
            ]}
          />
          <Box>
            <Chip
              clickable
              size="small"
              variant="outlined"
              label={t('office.chatWith', { profile: agent.profile })}
              onClick={() => onChat(agent.alias)}
              sx={{ mr: 0.5, mb: 0.5 }}
            />
            <LinkChip to="cron" params={{ q: agent.profile }}>
              {t('office.viewCron')}
            </LinkChip>
            <LinkChip to="office" params={{ tab: 'kanban' }}>
              {t('office.viewKanban')}
            </LinkChip>
            {mine.map((r) => (
              <LinkChip key={r.id} to="office" params={{ tab: 'meeting', room: r.id }}>
                {t('office.meetingLink', { name: r.name })}
              </LinkChip>
            ))}
          </Box>
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              {t('office.agentCards')}
            </Typography>
            {own.length ? (
              <Stack component="ul" spacing={0.5} sx={{ listStyle: 'none', m: 0, p: 0 }}>
                {own.slice(0, 20).map((c) => (
                  <Typography component="li" variant="body2" key={`${c.board}/${c.task_id}`}>
                    {c.title}{' '}
                    <Typography component="span" variant="caption" color="text.secondary">
                      · {c.status}
                    </Typography>
                  </Typography>
                ))}
              </Stack>
            ) : (
              <Typography variant="body2" color="text.secondary">
                {t('office.noAgentCards')}
              </Typography>
            )}
          </Box>
        </Stack>
      )}
    </Stack>
  );
}

/** 1분마다 바뀌는 지금 시각(ms). 부재(30분) 판단에 쓴다. */
function useMinute(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/** 상태가 바뀐 에이전트를 10초에 한 번 묶어 스크린리더에 알린다(G8). */
function useStatusAnnouncer(agents: ServerAgent[]): string {
  const prev = useRef<ServerAgent[] | null>(null);
  const pending = useRef<ServerAgent[]>([]);
  const [text, setText] = useState('');
  useEffect(() => {
    if (prev.current) pending.current = [...pending.current, ...statusChanges(prev.current, agents)];
    prev.current = agents;
  }, [agents]);
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!pending.current.length) return;
      const last = new Map(pending.current.map((a) => [a.alias, a]));
      pending.current = [];
      setText(
        [...last.values()]
          .map((a) => t('office.statusChanged', { name: agentName(a), status: t(STATUS_LABEL[sceneStatus(a)]) }))
          .join(', ')
      );
    }, 10000);
    return () => window.clearInterval(id);
  }, []);
  return text;
}

/** 처음 방문(세션당 한 번): 카메라를 내 에이전트로 옮기고 한 줄 안내를 3초 보인다(계획 007 G5). */
function useFirstVisit(agents: ServerAgent[], focusOn: (alias: string) => void): boolean {
  const [hint, setHint] = useState(false);
  const mine = agents.find((a) => a.mine)?.alias;
  useEffect(() => {
    if (!mine) return undefined;
    try {
      if (sessionStorage.getItem('aas.office.firstVisit')) return undefined;
      sessionStorage.setItem('aas.office.firstVisit', '1');
    } catch {
      return undefined;
    }
    focusOn(mine);
    setHint(true);
    const id = window.setTimeout(() => setHint(false), 3000);
    return () => window.clearTimeout(id);
    // 처음 한 번만 — focusOn 은 렌더마다 새로 만들어지므로 의존성에서 뺀다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine]);
  return hint;
}

/** roomsStale: 방 목록 다시 읽기 실패(N7). onRefreshRooms: 방 목록을 다시 읽는다(상태판 회의실 탭을 고르거나 2D 목록을 펼칠 때, R9·N8) */
function Room3D({
  data,
  people,
  onMeeting,
  roomsStale = false,
  onRefreshRooms,
  department = ALL,
}: {
  data: OfficeData;
  people: Person[];
  onMeeting: () => void;
  roomsStale?: boolean;
  onRefreshRooms?: () => void;
  /** 관리자가 고른 「볼 부서」. ALL 이면 거르지 않는다(스펙 2026-10-22-002) */
  department?: string;
}) {
  const officeQuery = useQueryClient();
  const adminView = isAdmin(useMe().data);
  // 관리자는 방 구성원 부서(rooms[].teams)로 거르므로, 자리·방이 바뀌어 장면이 다시 받을 때 /api/office 도 다시 읽는다(리뷰 R3)
  const { state, live, error, updatedAt } = useOfficeState(adminView ? () => void officeQuery.invalidateQueries({ queryKey: ['office'] }) : undefined);
  const { layout, error: layoutError, bootstrap } = useOfficeLayout(state?.layoutVersion);
  const { openDrawer, drawers } = useUi();
  const me = useMe();
  const narrow = useMediaQuery('(max-width:599.95px)');
  const webgl = useMemo(() => canUseWebGL(), []);
  const [chosen, setChosen] = useState<'3d' | '2d' | null>(null);
  const view: '3d' | '2d' = !webgl ? '2d' : chosen ?? (narrow ? '2d' : '3d'); // 좁은 화면은 2D 가 기본(G9)
  // 내 아바타로 걷기(계획 007 P6b): 900px 이상·3D·웹소켓 연결일 때만(G9). 위치는 웹소켓으로만 주고받는다
  const wide = useMediaQuery('(min-width:900px)');
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const wsLive = useWsState() === 'live';
  const fill = useFillHeight<HTMLDivElement>();
  // 관리자 배치 편집(계획 007 P7). 편집하는 동안 걷기는 끈다(두 번 누르기가 겹친다)
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const ambient = useAmbient();
  // 현수막 끄기: 이 브라우저에만 기억한다. 3D 보기에서만 그린다(2D 보기에는 만들지 않는다, 스펙 2026-10-15-018 D5)
  const [bannerOff, setBannerOff] = useState(readBannerOff);
  const hasBanners = !!data.banners?.length;
  const sceneBanner = hasBanners && !bannerOff ? { banners: data.banners ?? [], mine: data.mine ?? '' } : null;
  const editorApi = useRef<AasEditorApi | null>(null);
  const [edState, setEdState] = useState<AasEditorState>({ selected: null, dirty: false, placing: null });
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [deskToDelete, setDeskToDelete] = useState<string | null>(null);
  const walking = wide && wsLive && view === '3d' && !editing;
  const positions = usePeoplePositions(wsLive && view === '3d');
  const scenePeople = useMemo(
    () => ({
      people: people.map((p) => ({
        id: p.id,
        name: p.name,
        subtitle: p.me ? t('office.personMe') : t('office.person'),
        faceUrl: faceUrl(p.seed, true),
        pos: positions[p.id] ?? null,
        me: p.me,
      })),
      walk: walking,
      instant: reduced,
      onMove: publishPosition,
    }),
    [people, positions, walking, reduced]
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [following, setFollowing] = useState<string | null>(null);
  // highlight: 장면이 잠깐 표시할 대상(에이전트 별칭 또는 방 표시 uid). 사용자가 상태판에서 고를 때만 준다(스펙 2026-10-21-012 D6)
  const [focus, setFocus] = useState<{ id: string; n: number; at?: { x: number; y: number }; zoom?: boolean; highlight?: string } | null>(null);
  const [cameraCommand, setCameraCommand] = useState<{ kind: CameraNudge | 'reset'; n: number } | null>(null);
  const minute = useMinute();
  const cards = useOfficeCards();
  const boardCards = useMemo(() => toBoard(cards), [cards]);
  const { items: inboxItems } = useInbox();
  const needsAnswer = useMemo(() => new Set(waiting(inboxItems).map((i) => i.alias)), [inboxItems]);
  const allAgents = useMemo(
    () => (state?.agents ?? []).map((a) => ({ ...a, away: isAway(a, minute / 1000) })),
    [state, minute]
  );
  // 관리자의 「볼 부서」(스펙 2026-10-22-002): 장면·상태판·명단·회의 걷기가 모두 이 목록을 쓴다
  const serverAgents = useMemo(() => filterAgents(allAgents, department, data.rooms), [allAgents, department, data.rooms]);
  const speech = useMemo(
    () =>
      bubbles(
        serverAgents,
        state?.activity,
        {
          tool: (name) => t('office.bubbleTool', { name }),
          private: t('office.bubblePrivate'),
          needsAnswer: t('office.needsAnswer'),
        },
        following,
        needsAnswer
      ),
    [serverAgents, state?.activity, following, needsAnswer]
  );
  const lastSeen = useMemo(
    () => Object.fromEntries(serverAgents.filter((a) => a.last_seen).map((a) => [a.alias, (a.last_seen ?? 0) * 1000])),
    [serverAgents]
  );
  const agents = useMemo(() => toOfficeAgents(serverAgents), [serverAgents]);
  const announce = useStatusAnnouncer(serverAgents);
  const now = useNow(!live);
  const desks = state?.desks ?? layout?.desks ?? {};
  // 대화 팝업(OMAI-1115): 내 에이전트면 채팅 경로(채팅 화면과 같은 대화), 아니면 오피스 대화 경로(방 구성원도 쓴다).
  // 지금 고른 POD 가 아닌 내 에이전트도 그 POD 의 채팅 묶음으로 연다 — 오피스 경로는 머리·첨부가 없다(사용자 보고 2026-10-21)
  const openAgentChat = (alias: string) => {
    const a = serverAgents.find((x) => x.alias === alias);
    if (!a) return;
    if (a.mine) openChat(a.pod === me.data?.pod?.id ? { kind: 'chat', agent: a.profile } : { kind: 'chat', agent: a.profile, pod: a.pod });
    else openChat({ kind: 'office', alias: a.alias, title: agentName(a) });
  };
  const agentSpec = (alias: string) => {
    const a = serverAgents.find((x) => x.alias === alias);
    if (!a) return null;
    return {
      title: agentName(a),
      sub: agentProfileLabel({ id: a.pod, name: a.pod_name, owner_name: a.owner_name }, a.profile), // 「주인 · 에이전트 › 프로파일」(스펙 2026-10-19-003)
      body: (
        <AgentPanel
          agent={a}
          rooms={data.rooms}
          cards={cards}
          canAct={!!(data.can_act ?? data.can_edit)}
          onChat={openAgentChat}
        />
      ),
    };
  };
  // 명단·말풍선의 「상세」 로 연 에이전트 서랍은 주소 `open=<별칭>` 과 묶는다(스펙 2026-10-28-014 §4-4). 열기·닫기·기록·저장 확인은 공용 규칙(useRouteDrawerValue)이다.
  // pod 는 쓰지 않는다 — 오피스 상태(/api/office/state)는 지금 고른 POD 가 아니라 볼 수 있는 모든 POD 의 자리를 한 장면에 모으고, 별칭은 오피스 안에서 하나뿐이다.
  // 서랍은 열 때의 값(상태·방·카드)을 들고 있으므로, 웹소켓·다시 읽기로 값이 바뀌면 같은 서랍의 첫 페이지를 새 값으로 바꾼다(deps)
  const [params] = useSearchParams();
  const openAlias = params.get('open');
  const writeOpen = useOpenParam('open');
  const patchParams = useParamPatch();
  const { enqueueSnackbar } = useSnackbar();
  // 이 값으로 서랍을 연 적이 있는가. 연 뒤 자리에서 빠진 에이전트는 지금처럼 서랍을 마지막 값으로 둔다(부서로 숨은 것은 아래에서 닫는다)
  const seenOpen = useRef<string | null>(null);
  if (!openAlias) seenOpen.current = null;
  else if (drawers.some((d) => d.id === 'route:open')) seenOpen.current = openAlias;
  const openFound = !!openAlias && serverAgents.some((a) => a.alias === openAlias);
  const lastAgentSpec = useRef<RouteDrawerContent | null>(null);
  useRouteDrawerValue(
    'open',
    state && openAlias && (openFound || seenOpen.current === openAlias) ? openAlias : null,
    (alias) => {
      const spec = agentSpec(alias);
      if (spec) lastAgentSpec.current = spec;
      return spec ?? lastAgentSpec.current ?? { title: alias, body: null };
    },
    [],
    [serverAgents, cards, data.rooms, data.can_act, data.can_edit]
  );
  // 링크의 에이전트가 이 오피스에 없으면(자리에서 빠짐·지금 보는 부서 밖) 서랍을 열지 않고 알린 뒤 값을 지운다
  const openMissing = !!state && !!openAlias && !openFound && seenOpen.current !== openAlias;
  useEffect(() => {
    if (!openMissing || !openAlias) return;
    enqueueSnackbar(t('office.linkAgentMissing', { alias: openAlias }), { variant: 'warning' });
    patchParams({ open: null }, { replace: true });
  }, [openMissing, openAlias, enqueueSnackbar, patchParams]);
  // 「볼 부서」를 바꿔 장면에서 빠진 에이전트의 선택·따라가기·카메라 목표를 풀고 그 상세 서랍을 닫는다. 대화 창은 그대로(스펙 2026-10-22-002 리뷰 R1·R4).
  // 서버에서 자리가 빠진 경우는 지금 동작 그대로 두려고, 부서를 바꿀 때만 본다
  useEffect(() => {
    const shown = new Set(serverAgents.map((a) => a.alias));
    const hidden = (alias: string | null | undefined) => !!alias && !shown.has(alias) && allAgents.some((a) => a.alias === alias);
    if (hidden(selected)) setSelected(null);
    if (hidden(following)) setFollowing(null);
    if (hidden(focus?.id)) setFocus(null);
    // 상세 서랍은 주소 값을 지워 닫는다(replace — 탭을 바꿀 때처럼, 스펙 2026-10-28-014 D12·§8)
    if (hidden(openAlias)) patchParams({ open: null }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [department]);
  // 장면에서 캐릭터 몸통을 누르면 따라가기를 켠다. 이미 따라가는 중이면 끈다. 상세 서랍은 명단·말풍선의 「상세」 로 연다
  const followByClick = (alias: string) => {
    setSelected(alias);
    setFollowing((f) => (f === alias ? null : alias));
  };
  // 「상세」: 주소에 open 을 쓴다. 닫혀 있으면 기록을 한 칸 쌓고, 열려 있으면 바꾼다(D9). 그 주소 변화가 서랍을 연다
  const select = (alias: string) => {
    setSelected(alias);
    if (serverAgents.some((a) => a.alias === alias)) writeOpen({ open: alias });
  };
  const lang = getLang();
  // 말풍선 단추 문구. 언어가 바뀔 때만 새로 만든다(장면의 에이전트들이 매번 다시 그려지지 않게)
  const bubbleLabels = useMemo(
    () => ({ chat: t('office.bubbleChat'), detail: t('office.bubbleDetail'), more: t('office.bubbleMore'), meeting: t('office.roomInMeeting') }),
    [lang] // eslint-disable-line react-hooks/exhaustive-deps
  );
  // 마주친 에이전트의 인사·혼잣말(스펙 2026-10-21-021). 같은 까닭으로 언어가 바뀔 때만 새로 만든다
  const greetings = useMemo(() => greetingLines(t), [lang]); // eslint-disable-line react-hooks/exhaustive-deps
  const focusOn = (alias: string, zoom = false, highlight?: string) =>
    setFocus((f) => ({ id: alias, n: (f?.n ?? 0) + 1, zoom, ...(highlight ? { highlight } : {}) }));
  // 카메라 우선순위(G10): 사용자 직접 조작 > 따라가기 > 회의 연출 > 처음 방문 안내
  const userAt = useRef(0);
  const [tookControl, setTookControl] = useState(false);
  // 명단 행·방향키: 그 에이전트를 고르고 따라가기를 끈 뒤(따라가기는 매 프레임 목표를 덮어쓴다) 카메라를 그 자리로 확대해 옮긴다.
  // 상세 서랍은 행 끝 「상세」 단추로 연다(스펙 2026-10-21-004, 회의실 행과 같은 규칙)
  const userFocus = (alias: string) => {
    setSelected(alias);
    setFollowing(null);
    userAt.current = Date.now();
    setTookControl(true);
    focusOn(alias, true, alias);
  };
  // 장면과 상태판이 회의 목록 하나를 함께 쓴다 — 2D 에서도 상태판 회의실 목록이 읽는다(R15, 스펙 2026-10-20-021 N4)
  const { meetings, ready: meetingsReady, failed: meetingsFailed } = useActiveMeetingsState(true);
  const present = useMemo(() => new Set(serverAgents.map((a) => a.alias)), [serverAgents]);
  const standup = useMemo(
    () =>
      toStandup(meetings[0], present, (alias) => {
        const a = serverAgents.find((x) => x.alias === alias);
        return a ? agentName(a) : alias;
      }),
    [meetings, present, serverAgents]
  );
  // 회의마다 짝지어진 TFT 회의실로 모인다(계획 2026-10-13-001 R4). 장면의 스탠드업 연출은 첫 회의 하나만 그린다
  const meetingSeats = useMemo(
    () => meetingSeatsByAgent(meetings, state?.rooms ?? [], layout?.items ?? [], present),
    [meetings, state?.rooms, layout?.items, present]
  );
  const roomLabels = useMemo(
    () => Object.fromEntries((state?.rooms ?? []).map((r) => [r.uid, r.label])),
    [state?.rooms]
  );
  // 회의 중인 방 명패에 표시를 단다
  const meetingRooms = useMemo(
    () => roomsInMeeting(meetings, state?.rooms ?? [], layout?.items ?? []),
    [meetings, state?.rooms, layout?.items]
  );
  // 명패 둘째 줄(스펙 2026-10-20-017 디자인 리뷰 이슈 1·2): 옮겨 간 팀 회의실은 「→ 대회의실에서 회의 중」, 옮겨 온 회의가 있는 방은 회의 이름·건수
  const roomStatusText = useMemo(() => {
    const items = layout?.items ?? [];
    const labelOf = (uid: string) => roomLabels[uid] ?? items.find((i) => i._uid === uid)?.label ?? '';
    const out: Record<string, { text: string; moved: boolean }> = {};
    for (const [uid, st] of Object.entries(roomStatuses(meetings, state?.rooms ?? [], items))) {
      if (st.state === 'moved') out[uid] = { text: t('office.roomMovedTo', { name: labelOf(st.to) }), moved: true };
      else if ((st.count ?? 1) > 1) out[uid] = { text: t('office.roomMeetingCount', { n: st.count ?? 1 }), moved: false };
      else if (st.names.length) out[uid] = { text: t('office.roomInMeetingNamed', { name: st.names[0] }), moved: false };
    }
    return out;
  }, [meetings, state?.rooms, layout?.items, roomLabels, lang]); // eslint-disable-line react-hooks/exhaustive-deps
  // 회의실 빔 스크린을 누르면 그 방의 회의 대화를 창으로 띄운다(OMAI-1257). 서버 방과 짝이 없으면 방 번호 없이 연다(안내를 보인다)
  // 그 회의실에 모인 회의가 있으면 그 회의를 연다 — 대회의실로 옮겨 온 팀 회의, 같이 쓰면 내가 구성원인 회의 먼저(2026-10-20-017 R7).
  // 창 이름은 회의 이름: 팀 회의는 서버 이름표의 「<팀> 회의실」, 그 밖은 구성원에게 오는 name, 모르면 명패 글자(디자인 리뷰 이슈 3)
  const openRoomItem = (roomItem: FurnitureItem) => {
    const rooms = state?.rooms ?? [];
    const label = rooms.find((r) => r.uid === roomItem._uid);
    const m = meetingForRoom(meetings, rooms, layout?.items ?? [], roomItem._uid);
    const own = m ? rooms.find((r) => r.room === m.room) : undefined;
    const name = m ? (own?.kind === 'team' ? own.label : m.name) : undefined;
    const room = m?.room ?? label?.room ?? null;
    openRoomChat({
      room,
      name: name || label?.label || roomItem.label || '',
      canAct: !!(data.can_act ?? data.can_edit),
      // 빈 대회의실은 TFT 방 안내 대신 대회의실의 쓰임을 알린다(디자인 리뷰 이슈 4)
      ...(room === null && roomItem.kind === 'meeting' ? { emptyNote: t('office.roomChatNoneBig') } : {}),
    });
  };
  const openMeetingScreen = (screenUid: string) => {
    const roomItem = roomOfScreen(layout?.items ?? [], screenUid);
    if (roomItem) openRoomItem(roomItem);
  };
  // 회의실 명패를 눌러도 같은 창을 연다. 배치 편집 중에는 누를 수 없다
  const openRoomLabel = (roomUid: string) => {
    const roomItem = (layout?.items ?? []).find((i) => i._uid === roomUid && i.type === 'room');
    if (roomItem) openRoomItem(roomItem);
  };
  // 상태판 「회의실」 탭(스펙 2026-10-20-021). 방마다 장면 자리·옮겨 간 곳은 meetings.ts 가 계산해 함수로 넘긴다(N2·N3)
  const placeOf = useCallback(
    (id: number) => roomPlace(id, meetings, state?.rooms ?? [], layout?.items ?? []),
    [meetings, state?.rooms, layout?.items]
  );
  const hudRoomRows = useMemo(() => hudRooms(data.rooms, meetings, present, placeOf), [data.rooms, meetings, present, placeOf]);
  const roomChat = useRoomChatPopup();
  const openRoomId = roomChat.target && !roomChat.minimized ? roomChat.target.room : null;
  // 창이 열릴 때 창 제목을 알린다(DR18). announce 상자와 섞지 않고, 같은 방을 다시 열어도 읽히도록 n 을 key 로 다시 그린다(G8)
  const [chatOpened, setChatOpened] = useState<{ name: string; n: number } | null>(null);
  // 팀 방 창 제목은 장면과 같은 서버 이름표(「<팀> 회의실」), 없으면 「<팀> · 팀 회의」, TFT 방은 방 이름(R1)
  // 새 방을 저장한 직후에는 이 렌더의 data 에 그 방이 없다 — 다시 읽은 캐시를 먼저 본다(R14)
  const openRoomById = (id: number) => {
    const r = (qc.getQueryData<OfficeData>(['office'])?.rooms ?? data.rooms).find((x) => x.id === id);
    if (!r) return;
    const own = r.kind === 'team' ? (state?.rooms ?? []).find((x) => x.room === id && x.kind === 'team') : undefined;
    const name = r.kind === 'team' ? own?.label || t('office.teamMeetingOption', { name: r.name }) : r.name;
    openRoomChat({ room: id, name, canAct: !!(data.can_act ?? data.can_edit) });
    setChatOpened((c) => ({ name, n: (c?.n ?? 0) + 1 }));
  };
  // 회의실 행: 따라가기를 끄고(따라가기는 매 프레임 목표를 덮어쓴다, N6) 그 회의실 가운데로 카메라를 옮긴다 — 사용자 조작으로 친다(R12)
  const focusRoom = (id: number) => {
    const { point: at, uid } = placeOf(id);
    if (!at) return;
    setFollowing(null);
    userAt.current = Date.now();
    setTookControl(true);
    setFocus((f) => ({ id: `room:${id}`, at, n: (f?.n ?? 0) + 1, ...(uid ? { highlight: uid } : {}) }));
  };
  // 카메라 조작 단추(스펙 2026-10-21-006): 사용자 조작으로 쳐서 회의 발언자 따라 옮기기를 잠시 멈춘다(회의실 행과 같다)
  const moveCamera = (kind: CameraNudge | 'reset') => {
    userAt.current = Date.now();
    setTookControl(true);
    setCameraCommand((c) => ({ kind, n: (c?.n ?? 0) + 1 }));
  };
  // 새 TFT 방을 저장하면 그 방의 회의 창을 열고 방 목록을 다시 읽는다(R14, 회의실 탭과 같은 규칙)
  const editRoom = useRoomEditor(data, (newId) => {
    void qc.invalidateQueries({ queryKey: ['office'] }).then(() => openRoomById(newId));
  });
  const speaker = standup?.currentSpeakerAgentId ?? null;
  useEffect(() => {
    if (!speaker || following || Date.now() - userAt.current < 20_000) return;
    focusOn(speaker);
    // 말하는 에이전트가 바뀔 때만 옮긴다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speaker]);
  const requestDelete = (item: FurnitureItem) => {
    const alias = deskOccupant(item, desks);
    if (alias) setDeskToDelete(alias);
    else editorApi.current?.remove();
  };
  const stopEditing = () => {
    setEditing(false);
    setEditError(null);
  };
  const saveLayout = () => {
    const items = editorApi.current?.items();
    if (!items || !layout) return;
    setSaving(true);
    setEditError(null);
    post('/api/office/layout', { version: layout.version, items })
      .then(() => {
        void qc.invalidateQueries({ queryKey: ['office-layout'] });
        stopEditing();
      })
      .catch((e: unknown) =>
        setEditError(e instanceof ApiError && e.status === 409 ? t('office.editConflict') : String((e as Error).message))
      )
      .finally(() => setSaving(false));
  };
  const banner = data.problems.length ? (
    <HudBanner text={data.problems[0].text} more={data.problems.length - 1} />
  ) : null;
  const ownerOf = serverAgents.some((a) => a.owner_name) ? (a: ServerAgent) => a.owner_name ?? '' : undefined;
  const isMine = (a: ServerAgent) => !!a.mine;
  const hint = useFirstVisit(serverAgents, focusOn);
  const twoD = (
    <Office2D agents={serverAgents} desks={desks} ownerOf={ownerOf} isMine={isMine} onSelect={select} onChat={openAgentChat} />
  );
  return (
    <Box
      ref={fill.ref}
      sx={{
        position: 'relative',
        // 화면 아래까지 채운다. 재기 전에는 옛 고정 값(useFillHeight)
        height: fill.height ?? 'calc(100vh - 230px)',
        minHeight: 420,
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        overflow: 'hidden',
      }}
      data-testid="office-stage"
    >
      {editing && layout && (
        <EditPanel
          version={layout.version}
          selected={edState.selected}
          placing={edState.placing}
          dirty={edState.dirty}
          saving={saving}
          error={editError}
          onPlace={(type) => editorApi.current?.place(type)}
          onRotate={(deg) => editorApi.current?.rotate(deg)}
          onRaise={(d) => editorApi.current?.raise(d)}
          onDelete={() => edState.selected && requestDelete(edState.selected)}
          onSave={saveLayout}
          onCancel={stopEditing}
        />
      )}
      <DeskDeleteDialog
        alias={deskToDelete}
        onClose={() => setDeskToDelete(null)}
        onConfirm={() => {
          editorApi.current?.remove();
          setDeskToDelete(null);
        }}
      />
      <Box
        aria-live="polite"
        sx={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}
      >
        {announce}
      </Box>
      <Box
        aria-live="polite"
        data-testid="room-chat-announce"
        sx={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}
      >
        {chatOpened && <span key={chatOpened.n}>{t('office.roomChatOpened', { name: chatOpened.name })}</span>}
      </Box>
      {state && (
        <OfficeHud
          ownerOf={ownerOf}
          isMine={isMine}
          agents={serverAgents}
          selected={selected}
          following={following}
          view={view}
          live={live}
          staleSeconds={Math.max(0, Math.round((now - updatedAt) / 1000))}
          banner={banner}
          onSelect={select}
          onChat={openAgentChat}
          onFocus={userFocus}
          onFollow={setFollowing}
          onView={setChosen}
          walkHint={walking ? t('office.walkHint') : undefined}
          ambient={ambient.supported ? ambient : undefined}
          slogan={hasBanners ? { on: !bannerOff, toggle: () => setBannerOff((v) => { writeBannerOff(!v); return !v; }) } : undefined}
          onEdit={data.can_edit && layout?.items && !editing ? () => setEditing(true) : undefined}
          rooms={hudRoomRows}
          meetingsReady={meetingsReady}
          meetingsFailed={meetingsFailed}
          roomsStale={roomsStale}
          openRoomId={openRoomId}
          narrow={narrow}
          onRoomFocus={focusRoom}
          onCamera={moveCamera}
          // 오른쪽 아래 카메라 조작 옆에 둔다 — 따로 띄우면 카메라 단추를 누를 때(사용자 조작) 나타나 다이얼과 겹친다(스펙 2026-10-21-006)
          onBackToMeeting={
            standup && tookControl
              ? () => {
                  userAt.current = 0;
                  setTookControl(false);
                  if (speaker) focusOn(speaker);
                }
              : undefined
          }
          onRoomChat={openRoomById}
          onRoomsTab={onRefreshRooms}
          onNewRoom={data.can_edit ? () => editRoom(null) : undefined}
        />
      )}
      {error && !state && (
        <Alert severity="error" sx={{ m: 2 }}>
          {error}
        </Alert>
      )}
      {state && !serverAgents.length && (
        <Typography
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            p: 4,
            color: 'text.secondary',
            textAlign: 'center',
          }}
        >
          {department !== ALL && allAgents.length
            ? t('office.adminDepartment.empty')
            : data.seats.length
            ? t('office.agentsPreparing')
            : t('office.noSeated')}
        </Typography>
      )}
      {hint && (
        <Box
          role="status"
          sx={{
            position: 'absolute',
            left: '50%',
            bottom: 16,
            transform: 'translateX(-50%)',
            zIndex: 3,
            px: 2,
            py: 1,
            fontSize: 13,
            color: '#f7f8f8',
            bgcolor: 'rgba(15,16,17,0.9)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '6px',
          }}
        >
          {t('office.firstVisitHint')}
        </Box>
      )}
      {view === '2d' ? (
        <Box sx={{ pt: state ? 9 : 0, height: '100%' }}>{twoD}</Box>
      ) : layout ? (
        <SceneBoundary
          fallback={(reason) => (
            <Box sx={{ height: '100%' }}>
              <Alert severity="warning" sx={{ m: 1 }}>
                {t('office.sceneFailed', { reason })}
              </Alert>
              {twoD}
            </Box>
          )}
        >
          <Suspense fallback={<SceneMessage>{t('office.sceneLoading')}</SceneMessage>}>
            <Box role="img" aria-label={t('office.sceneLabel')} sx={{ height: '100%' }}>
              <OfficeScene
                onDevice={(device) => {
                  // 장치를 AAS 기능에 잇는다(계획 007 P5). 몰입 화면은 열지 않는다
                  if (device === 'meeting') onMeeting();
                  else if (device === 'server') openDrawer({ title: t('office.deviceServer'), body: <ServerPanel /> });
                  else if (device === 'qa')
                    openDrawer({
                      title: t('office.deviceQa'),
                      body: <InboxPanel kinds={['cron_failed', 'blocked']} />,
                    });
                  else openDrawer({ title: t('office.deviceBoard'), body: <BoardPanel /> });
                }}
                onMeetingScreen={openMeetingScreen}
                onRoomLabel={editing ? undefined : openRoomLabel}
                banner={sceneBanner}
                meeting={standup}
                meetingSeats={meetingSeats}
                roomLabels={roomLabels}
                roomsInMeeting={meetingRooms}
                roomStatus={roomStatusText}
                boardCards={boardCards}
                speech={speech}
                lastSeen={lastSeen}
                agents={agents}
                furniture={layout.items}
                desks={desks}
                focusRequest={focus}
                cameraCommand={cameraCommand}
                followAgentId={following}
                onLayoutMissing={bootstrap}
                onSelectAgent={followByClick}
                onBubbleAction={(id, action) => (action === 'chat' ? openAgentChat(id) : select(id))}
                bubbleLabels={bubbleLabels}
                greetings={greetings}
                people={scenePeople}
                editor={{
                  active: editing,
                  apiRef: editorApi,
                  onChange: setEdState,
                  onDeleteRequest: requestDelete,
                }}
              />
            </Box>
          </Suspense>
        </SceneBoundary>
      ) : (
        <SceneMessage>{layoutError ? layoutError.message : t('office.sceneLoading')}</SceneMessage>
      )}
    </Box>
  );
}

/** 3D 장면을 받는 동안·배치를 읽는 동안의 안내를 장면 영역 한가운데에 보인다. 예전에는 왼쪽 위 구석(pl: 40)에 붙어 있었다. */
function SceneMessage({ children }: { children: ReactNode }) {
  return (
    <Box role="status" sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', p: 4, textAlign: 'center' }}>
      <Typography color="text.secondary">{children}</Typography>
    </Box>
  );
}

export function Office() {
  const [params, setParams] = useSearchParams();
  const { people, changeFace } = usePresence(params.get('tab') ?? 'room');
  const q = useQuery<OfficeData>({ queryKey: ['office'], queryFn: () => get<OfficeData>('/api/office') });
  const qc = useQueryClient();
  const meData = useMe().data;
  const { context, title } = officeTitle(meData); // 회사는 맥락(작은 글자), 「<부서> 오피스」는 제목(OMAI-1121 §3-5). 좌측 메뉴는 「오피스」 그대로
  const d = q.data;
  const tabParam = TABS.find(([id]) => id === params.get('tab'))?.[0] ?? 'room';
  // 관리자의 「볼 부서」(스펙 2026-10-22-002). 처음 값은 기억한 값 → 내 부서 → 전체, 고르면 이 브라우저에 기억한다(D1·D4).
  // 오피스 탭에서만 거른다 — 다른 탭의 사람 띠는 그대로다. 훅은 아래 조기 return 앞에 둔다
  const admin = isAdmin(meData);
  // 다른 사람이 바꾼 오피스 정보(방·핀·현수막·부서·자리)를 모든 탭에서 받는다(스펙 2026-10-26-001). 일반 사용자는 관리자 전용 값 변경에 다시 읽지 않는다
  useOfficeChanged(admin);
  const deptOptions = useMemo(
    () => (admin && d ? departmentOptions(d.departments ?? []) : []),
    [admin, d]
  );
  const [deptPick, setDeptPick] = useState<string | null>(null);
  const department = !admin || !d ? ALL : deptPick ?? initialDepartment(readDepartment(), meData?.department, deptOptions);
  const shownPeople = useMemo(
    () => (tabParam === 'room' ? filterPeople(people, department, d?.rooms ?? []) : people),
    [tabParam, people, department, d]
  );
  const pickDepartment = (value: string) => {
    setDeptPick(value);
    writeDepartment(value);
  };
  if (!d) return <ScreenLoading title={title} context={context} error={q.error?.message} />;
  const tab = TABS.find(([id]) => id === params.get('tab'))?.[0] ?? 'room';
  const count = (id: string) =>
    id === 'seats'
      ? d.seats.filter((s) => s.enabled).length
      : id === 'rooms'
      ? tftRooms(d.rooms).filter((r) => r.status !== 'closed').length
      : null;
  return (
    <Box>
      <PageTitle gutterBottom context={context}>
        {title}
      </PageTitle>
      {tab !== 'room' &&
        d.problems.map((p) => (
          <Alert key={p.text} severity={p.level === 'bad' ? 'error' : 'warning'} sx={{ mb: 1 }}>
            {p.text}
          </Alert>
        ))}
      <Stack direction="row" alignItems="center" sx={{ mb: 2 }}>
        <Tabs
          value={tab}
          data-guide="office.tabs"
          onChange={(_, v: string) => setParams(v === 'room' ? {} : { tab: v }, { replace: true })}
          aria-label={t('office.tabsLabel')}
          sx={{ flex: 1, minWidth: 0 }}
          variant="scrollable"
        >
          {TABS.map(([id, key]) => (
            <Tab
              key={id}
              value={id}
              label={
                count(id) == null ? (
                  t(key)
                ) : (
                  // 다른 화면의 탭(ListView)과 같은 배지(TabCountBadge)로 개수를 보인다
                  <TabCountBadge count={count(id) as number}>{t(key)}</TabCountBadge>
                )
              }
            />
          ))}
        </Tabs>
        {admin && tab === 'room' && (
          <TextField
            select
            size="small"
            label={t('office.adminDepartment.label')}
            value={department}
            onChange={(e) => pickDepartment(e.target.value)}
            sx={{ minWidth: 160, mr: 1 }}
          >
            <MenuItem value={ALL}>{t('office.adminDepartment.all')}</MenuItem>
            {deptOptions.map((o) => (
              <MenuItem key={o} value={o}>
                {o}
              </MenuItem>
            ))}
          </TextField>
        )}
        <PresenceStrip people={shownPeople} onChangeFace={(seed) => void changeFace(seed)} />
      </Stack>
      {tab === 'room' && (
        <Room3D
          data={d}
          people={shownPeople}
          department={department}
          onMeeting={() => setParams({ tab: 'meeting' }, { replace: true })}
          roomsStale={q.isRefetchError}
          onRefreshRooms={() => void qc.invalidateQueries({ queryKey: ['office'] })}
        />
      )}
      {tab === 'kanban' && <Kanban seats={d.seats} canAct={d.can_act ?? d.can_edit} mySeat={d.my_seat} />}
      {tab === 'meeting' && <Meeting rooms={d.rooms} canAct={d.can_act ?? d.can_edit} data={d} />}
      {(tab === 'seats' || tab === 'rooms') && (
        <Suspense fallback={<LinearProgress aria-label={t('common.loading')} />}>
          {tab === 'seats' ? <SeatsTab data={d} /> : <RoomsTab data={d} />}
        </Suspense>
      )}
    </Box>
  );
}
