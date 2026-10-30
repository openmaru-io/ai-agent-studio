# Claw3D 에서 가져온 것과 고친 곳

원본: https://github.com/iamlukethedev/Claw3D 커밋 `0565b78` (MIT, `LICENSE.Claw3D`)

이 폴더는 원본 3D 장면을 AAS 앞화면에 그대로 넣기 위한 사본이다. 폴더 이름은 처음에 `claw3d` 였고 2026-10-13 에 역할에 맞춰 `scene3d` 로 바꿨다(사용자 요청 — AAS 가 많이 고쳐 원본 사본이라기보다 오피스 3D 장면 코드다). 출처와 라이선스는 이 문서와 `LICENSE.Claw3D` 가 남긴다. 코드 주석의 「claw3d:」는 원본 프로젝트 식별자라 그대로 둔다. 원본 파일에는 우리 헤더 규칙(eslint `header`)과
정렬 규칙을 적용하지 않는다(`.eslintrc.cjs` 의 `ignorePatterns`, `.prettierignore`). 고친 곳은 이 문서에 적는다.

## 가져온 것 (객체는 하나도 빼지 않았다)

- `retro-office/` 전체: `core/`(상수·기본 가구·지구·기하·경로 탐색·저장), `objects/`(에이전트·가구·주방·기계·주크박스·원시 도형),
  `scene/`(환경), `systems/`(카메라·조명·이동·시각 효과), `RetroOffice3D.tsx`(장면 본체).
  원본과 파일 목록이 같다. 단 `overlays/`(전체 화면 모니터 내용)만 뺐다. `scene/RemoteOfficeLayoutPreview.tsx`(원격 오피스 미리보기)는 AAS 가 쓰지 않아 2026-10-23 에 지웠다.
- `lib/office/` 의 장면 보조 파일: `places`, `layoutSnapshot`, `janitorReset`(타입만), `deskMonitor`(타입만),
  `call/`·`text/`·`standup/`(`types`, 연출용 mock).
- `lib/avatars/profile.ts`
- `lib/office/floors.ts`·`lib/office/pathfinding.ts` 는 부르는 곳이 없어 2026-10-23 에 지웠다.
- `assets/models/*.glb` 17개(가구 전부)와 `assets/office-bg.png`(쓰지 않고 출처가 없어 2026-10-22 에 지웠다).

## 가져오지 않은 것

- Next.js 앱, 커스텀 서버, OpenClaw 게이트웨이 클라이언트와 프록시, 설정 저장.
- `lib/office/` 의 게이트웨이·서버에 묶인 파일: `eventTriggers`(행동 입력은 `lib/office/animation.ts` 가 같은 모양으로 대신한다),
  `presence`, `store`, `floorRoster`, `gatewayPresence`, `layoutSnapshotStore`, `github`, `deskDirectives`, `browserPreview`, `standup/service`·`store`.
- 전체 화면 패널·HUD·편집 도구(`RetroOffice3D.tsx` 의 캔버스 뒤 JSX 약 1,400줄): 설정 패널, ATM·GitHub·칸반·전화·문자·스탠드업·QA 화면,
  카메라 프리셋 단추, 편집 모드 패널. AAS 가 MUI 패널로 대신한다.
- 음성(ElevenLabs), 스포티파이, 원격 오피스 연결, phaser 2D 빌더.

## 고친 곳

| 파일 | 고침 | 이유 |
|---|---|---|
| 모든 파일 | `@/features/retro-office/…`→`@/features/office/scene3d/retro-office/…`, `@/lib/office/…`·`@/lib/avatars/…`→`@/features/office/scene3d/lib/…` | 폴더 위치 |
| `retro-office/RetroOffice3D.tsx` | 게이트웨이·스킬·스튜디오·작업판 import 를 `shims.ts` 의 최소 타입으로 바꿈 | 가져오지 않은 모듈 |
| 〃 | 캔버스 뒤의 HUD·전체 화면 패널 JSX 삭제 | 위 「가져오지 않은 것」 |
| 〃 | `<Environment preset="city">` 삭제, `<hemisphereLight>` 로 대신 | 환경맵(HDRI)을 외부 CDN 에서 받음 → 폐쇄망에서 깨짐 |
| 〃 | 레이아웃을 `/api/office/layout` 으로 올리는 효과 삭제 | 게이트웨이 전용 |
| 〃 | `playBoothVoice` 를 빈 함수로(음성 요청 삭제) | `/api/office/voice/reply`(외부 음성) |
| `retro-office/objects/furniture.tsx` | 모델 경로 `/office-assets/…` → `assets.ts` 의 `MODEL_URL`(Vite 가 해시 이름으로 `/assets/` 에 냄), `useGLTF(path, false)` | 정적 폴더 의존 제거, Draco 디코더를 외부(gstatic)에서 받지 않음 |
| `retro-office/objects/{agents,Jukebox,machines}.tsx`, `systems/visualSystems.tsx` | `Text` 를 `Text.tsx`(로컬 한글 글꼴 기본 지정)에서 가져옴 | 글꼴을 주지 않으면 troika 가 기본 글꼴을 외부에서 받음 |
| `lib/office/janitorReset.ts`, `deskMonitor.ts` | 타입만 남김 | 나머지는 게이트웨이 상태에 묶임 |

## 새로 만든 파일 (OPENMARU 헤더)

`assets.ts`, `Text.tsx`, `shims.ts`, `troika.d.ts`, `lib/office/animation.ts`

## 글꼴을 로컬에서만 읽는다 (에어갭 점검에서 찾은 누수)

- 원본 장면의 `<Text font={undefined}>` 3곳(`objects/agents.tsx` 2곳, `systems/visualSystems.tsx` 1곳)이 글꼴을 비워 두었다. troika 는 사용자 글꼴이 없으면 모든 글자를 대체 글꼴 저장소(`cdn.jsdelivr.net`)에서 찾는다.
- `Text.tsx` 는 `font` 를 마지막에 두어 항상 번들 글꼴(`assets/fonts/NotoSansKR-Regular-subset.woff`)을 쓰게 한다.
- 번들 글꼴에 없는 글자(이모지, `♪` 등)가 섞여도 같은 대체 요청이 나가므로, `Text.tsx` 가 그리기 전에 그 글자를 뺀다. 글자 구간은 글꼴 파일의 cmap 과 맞춰 둔다. 글꼴을 다시 만들면 이 표도 고친다.
- 확인: `node parity/offline.mjs '#/office-probe'` 에서 외부 요청 0건, 콘솔 오류 0건, 장면과 한글 이름표 표시.

## Tailwind 클래스를 인라인 스타일로 바꾼다

- AAS UI 에는 Tailwind 가 없다. 원본 `RetroOffice3D.tsx` 의 바깥 상자 두 곳(`relative w-full h-full …`, `absolute inset-0`)이 클래스 이름만 남아 높이가 0 이 되어 캔버스가 150px 로 그려졌다.
- 두 곳을 같은 뜻의 인라인 스타일로 바꿨다. 원본을 다시 가져올 때는 이 두 곳을 다시 바꾼다. `grep -rn 'className=' retro-office` 로 남은 클래스가 없는지 본다.

## 상태 말풍선을 한글로

- `objects/agents.tsx` 의 오류 상태 말풍선 글자를 `error` 에서 `오류` 로 바꿨다. 번들 글꼴(Noto Sans KR 부분집합)에 한글이 들어 있어 외부 글꼴 요청은 생기지 않는다.
- 장식용 간판(`ATM`, `GITHUB`, `QA LAB`, 주크박스의 `NOW PLAYING` 등)은 원본 영어 그대로다. 상태를 알려 주는 글자가 아니다.

## 공유 공간: 서버 레이아웃·넓힌 바닥·책상 24개 (계획 007 P−1, 2026-10-12)

- **레이아웃은 서버가 정본이다.** `RetroOffice3D` 에 `serverFurniture`·`onServerFurnitureMissing` 을 더했다. `serverFurniture` 를 주면 브라우저 저장소(`loadFurniture`·`saveFurniture`)를 쓰지 않는다. `null` 이면 서버에 판이 없다는 뜻이라 기본 배치를 만들어 콜백으로 알린다(화면이 판 1 로 올린다). 원본처럼 `undefined` 면 예전 동작이다.
- **바닥을 남쪽으로 넓혔다.** `core/district.ts` 의 `LOCAL_OFFICE_CANVAS_HEIGHT` 720 → 1080. 길(`CITY_PATH_ZONE`)과 원격 오피스 구역을 그만큼 내렸다. 서버실 아래가 열리므로 `DEFAULT_SERVER_ROOM_ITEMS` 에 아래 벽을 더했다.
- **책상 24개.** `core/furnitureDefaults.ts` 의 `AAS_EXTRA_DESK_ITEMS` 가 남쪽 구역에 책상 16개(2줄 × 8, `desk_8`~`desk_23`)를 더한다. 기존 8개와 합쳐 24개다.
- **헬스장을 뺐다.** `DEFAULT_FURNITURE` 에서 `DEFAULT_GYM_ITEMS` 를 빼고, `buildInitialFurnitureLayout` 이 `ensureOfficeGymRoom` 을 부르지 않는다. 장면 환경(`scene/environment.tsx`)의 헬스장 바닥도 `AAS_DRAW_GYM_FLOOR = false` 로 그리지 않는다. QA 실험실은 남긴다(P5 에서 QA 단말을 실패한 크론·막힌 카드에 잇는다).
- **처음 구도.** 확대 배율을 56 → 40(`core/cameraFocus.ts` 의 `OVERVIEW_ZOOM`)으로 줄여 넓힌 바닥 전체가 들어오게 했다. 2026-10-16 에 사용자가 처음 구도를 조금 더 확대해 달라고 해 46 으로 올렸다(약 15%). 부서 현수막이 있으면 `fitOverview` 가 띠 아래에 건물이 들어오도록 확대를 다시 줄이므로, 작은 화면에서는 이 값보다 작게 시작할 수 있다.
- 확인: 로컬 서버(설치본 3개, 자리 21개)에서 판 1(가구 213개)이 올라가고 책상 21개가 자동 배정되는 것을 보았다(`docs-plan/capture/office-007-p1-24desks.png`).

## 사람 아바타와 내 아바타 걷기 (계획 007 P6b, 2026-10-12)

- 원본에는 플레이어 이동 코드가 없다. 새 파일 `retro-office/objects/aasPeople.tsx`(AAS 작성)가 사람 아바타 층을 그린다. 몸은 원본 `AgentModel` 을 그대로 쓰고(회색 몸, 머리 앞면에 `avatars/face.ts` 얼굴 — 2026-10-21 부터 DiceBear Pixel Art), 경로는 원본 `astar`·`buildNavGrid` 를 쓴다.
- `RetroOffice3D` 에 `aasPeople` prop 을 더했다. 주면 캔버스 안에 사람 층을 넣는다. 처음 들어오는 곳은 `AAS_PERSON_SPAWN`(오피스 가운데, 막혀 있으면 가장 가까운 빈 칸).
- 바닥을 두 번 누르면 걷는다. 원본은 빈 바닥을 두 번 누르면 기본 구도로 돌아가는데, 걷기가 켜져 있으면 돌아가지 않게 했다(`onDoubleClick`). 가구를 두 번 누르면 그 가구로 카메라를 모으는 원본 동작은 그대로다.

## 관리자 배치 편집 (계획 007 P7, 2026-10-12)

- 원본의 편집 기능(가구 끌기·방향키 이동·`[` `]` 회전·높이·벽 그리기)은 그대로 쓰고, 지웠던 편집 패널 대신 AAS 의 MUI 패널(`features/office/EditPanel.tsx`)이 명령을 보낸다.
- `RetroOffice3D` 에 `aasEditor` prop 을 더했다. `active` 를 따라 편집 모드를 켜고 끄며(끌 때 저장하지 않은 변경은 서버 판으로 되돌린다), `apiRef` 로 놓기·돌리기·높이·지우기·현재 배치 읽기를 내준다. `onChange` 로 고른 가구·바뀜 여부·놓는 중인 종류를 알린다.
- Delete·Backspace 키는 바로 지우지 않고 `onDeleteRequest` 로 바깥에 묻는다. 에이전트가 앉은 책상이면 확인 창을 띄운다.
- 확인: 로컬 서버에서 관리자가 화분을 놓고 저장하면 판 1 → 2, 화분 15 → 16 개가 되는 것을 보았다(`docs-plan/capture/office-007-p7-edit.png`). Playwright 로 누를 때는 팔레트를 고른 뒤 장면이 다시 그려질 때까지(약 1초) 기다려야 한다 — 바로 누르면 장면 안의 바닥 클릭 처리기가 아직 예전 상태를 본다.

## 확대 한도·이름표 맞춤·이름표 고정 (계획 007, 2026-10-13)

- **따라가기 뒤 카메라가 원래대로 돌아오지 않던 문제.** `systems/cameraLighting.tsx` 의 `FollowCamController` 는 원래 카메라를 원근 카메라일 때만 기억했다. 이 장면의 기본 카메라는 직교라, 따라가기를 끄면 원근 카메라가 남았고 그 상태에서는 확대 한도(`maxZoom`)가 걸리지 않아 벽 안까지 확대됐다. 카메라 종류와 상관없이 기억하게 했다.
- **따라가기 거리·각도 한도.** 원본 거리 0.8~10(기본 2.0)·각도 최대 82° 는 가까이 붙으면 카메라가 벽·가구 안으로 들어가 화면이 한 색으로 덮였다. 거리 2.5~9(기본 4), 각도 최대 60°(`FOLLOW_RADIUS`·`FOLLOW_PHI`)로 했다.
- **일반 보기 최대 확대** 120 → 90(`RetroOffice3D` 의 `OrbitControls`).
- **이름표 글자를 상자에 맞춘다.** 원본은 글자 수로만 크기를 정해 한글(영문의 약 두 배 폭)이나 띄어쓰기 없는 긴 이름이 상자를 넘거나 여러 줄로 접혔다. `core/nameplate.ts` 의 `fitLabel` 이 글자 폭을 어림해 줄이고, 가장 작게 해도 넘치면 끝을 … 로 줄인다. 한 줄로만 그린다(`whiteSpace="nowrap"`).
- **이름표·말풍선이 걸을 때 흔들리지 않는다.** `objects/agents.tsx` 에서 이름표·부재 표시·말풍선을 한 묶음(`labelsRef`)으로 감싸고, 매 프레임 몸통 그룹의 튐(y)과 기울기(x·z)를 반대로 되돌린다.

## 사람 아바타 앉기·경로 (계획 007 P6b, 2026-10-13)

- **책상을 가로질러 앉던 문제.** 원본 `astar` 는 막힌 칸 근처의 빈 칸까지 찾은 뒤 마지막 지점을 목표 좌표로 바꾼다. 그 빈 칸이 가구 반대편이면 마지막 구간이 가구를 가로지른다. 새 파일 `core/personPath.ts` 가 자리마다 들어오는 쪽(의자는 등 뒤, 소파·빈백은 앞)의 빈 칸까지 걷고 마지막 짧은 구간만 자리로 들어가게 한다. 일어날 때는 그 칸으로 먼저 나간다. 막힌 곳을 누르면 그 옆 빈 칸에 선다.
- **벽 밖으로 나가던 문제.** 원본 격자는 장면 전체(1800×1800)를 덮어 남쪽 벽(1080) 밖이 빈 칸이었다. 사람 층은 오피스 바닥 밖을 막은 격자를 쓰고 누른 점도 바닥 안으로 당긴다(`objects/aasPeople.tsx` 의 `officeGrid`).
- **앉을 자리.** 의자(책상 앞·회의 의자), 소파(길이 45 마다 한 자리), 빈백. 자리 좌표는 실제 모델 크기로 정한다 — 가구 모델은 항목 좌표 모서리에 놓이고 항목 크기 가운데를 축으로 돌아(`buildFurnitureItemMatrix`) 항목 크기의 가운데가 눈에 보이는 가구 가운데와 다르다. 에이전트에게 배정된 책상의 의자는 뺀다.
- **책상·탁자를 누르면 그 가구의 가장 가까운 빈 의자로 간다.** 윗면이 바닥보다 높아(약 42) 누른 점이 바닥에서는 가구 뒤로 40~60 밀린다. 판정 여유 70 안에 여러 가구가 들면 누른 점에서 가장 가까운 것을 고른다.
- **걷기를 켜면 두 번 누르기로 가구에 카메라를 모으지 않는다**(`RetroOffice3D` 의 `onDoubleClick`). 앉으려고 누를 때마다 확대되었다.
- **벽 속에 끼던 문제(2026-10-13, Image #12).** ① 경로 찾기가 길을 못 찾으면 빈 목록을 돌려주는데, 그래도 마지막 「자리로 들어가는 구간」을 붙여 방 밖에서 벽을 뚫고 직선으로 걸었다. 왼쪽 위 작은 방은 문 틈(40)에서 양쪽 벽 통행 여유(15씩)를 빼면 10 이라 25 격자에서는 닫혀 있다. 이제 길이 없으면 움직이지 않는다. ② 들어오는 칸을 고를 때 벽과 그 벽에 붙은 소파가 이어서 막혀 있으면 벽 바깥 칸을 뽑았다. 이제 그 자리 가구만 뺀 격자에서 길이 비어 있어야 한다(자리 바로 앞 한 칸은 빼고 본다). ③ 소파·빈백은 모델마다 앞면 방향 규칙이 달라, 앉으면 들어온 쪽(트인 쪽)을 본다.

## 한국 사무실 배치 (계획 2026-10-13-001, OMAI-1111)

- **배치 데이터는 AAS 파일에 따로 둔다**(`core/aasKoreanOffice.ts`). 원본 `DEFAULT_FURNITURE` 는 고치지 않았다. 서버 모드의 기본 배치(`buildInitialFurnitureLayout`)는 이 배치이고, 원본의 `ensureOffice*`(ATM·부스·서버실·QA 실험실·주크박스·탁구대를 다시 넣는다)는 서버 모드에서 부르지 않는다.
- **새 가구 종류:** 칸막이(`partition`, 높이 0.45 의 상자)·유리벽(`glass_wall`, 반투명 상자)은 벽과 같은 `InstancedWallSegmentsModel` 로 그린다(`height`·`color`·`opacity` 인자를 더했다). 방 표시(`room`)와 바닥 밖 경계(`boundary`)는 그리지 않는다 — 모르는 종류는 원본이 탁자 모델로 그리므로 두 그리기 경로에서 뺐다. 상황판·회의실 TV(`tv_status`·`tv_meeting`)·게시판(`notice_board`)·사물함(`locker`)·문서함(`file_cabinet`)·러그(`rug`)·옷걸이(`coat_rack`)는 Kenney 모델(GLB)로 그린다.
- **책상 자리 좌표가 책상 방향을 따른다**(`core/navigation.ts` 의 `deskSeatOf`). 원본은 늘 `(x+40, y-5)` 라 남쪽을 보는 책상의 에이전트가 칸막이 쪽에 섰다. `resolveDeskIndexForItem` 도 같은 함수를 쓴다.
- **회의 자리를 회의실 경계로 찾는다**(`getMeetingSeatLocations(items, bounds)`). 경계를 주지 않으면 원본 영역(x 0~290·y 0~235)이다. AAS 는 회의마다 짝지어진 회의실의 자리를 계산해 `aasMeetingSeats` 로 넘기고, `useAgentTick` 의 참가자 목록과 자리 찾기가 이것을 먼저 쓴다. 원본 스탠드업(말풍선·카메라)은 첫 회의 하나만 그린다.
- **배회 지점**(`ROAM_POINTS`)을 새 배치의 통로로 바꿨다. 원본 점은 새 회의실 벽·책상 섬 위에 걸린다.
- **QA 실험실 바닥 무늬**를 그리지 않는다(`scene/environment.tsx` 의 `AAS_DRAW_QA_FLOOR`).
- **방 이름표**(`objects/aasRoomLabels.tsx`): 방 표시 가운데 벽 높이 위에 띄운다. 이름은 서버 스냅샷(`rooms`)에서 온다.
- 시험: `core/aasKoreanOffice.test.ts` — 입구에서 모든 방·책상·회의 의자에 닿는다(닫힌 방 없음), 문 폭 100, 책상 방향, 바닥 밖 막힘, 배회 지점, 서버용 `aas/office/default_layout.json` 과 같음.
- **모델을 자리 상자에 맞춰 그린다(`fit`, 2026-10-13, 판본 `kr-2`).** 원본은 가구 모델을 종류별 고정 배율로 항목 좌표 모서리에 놓는다. 책상 모델(약 61×33)은 자리 상자(100×55) 북쪽 밖에 그려져, 마주 보는 섬에서 의자가 칸막이 쪽에 놓이고 책상 사이가 벌어졌다. 탁자는 `w·h` 를 바꿔도 크기가 같아 회의실 탁자가 작았고, 소파는 남쪽 벽 너머에 걸쳐 그려졌다. 항목에 `fit: true` 가 있으면 모델 바닥 상자를 `w×h` 에 맞춰 늘리고(높이는 원래 배율) 상자 가운데를 축으로 돌린다(`objects/furniture.tsx` 의 `fitModelTransform`, 두 그리기 경로 모두). 그러면 그림·길 막기(`getItemBounds`)·앉는 자리(`deskSeatOf`, `aasPeople` 의 자리 모양)가 같은 상자를 쓴다. `fit` 이 없는 원본 배치는 그대로다.
- **책상 섬을 세로 칸막이 양쪽에 맞댄다.** 섬 하나는 가운데 세로 칸막이에 서쪽·동쪽 책상 3개씩(앉는 쪽이 바깥이라 마주 본다)과, 가로 칸막이 너머 머리의 팀장석이다. 회의실 탁자는 대회의실 200×56(10석), 팀 회의실 100×56(6석), TFT 회의실 130×64(6석)로 키웠다. 의자 가운데는 탁자에서 26 밖이다 — 탁자 통행 여유(20)와 겹치면 격자 25 에서 의자 칸이 막힌다. 팀 회의실 탁자는 동쪽에 한 칸 통로가 남도록 방 동쪽 벽에서 위치를 계산한다.
- **탕비실을 남동쪽으로, 전화 부스를 남서쪽 모서리로(판본 `kr-3`).** 탕비실(1460~1800 × 870~1080)의 상판·싱크대·정수기·냉장고는 남쪽 벽에, 자판기는 동쪽 벽에 붙인다. 탁자는 통행 여유(20)를 더한 상자가 격자(25) 선에 맞는 35×35 라 양쪽 의자로 돌아가는 길이 남는다(북쪽 벽을 900 에 두면 탁자 줄이 막혀 870 으로 올렸다). 복합기·문서함·사물함·게시판은 `fit` 으로 남쪽 벽(1080)에 붙인다. 명단 패널(`OfficeHud`)은 오른쪽 위로, 배치 편집 패널(`EditPanel`)은 겹치지 않게 왼쪽 위로 옮겼다.

## 말풍선 위 '대화'·'상세' 단추 (OMAI-1115, 2026-10-13)

- **말풍선 위 HTML 단추.** `objects/agents.tsx` 의 `AgentModel` 이 `onBubbleAction`·`bubbleLabels` 를 받으면, 말풍선이 보일 때(`activeSpeechBubble`) drei `Html` 로 단추 두 개를 띄운다. 말풍선은 WebGL 메시·troika 글자라 안에 단추를 넣을 수 없다. 누르면 AAS 가 대화 팝업('대화') 또는 서랍('상세')을 연다(`RetroOffice3D` 의 `onAgentBubbleAction`·`agentBubbleLabels` → `OfficeScene` 의 `onBubbleAction`·`bubbleLabels`).
- `Html` 의 `zIndexRange` 를 `[20, 0]` 으로 낮췄다. 기본값(약 1.6천만)이면 서랍(1200)·대화 팝업 위에 단추가 떠 버린다. 단추의 `pointerdown`·`click` 은 장면(에이전트 고르기)으로 새지 않게 막는다.
- 잘린 말풍선 안내의 영어 하드코딩('click for full chat')을 `bubbleLabels.more` 로 바꿨다(없으면 원래 문구). claw3d 는 i18n 검사 밖이라 문구를 받아 쓴다.
- **걸음걸이(2026-10-13, 사용자 요청).** 원본은 걸을 때 왼팔·왼다리를 같은 부호(`walkPhase × 0.4`, `walkPhase × 0.35`)로 흔들어 같은 쪽 팔·다리가 함께 나가는 측대보였다. 팔·다리 모두 위쪽(어깨·엉덩이)을 축으로 x 회전하므로 같은 쪽 팔과 다리는 부호가 반대여야 한다. 흔들림 각도를 `core/walkPose.ts` 의 `walkSwing` 으로 떼고 팔의 부호를 뒤집었다. 에이전트와 사람 아바타가 같은 `AgentModel` 을 쓰므로 둘 다 고쳐진다. 시험 `core/walkPose.test.ts`.
- **쉬는 에이전트가 들르는 가구 옆 지점(OMAI-1123, 2026-10-13).** 원본은 소파·정수기 옆 목표를 가구 좌표(왼쪽 위 모서리)에 ±30 을 더해 잡아 목표가 가구 안이나 옆 탁자 안에 떨어졌고, astar 가 마지막 구간을 목표로 곧장 이어 에이전트가 휴게 공간 탁자를 지나 그 안에 섰다. `core/navigation.ts` 의 `socialTargetsOf` 가 가구 상자 가장자리에서 30 바깥의 점만 주고 막힌 칸은 거른다(`isNavFree`). 소파 목표는 `awayTargetOf` 로 옮겼다(계산은 원본과 같다). 시험 `core/navCollision.test.ts`.
- **안경을 그리지 않는다(2026-10-13, 사용자 요청).** 원본 `AgentModel` 은 외모의 `accessories.glasses` 가 참이면 눈 위에 테를 그린다. 그리는 부분만 뺐다(외모 값과 `lib/avatars/profile.ts` 는 그대로). 에이전트와 사람 아바타 모두 같은 모델이라 둘 다 사라진다.

## 회의실 빔 스크린 클릭 (OMAI-1257, 2026-10-16)

- `RetroOffice3D` 에 `onMeetingScreenSelect?: (screenUid) => void` 를 더했다. `handleDeskClick` 이 `tv_meeting` 을 눌렀을 때 이 콜백이 있으면 스크린 항목 uid 를 알리고 끝낸다(없으면 원본처럼 아무 일도 없다). `AasDevice`·`overlayOnly` 는 그대로다. 방 찾기와 창은 장면 밖(`features/office/meetings.ts`·`components/RoomChatPopup.tsx`)에서 한다. 스펙 `office/room-chat-overlay.md`.

## 이름표·방 명패 디자인과 명패 클릭 (사용자 요청 2026-10-16)

- **둥근 판.** 새 `objects/RoundedPlate.tsx`(`roundedRectShape`, THREE `ShapeGeometry`)가 모서리가 둥근 판과 그 뒤의 가는 윤곽선을 그린다. 평평한 직사각형 `planeGeometry` 이던 에이전트·사람 머리 위 이름표(`objects/agents.tsx`)와 방 명패(`objects/aasRoomLabels.tsx`)의 바탕을 이것으로 바꿨다.
- **머리 위 이름표.** 판 0.82×(0.24|0.34), 반지름 0.06|0.075. 왼쪽 색 막대는 판 전체 높이가 아니라 안쪽의 짧은 막대, 상태 점은 반지름 0.052→0.038(`statusDotMatRef` 는 그대로), 이름 글자색 `#e8dfc0`→`#f7f8f8`, 둘째 줄 `#8ab4ff`→`#9aa0aa`. 에이전트와 사람이 같은 `AgentModel` 이라 둘 다 바뀐다.
- **방 명패.** 판 1.5×0.27, 반지름 0.07. `onSelect` 가 있으면 오른쪽에 ›, 올리면 판·윤곽선이 밝아지고 커서가 손가락이 된다. 누르면 그 방 표시 항목 uid 를 알린다: `RetroOffice3D` 의 `onRoomLabelSelect` → `AasRoomLabels.onSelect`. 주지 않으면 누를 수 없다(배치 편집 중에는 `Office.tsx` 가 주지 않는다).
- **회의 중 표시(사용자 요청 2026-10-16).** `AasRoomLabels` 가 `inMeeting?: Set<string>`(회의 중인 방 표시 uid)을 받아 명패 글자 앞에 표시를 단다. 회의 중이면 초록 점(`#4ade80`)과 2.4초 주기로 퍼졌다 사라지는 고리(`useFrame`, 고리 크기·불투명도만 바꾼다)와 밝은 글자, 비어 있으면 속 빈 회색 고리와 흐린 글자. `RetroOffice3D` 의 `aasRoomsInMeeting` 로 들어온다. 움직임은 이 점 하나뿐이다.
- **누르기는 pointerdown/pointerup 쌍으로 판정한다.** R3F `onClick` 은 이 장면에서 오지 않았다(OrbitControls 가 포인터를 붙잡는 것으로 보이며 원인은 더 파지 않았다). 누른 자리와 뗀 자리가 5px 안이면 선택으로 보고, 끌어서 돌린 것은 제외한다. `onPointerOut` 에서 누른 자리를 지우면 포인터 포획 때 지워져 선택이 안 된다 — 지우지 않는다. 뒤에 겹친 명패에 같이 가지 않게 두 이벤트 모두 `stopPropagation` 한다.

## 이름표 위·아래 클릭 뒤집기, 의자가 길을 막는다 (사용자 요청 2026-10-16)

- **이름표 클릭(OMAI-1259 를 뒤집음).** `core/nameplate.ts` 의 `nameplateZones(hasSubtitle, actionable)` 가 눌러 쓸 수 있는(`onBubbleAction` 이 있는) 이름표를 부제 유무와 상관없이 위(`top`)·아래(`bottom`) 반씩 나눈다. 위 = `onBubbleAction(id, "chat")`(대화 창), 아래 = `"detail"`(상세 서랍). 둘 다 `stopPropagation` 해서 몸 클릭(따라가기)으로 올라가지 않는다. 올린 구역 바깥에 「대화」/「상세」 글자를 띄운다. 예전에는 아래 줄(부제)=대화, 위 줄(이름)=몸 클릭과 같음(카메라 이동 + 서랍)이었다.
- **의자가 길을 막는다.** `core/geometry.ts` 의 `ITEM_METADATA.chair` 를 `blocksNavigation: false` 에서 `{ blocksNavigation: true, navPadding: 0, softBlock: true }` 로 바꿨다. 원본은 앉는 가구라 통과시켰지만 우리 배치는 팀장 의자가 팀장 책상 북쪽 통로에 놓여(`aasKoreanOffice.ts` `island` → `deskSet(..., lead=true)`) 캐릭터가 의자를 뚫고 다녔다. 책상 자리·배회 지점 사이 경로 기준 의자 96개 중 27개를 지났다(팀장 의자 포함).
- **`core/navigation.ts`.** `buildNavGrid` 는 의자 칸을 `CELL_SEAT`(2)로 표시하고(다른 가구가 이미 막은 칸은 그대로 `CELL_BLOCKED`), 의자 상자를 `SEAT_RECTS`(WeakMap)에 적어 둔다. `astar` 는 출발점·목표가 의자 상자에서 `SEAT_REACH`(6) 안이면 그 의자 칸만 비용 없이 열고, 다른 의자 칸은 지날 수 있되 칸마다 `SEAT_COST`(60)를 더해 거의 돌아간다. 완전히 막지 않은 까닭: 회의실 윗줄(`kr_5`~)은 벽과 탁자 사이 한 칸 폭 통로에 의자가 빈틈없이 붙어 있어 가운데 자리는 이웃 의자를 지나야만 닿는다(막으면 `astar` 가 빈 경로를 돌려 닿지 못한다). 회의 자리 점은 의자 가운데에서 14 바깥이라 상자(반 12) 2 바깥에 놓여 `SEAT_REACH` 가 필요하다. `isNavFree` 는 의자 칸을 빈 칸으로 보지 않는다.
- **말풍선 모양(2026-10-16):** `objects/agents.tsx` 의 말풍선(바탕·윤곽 직사각형 두 장과 돌린 마름모 꼬리)을 `objects/RoundedPlate.tsx` 의 `SpeechBubbleShape`(둥근 판·윤곽선·둥근 끝 꼬리)로 바꿨다. 자리 비움 풍선도 `RoundedPlate` 로 바꿨다. 글자·위치·표시 조건은 그대로다.
- **로딩 때 두 번 깜빡임(2026-10-19, 스펙 2026-10-19-009):** `retro-office/RetroOffice3D.tsx` 의 `AasPeopleLayer` 를 `<Suspense fallback={null}>` 로 감쌌다. 이 층은 `useGLTF` 로 가구 GLB 를 기다리는데, `<Canvas>` 안쪽 Suspense 가 없으면 멈춤이 오피스 화면의 바깥 Suspense 까지 올라가 장면 전체를 대기 문구로 가렸다. 같은 이유로 `Text.tsx` 는 drei `<Text>`(글꼴을 받는 동안 suspend)를 쓰지 않고 troika 메시를 직접 그린다.

## 이름표·방 명패를 작고 옅게 (사용자 요청 2026-10-20, 스펙 2026-10-20-003)

- **판 폭은 글자에 맞추고 글자 크기는 고정한다.** `core/nameplate.ts` 의 `nameplateLayout(name, subtitle)` 이 머리 위 이름표의 판 크기(폭 0.30~0.72, 높이 0.24|0.16)와 글자·막대·상태 점 자리를 정한다. 이름 0.095(넘칠 때만 0.06 까지), 부제 0.058, 글자는 막대 옆 왼쪽 정렬. 예전에는 판 0.82×(0.34|0.24) 고정이라 짧은 이름일수록 글자가 컸다. 방 명패는 `roomLabelLayout(text, interactive)`(폭 0.70~1.40, 높이 0.20, 글자 0.12, 예전 1.5×0.27·0.16).
- **판 색.** 이름표와 방 명패만 `LABEL_PLATE_COLOR`(`#1b1f26`)·`LABEL_PLATE_OPACITY`(0.62)를 넘긴다. `RoundedPlate` 기본값(`#0f1114`·0.88)은 그대로라 자리 비움·말풍선 판은 바뀌지 않는다. 판이 옅어져 부제·빈 방 글자색을 `#c3c8d0` 으로 밝혔다.
- **부제는 필요할 때만.** `AgentModelProps.subtitlePinned`(따라가는 에이전트 `RetroOffice3D`, 「나」 `aasPeople`)이거나, 몸통·이름표 구역에 마우스를 올렸거나, `status` 가 `working`·`error` 일 때만 두 줄로 펼친다. `useFrame` 의 `working` 은 앉아 있기만 해도 참이라 쓰지 않는다.
- **클릭 구역.** `nameplateZones(width, height, actionable)` 로 바꿨다(판 폭이 이름마다 다르다). `NAMEPLATE_WIDTH` 상수는 없앴다.
- **상태 점.** 반지름 0.038 → 0.028. 대기 상태는 채운 점 대신 속 빈 고리(`statusRingRef`, `STATUS_COLOR.idle`).

## 말풍선을 작게, 누가 말하는지 보이게 (사용자 요청 2026-10-20, 스펙 2026-10-20-004)

- **크기·자리는 `core/speechBubble.ts` 의 `speechBubbleLayout(text, name)`.** 폭 0.9~2.2(예전 1.8~4.6), 본문 0.105 고정(예전 0.188~0.216), 줄 간격 1.4, 최대 5줄. 넘치면 5줄 폭에 들어가는 만큼만 남기고 … 와 잘림 안내를 둔다(예전에는 180자를 그대로 그려 판 밖으로 넘쳤다). 꼬리 끝을 이름표 자리(0.98)에 두고 위로 자란다(예전 가운데 1.45 고정).
- **판.** `useFrame` 의 바탕색을 상태색(작업 중 `#1d2a17`, 대기 `#1a2030`)에서 이름표 판색(`LABEL_PLATE_COLOR`)으로, 대화 말풍선 0.9·「…」 0.62. 오류만 `#3a1016`. 테두리는 상태색 0.03 → 흰색 0.14·0.012.
- **머리 줄.** 말풍선이 뜨면 이름표가 숨으므로 말풍선 위쪽에 색 막대·이름·상태 점(`bubbleDotMatRef`, 대기는 속 빈 고리 `bubbleRingRef`)을 둔다.
- **꼬리.** `objects/RoundedPlate.tsx` 의 `TAIL_W`·`TAIL_H` 를 `SPEECH_TAIL`(0.12 × 0.08)로, 자리를 판 폭 −18% → 가운데로.
- **「…」·「오류」 풍선.** 0.36 × 0.2·글자 0.13 → 글자에 맞춘 폭 × 0.1·글자 0.075, 이름표 바로 위. 크기가 사인 곡선으로 커졌다 작아지던 것을 없앴다.
- **「대화」·「상세」 HTML 단추.** 새 `objects/BubbleActions.tsx` 의 한 묶음 단추(아이콘 `ChatBubbleOutline`·`InfoOutlined` + 글자 11px, 가운데 구분선, 마우스 올림·`FOCUS_RING` 포커스)로 바꿔 말풍선 오른쪽 위 모서리 바로 위에 붙였다(스펙 §6). 예전에는 따로 떨어진 두 알약(12px, 인라인 스타일)이 가운데 위에 떠 있었다.

## 벽 아래 걸레받이 깜빡임 (사용자 요청 2026-10-20, 스펙 2026-10-20-006)

- **원인.** `scene/environment.tsx` 의 바깥벽 걸레받이(벽 중심 + 0.04, 두께 0.04)는 앞면이 벽 안쪽 면(벽 중심 + 0.06)과 같은 평면이라 카메라를 움직일 때 z-fighting 으로 깜빡였다. 색 `#0c0c10` 이라 벽과 바닥 사이 틈처럼 보였다. `objects/primitives.tsx` 의 벽 모델(배치 편집) 걸레받이도 두께가 벽과 같아(`max(depth, 0.06)`) 앞뒤 면이 겹쳤다.
- **변경.** 새 `core/baseboard.ts` 의 `baseboardOffset`(벽 면보다 0.02 앞, 뒤 0.02 는 벽 안)·`wallBaseboardDepth`(벽보다 양쪽 0.02 두껍게)를 쓴다. 바깥벽 걸레받이 색은 `#4e342e`.

## 이름표 호버 묶음 단추, 캐릭터 배율 (사용자 요청 2026-10-20, 스펙 2026-10-20-007)

- **이름표 호버.** `objects/agents.tsx` 의 이름표 위·아래 호버 안내(각진 WebGL 사각형 `#1a2030` 에 글자)를 `objects/BubbleActions.tsx` 묶음 단추(HTML)로 바꿨다. 이름표 오른쪽 위에 붙고, 올린 쪽 칸을 `active` 로 밝힌다(바탕 16%, 다른 칸 글자 흐리게). 단추도 누를 수 있고, 이름표·단추에서 마우스가 나가면 150ms 뒤에 닫는다(`hintOpen`).
- **캐릭터 배율.** `core/constants.ts` 의 `AGENT_SCALE` 1.75 → 1.5. 새 `AGENT_LABEL_SCALE`(1.75)와 `core/labelAnchor.ts` 의 `labelAnchor()` 로 이름표 묶음(`labelsRef`)에 `1.75 / 1.5` 배율을 걸고 높이를 `HEAD_TOP × (1 − 배율)` 만큼 내려, 이름표·말풍선 크기와 머리 위 간격을 그대로 둔다.

## 회의실 팻말 안내판 (사용자 요청 2026-10-20, 스펙 2026-10-20-008)

- `objects/aasRoomLabels.tsx`: 모서리 0.055 → 0.03(사람 이름표 알약과 구분), 왼쪽 「○」/초록 점 대신 문 아이콘(`DoorIcon`, 평면 네 개 + 손잡이 원, 회의 중이면 `#4ade80`), 회의 중이면 둘째 줄 「● 회의 중」(점 둘레 고리만 2.4초마다 퍼짐), 「›」 는 마우스를 올렸을 때만. 크기·자리는 `core/nameplate.ts` 의 `roomLabelLayout(text, interactive, inMeeting)`(글자 0.14, 높이 0.22/0.33).
- 「회의 중」 문구는 `bubbleLabels.meeting`(번역 `office.roomInMeeting`)으로 받아 `AasRoomLabels.meetingLabel` 로 넘긴다(`Office.tsx` → `OfficeScene` → `RetroOffice3D`).

## 따라가기 화면 가득 확대 (사용자 보고 2026-10-20, 스펙 2026-10-20-009)

- `systems/cameraLighting.tsx` 의 `CameraAnimator` 는 확대를 적용할 카메라로 한 번 본 원근 카메라(`activePerspectiveCameraRef`)를 계속 골라, 직교 화면에서 건 프리셋 확대가 숨은 따라가기용 원근 카메라에 들어갔다. 그 ref 를 없애고 `core/cameraFocus.ts` 의 `presetZoomCamera`(지금 카메라가 직교일 때만)를 쓴다. 지금 카메라가 원근(따라가기 중)이면 프리셋을 버린다. `FollowCamController` 는 따라가기를 켤 때 원근 카메라 zoom 을 1 로 되돌린다.

## 앉은 자세 (사용자 보고 2026-10-20, 스펙 2026-10-20-010)

- `objects/agents.tsx`: 원본은 앉으면 몸만 뒤로 0.15 기울이고 팔을 뒤로 0.3 돌렸으며 다리는 편 채였다. `core/sittingPose.ts` 의 `sittingPose(AGENT_SCALE)` 로 다리를 앞으로 눕히고(−90°, 다리 그룹 자리 y 0.14·z 0.035), 허벅지 아랫면이 좌석 윗면 0.29(잰 값: 의자 0.297, 소파 0.28)에 닿게 몸 그룹을 들어 올리고, 몸통을 세우고(0), 팔을 앞으로(−0.9) 든다. 바닥 그림자(`shadowRef`)·상태 고리는 몸 그룹 높이를 되돌려 바닥에 남긴다.

## 누른 자리에 앉기 (사용자 보고 2026-10-20, 스펙 2026-10-20-011)

- `objects/aasPeople.tsx`(AAS 작성): 두 번 누른 곳을 바닥 점 하나로만 보아, 의자·소파를 누르면 점이 옆 책상·탁자 쪽으로 밀려 다른 빈 자리(팀장석)로 갔다. 광선을 앉는 가구 윗면(`useSeatTop`)부터 바닥까지 12 토막으로 나눠 `people.ts` 의 `seatOnRay` 로 먼저 지나간 자리를 고른다. 지나간 자리가 없을 때만 원래대로 `pickTarget` 을 쓴다.

## 사람 아바타가 문 열기 (사용자 보고 2026-10-20, 스펙 2026-10-20-014)

- `objects/primitives.tsx` 의 `DoorModel` 은 원본대로 에이전트 목록(`renderAgentsRef`)만 보고 열려, 바닥을 두 번 눌러 걷는 사람 아바타(`AasPeopleLayer`)가 지나가도 닫혀 있었다. 판정을 `core/doorTouch.ts` 의 `doorTouched(item, ...lists)`(원본 식 그대로, 목록 여러 개)로 꺼내고 `peopleRef` 를 더 받는다. `RetroOffice3D` 가 `aasPeopleRef` 를 만들어 `AasPeopleLayer`(`actorsRef`)와 문에 함께 넘긴다.

## 에이전트 의자에 앉기·캐릭터 피해 걷기 (사용자 보고 2026-10-20, 스펙 2026-10-20-011 §6·2026-10-20-015)

- `RetroOffice3D` 가 사람 층에 책상 배정(`desks`) 대신 장면 에이전트 목록(`sceneAgentsRef`=`renderAgentsRef`)을 넘긴다. 사람은 비어 있는 에이전트 의자에도 앉고, 그 에이전트가 앉으러 오면 일어나 비킨다(`people.ts` 의 `agentSeats`).
- 원본의 에이전트 부딪힘 처리(`applyAgentCollisionBumps`)는 에이전트만 본다. 사람 층(`objects/aasPeople.tsx`)은 걷는 동안 앞길의 에이전트·다른 사람을 살펴 둘레를 막은 격자로 돌아간다(`core/personPath.ts` 의 `detour`·`gridAround`, AAS 작성).

## 장면 색을 세련된 사무실 색으로, 다크·라이트 테마별로 (사용자 요청 2026-10-20, 스펙 2026-10-20-012)

- 색은 `features/office/tokens.ts` 의 `SCENE_PALETTE`(dark·light)에 모았다. Canvas 안은 `features/office/scenePaletteContext.ts` 의 `useScenePalette()` 로 읽는다. `RetroOffice3D` 는 `aasTheme` 속성을 받아 Canvas 안쪽에 Provider 를 둔다. 테마는 Canvas `key` 에 넣지 않는다(카메라·아바타가 처음으로 돌아간다).
- `objects/furniture.tsx`: 원본 `FURNITURE_TINT` 표를 없애고 `furnitureTints(palette)` 를 쓴다. 색은 재질 이름별로 줄 수 있다(잎·화분, 소파 천·다리, 책상 상판·다리). 원본은 원래 색에 80% 만 섞어 의자 천(빨강)·깔개(분홍)가 붉게 남아, 표의 색을 그대로 넣는다. 템플릿 캐시 열쇠에 테마를 넣고, 두 테마 템플릿을 함께 만든다.
- 선택·호버 강조: 원본은 재질 emissive(`#fbbf24`·`#4a90d9`·`#69f0da`)로 칠했다. emissive 는 더하기만 해 라이트의 어두운 선택색이 보이지 않아, `objects/primitives.tsx` 의 `SelectionOutline`(상자 외곽선, 깊이 검사 끔·톤매핑 끔)으로 바꿨다. 코드로 그리는 장치(`machines.tsx`·`Jukebox.tsx`·`kitchen.tsx`·책상 소품)는 `ItemSelectionOutlines` 가 그린다.
- `scene/environment.tsx`: 바닥·줄눈·외벽(발광 0.4 없앰)·걸레받이가 테마 색. 벽 그림은 원본 색을 휘도가 가까운 차분한 다섯 색 + 바탕색으로 바꾼다(`artTone`). `core/baseboard.ts` 의 `BASEBOARD.color` 는 없앴다.
- 조명: 환경광·반구광은 테마별, 보조 방향광 `#7090ff` → 중성 `#d8dce2`·0.3, 아바타 스포트라이트 `#ffe8a0` → 흰빛.
- `objects/agents.tsx`·`objects/aasRoomLabels.tsx`: 이름표·말풍선·방 명패 판·글자·회의 초록이 테마 색(라이트는 밝은 판 `#f5f6f9` 에 먹색 글자). `core/nameplate.ts` 의 `LABEL_PLATE_COLOR`·`LABEL_PLATE_OPACITY` 는 없앴다. 바닥 상태 고리는 불투명도 0.85 와 테두리(`#0f1011`·0.6 / `#ffffff`·0.8)를 둔다.
- `objects/machines.tsx`·`objects/Jukebox.tsx`(지금 배치에 없음): 몸체 색을 휘도로 고른 역할 색(`props.dark·body·metal·light`)으로 바꿨다. 화면·표시등 발광은 남겼다.
- 시험: `scenePalette.test.ts`(C1~C11), `core/furnitureMaterials.test.ts`(GLB 재질 이름), `core/colorLiterals.test.ts`(파일별 색 문자열 상한), `ui/parity/palette.mjs`(화면 픽셀로 외벽·바닥 대비, 오류 고리, 선택 외곽선, 테마 전환 뒤 카메라).

## 점으로 카메라 옮기기 (사용자 요청 2026-10-20, 스펙 2026-10-20-021 R12)

- `RetroOffice3D.tsx` 의 `focusRequest` 에 `at?: { x, y }`(배치 좌표)를 더했다. 있으면 에이전트를 찾지 않고, 가구를 두 번 누를 때와 같은 `focusPreset`(각도 유지·초점 배율)으로 그 점에 카메라를 옮긴다. 처음에는 `orbitRef.target` 만 바꿨는데 카메라 자리가 그대로라 먼 방은 비스듬히 내려다보고 화면 가운데에 오지 않았다(가짜 서버 화면 확인). 오피스 상태판 「회의실」 탭의 행이 회의실 가운데로 카메라를 옮길 때 쓴다. 따라가기 중이면 매 프레임 목표를 덮어쓰므로 부르는 쪽(Office.tsx)이 먼저 따라가기를 끈다(N6).

## 명단에서 에이전트로 확대해 옮기기 (사용자 요청 2026-10-21, 스펙 2026-10-21-004)

- `focusRequest` 에 `zoom?: boolean` 을 더했다. `zoom` 이 참이면 에이전트 자리로 `at` 과 같은 `focusPreset`(각도 유지·초점 배율)을 쓴다. 상태판 명단 행·방향키가 보낸다. 거짓이면(첫 방문 안내·회의 발언자) 예전처럼 `orbitRef.target` 만 옮긴다.
- 상태판 요청의 확대 배율을 가구 두 번 누르기(`FOCUS_ZOOM` 85)와 나눴다: 에이전트(`zoom`) 115(`AGENT_FOCUS_ZOOM`), 회의실(`at`) 105(`ROOM_FOCUS_ZOOM`). 더 가까이 보고 싶다는 요청(2026-10-21). 회의실은 방 전체가 한 화면에 들어오게 덜 확대한다.

## 카메라 조작 단추 (사용자 요청 2026-10-21, 스펙 2026-10-21-006)

- `RetroOffice3D.tsx` 에 `cameraCommand?: { kind, n }` 를 더했다. 상태판 오른쪽 아래 카메라 조작(이동·확대·돌리기·처음 구도)이 보낸다. 계산은 `core/cameraFocus.ts` 의 `nudgePreset` 이 하고, 결과를 `cameraPresetRef` 에 넣어 기존 프리셋 애니메이터로 부드럽게 옮긴다. 진행 중인 프리셋이 있으면 그 끝을 기준으로 계산한다(빠르게 여러 번 누를 때 누른 만큼 움직이게). 「처음 구도」는 `overviewPresetRef`(처음 구도를 정하는 effect 에서 같이 넣는다)를 쓴다. `officeCenterSignal` 은 캔버스를 다시 만드는 키라 쓰지 않았다.
- 최대 확대(`OrbitControls maxZoom`)를 120 → 240 으로 올리고 `core/cameraFocus.ts` 의 `MIN_ZOOM`·`MAX_ZOOM` 으로 카메라 조작 단추와 같이 쓴다(사용자 요청 2026-10-21). 직교 카메라라 확대해도 벽 안으로 들어가지 않는다.

## 의자 없는 곳에서 앉지 않기 (사용자 보고 2026-10-21, 스펙 2026-10-21-010)

- `RetroOffice3D.tsx` 이동 틱의 길 끝 처리: 일하는 중인 에이전트를 목표와 상관없이 앉히던 마지막 `"sitting"` 을 `core/seatArrival.ts` 의 `arrivedState` 로 바꿨다. 책상·회의 자리에 실제로 닿았을 때만 앉는다. 빈 길(자리 미배정, 길을 찾지 못함)도 「닿음」으로 처리돼 복도에서 허공에 앉았다.

## 「...」 대신 인사·혼잣말 (사용자 요청 2026-10-21, 스펙 2026-10-21-021, OMAI-1429)

- `systems/NavigationSystem.tsx` `applyAgentCollisionBumps` 가 부딪힌 상대 가운데 가장 가까운 에이전트를 인사 짝으로 정한다(`greetPartner`). id 가 작은 쪽이 먼저 말하고 다른 쪽은 0.7초 뒤 답하며, 둘 다 2.4초 서서 서로 바라본다. 앉아 있거나 운동·춤 중인 짝은 답만 한다. 인사 기록은 `createGreetMemory()`(`useAgentTick` 의 ref)에 두고, 문구 고르기는 `features/office/greetings.ts` 가 한다. `greetings` 인자가 없으면 원본처럼 1.5초만 멈춘다.
- `core/types.ts` 의 `bumpTalkUntil` 을 지우고 `greetText`·`greetFrom`·`greetUntil` 을 더했다. 원본은 부딪힘 동안 「...」를 보였다.
- `objects/agents.tsx`: 혼자 서 있을 때 프레임 320개 중 42개 동안 보이던 「...」를 `mutterAt`(18~26초마다 2.5초)의 혼잣말로 바꿨다. 인사·혼잣말 알약은 최대 폭 1.4(원본 「...」 알약은 0.6). 우선순위는 실제 대화 > 오류 > 인사 > 혼잣말. 글이 바뀐 순간에만 `setState` 한다.
- `RetroOffice3D.tsx` 에 `aasGreetings`(번역한 문구)를 더해 이동 틱과 `AgentModel` 의 `mutterLines` 로 넘긴다. 문구는 i18n 사전 `office.greet.*`·`office.mutter.*` 에 있다.
