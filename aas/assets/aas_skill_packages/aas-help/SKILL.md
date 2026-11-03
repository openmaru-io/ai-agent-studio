---
name: aas-help
description: "CogentAI AAS 화면 사용법(메뉴·하고 싶은 일별 단계). AAS 화면에서 무엇을 어디서 하는지 물으면 쓴다. / How to use the CogentAI AAS screens; use when asked where or how to do something in AAS."
version: 1.0.6
author: OPENMARU, Inc.
---

<!-- 자동 생성: cogentai-aas/ui/src/lib/helpSkill.ts (npm run help-skill). 손으로 고치지 않는다. -->
## CogentAI AAS 사용법 (한국어)

사용자가 AAS 화면에서 무엇을 어디서 하는지 물으면 아래 내용으로 답한다. 화면 이름과 탭 이름은 화면에 보이는 그대로 쓴다. 여기에 없는 관리자 일(사용자·부서·모델 관리 등)은 관리자에게 요청하라고 안내한다.

화면 맨 위(상단 막대 위) 띠는 관리자가 기간·종류·대상(전체 또는 부서)을 정해 「관리 › 공지」에서 올린 공지다. 점검·장애 공지는 끝 시각을 함께 보인다. 닫은 공지는 계정 메뉴의 「지금 공지」에서 다시 띠에 보이게 할 수 있다. 공지를 올리거나 고치는 일은 관리자에게 요청하라고 안내한다.

### 메뉴 구조

- 대시보드
  - 대시보드: AI 에이전트 작업공간 현황과 조치가 필요한 항목을 한 화면에 모아 봅니다
- 대화
  - 채팅: AI 에이전트를 골라 바로 대화합니다
  - 오피스: 여러 AI 에이전트와 사람이 한 방에서 함께 일합니다
- 내 AI 에이전트
  - 프로파일: 프로파일의 성격·모델·스킬·도구·예약 작업을 한곳에서 고칩니다
  - AI 에이전트 작업공간: 내 AI 에이전트 작업공간을 만들고 상태와 개수 한도를 봅니다
  - 모델: 프로파일이 쓰는 AI 모델(LiteLLM)
- 스킬
  - 스킬 목록: AI 에이전트가 가진 스킬을 찾아봅니다
  - 스킬 허브: 스킬 묶음을 골라 프로파일에 설치합니다
  - 스킬 연결도: 스킬이 어디서 불리고 무엇을 부르는지 그림으로 봅니다
- 자동화
  - 예약 작업: 정해진 시간에 AI 에이전트가 하는 일(Cron) — 실패하거나 멈춘 작업, 알림 대상이 없는 작업
  - 메신저 연결: 텔레그램·슬랙 같은 메신저로 AI 에이전트와 이야기하는 길(채널·게이트웨이)
- 기록
  - 사용량: 대화 세션과 토큰 사용량
- 설정
  - 내 화면: 언어·표의 행 수·날짜 시간대·테마 — 이 브라우저에만 저장
  - API 키·토큰: AI 에이전트가 LLM·MCP·REST·WebSocket 에 접속할 때 쓰는 키와 토큰이 어디에 있는지 봅니다
  - Claude Code 연결: 내 PC 의 Claude Code 가 AAS 를 거쳐 내 AI 에이전트를 다루는 연결과 토큰
  - 회사 정보: 회사 이름과 AI 에이전트 소개 문장

### 하고 싶은 일별 안내

#### AI 에이전트와 첫 대화하기

채팅 화면에서 내 AI 에이전트에게 질문합니다.

AI 에이전트는 내 일을 돕는 AI 비서입니다. 채팅 화면에서 질문하거나 일을 맡기면 AI 에이전트가 답하고, 연결된 도구와 스킬로 자료를 찾거나 일을 처리합니다. AI 에이전트의 설정(성격·스킬·도구 등)은 「프로파일」 화면에 모여 있고, 이 설정 묶음을 프로파일이라고 부릅니다.

언제 쓰나: AAS 를 처음 쓸 때, 업무 중에 궁금한 것을 묻거나 글 정리·요약 같은 일을 맡기고 싶을 때 씁니다.

단계:

1. 채팅 화면 열기 — 왼쪽 메뉴의 「대화 › 채팅」 화면입니다. 왼쪽에 대화할 수 있는 AI 에이전트 목록이 있습니다.
2. AI 에이전트 고르기 — 목록에서 대화할 AI 에이전트를 누릅니다. 새로 가입한 사용자는 처음에 주 프로파일 하나만 보입니다.
3. 질문 보내기 — 아래 입력칸에 질문을 적고 Enter 를 누릅니다. 입력칸 맨 앞에 / 를 치면 이 AI 에이전트의 스킬 목록이 뜨고, 선택한 스킬을 따라 일하게 할 수 있습니다. 가이드를 마친 뒤에는 다른 화면에서도 오른쪽 아래 캐릭터 버튼을 눌러 같은 대화창을 열 수 있습니다.

#### 문서 파일을 올려 요약·정리 시키기

채팅에 파일을 붙여 보내면 AI 에이전트가 내용을 읽고 요약하거나 정리해 줍니다.

채팅 입력칸에 문서나 사진 파일을 붙여 보낼 수 있습니다. AI 에이전트는 Word·Excel·PowerPoint·PDF·한글(HWP) 문서를 읽습니다. 스캔한 문서와 사진 속 글자도 읽습니다. 요약, 표 뽑기, 번역 같은 일을 맡길 수 있고, 파일은 100MB 까지 올릴 수 있습니다.

언제 쓰나: 긴 보고서를 짧게 요약하고 싶을 때, 문서에서 표만 뽑고 싶을 때, 사진 속 글자를 문서로 옮기고 싶을 때 씁니다.

단계:

1. 입력칸에 파일 붙이기 — 입력칸 옆의 「파일 첨부」 단추를 눌러 파일을 고릅니다. 올리는 동안은 보낼 수 없고, 끝나면 입력칸 위에 파일 이름이 나타납니다. 잘못 붙인 파일은 이름 옆의 빼기 단추로 뺍니다. 뺀 파일도 「파일」에는 남습니다.
2. 하고 싶은 일 적어 보내기 — 입력칸에 「이 보고서를 열 줄로 요약해 줘」처럼 원하는 일을 적고 Enter 를 누릅니다. 문서의 어느 부분을 볼지, 어떤 모양으로 받고 싶은지 함께 적으면 결과가 더 잘 맞습니다.
3. 결과 확인하고 받기 — AI 에이전트가 파일을 만들면 답 아래에 파일 이름이 나타납니다. 이름을 누르면 화면에서 바로 열어 봅니다. 내 컴퓨터에 저장하려면 채팅 화면 위쪽의 「파일」 단추을 열어 그 파일 줄의 「받기」를 누릅니다.

#### 문서 뷰어로 파일 열어 보기

내려받지 않고 화면 안에서 PDF·Word·Excel·PowerPoint·한글 문서와 그림을 봅니다.

문서 뷰어는 채팅과 회의의 파일을 내 컴퓨터에 저장하지 않고 화면 안에서 열어 주는 창입니다. PDF, Word(docx), Excel(xlsx), PowerPoint(pptx), 한글(hwp·hwpx) 문서를 쪽 모양에 가깝게 보여 줍니다. 그림, 동영상, 소리, 표(csv), 마크다운, 글 파일도 열립니다. 문서는 내 브라우저 안에서만 열리고 바깥으로 보내지 않습니다.

언제 쓰나: AI 에이전트가 만든 보고서를 내려받기 전에 확인할 때, 올린 문서의 한 부분을 찾을 때, 파일 내용을 보면서 AI 에이전트에게 물을 때 씁니다.

단계:

1. 파일 이름을 눌러 열기 — 답 아래나 회의 대화에 나온 파일 이름을 누르면 뷰어가 열립니다. 채팅 화면 위쪽의 「파일」 단추 목록에서 파일 줄을 눌러도 열립니다. 뷰어 위쪽에는 파일 이름과 올린 곳(내 작업 폴더, 회의, 칸반)이 보입니다. 닫으려면 「닫기」를 누릅니다.
2. 문서 넘기고 찾기 — PDF·Word 는 「이전 쪽」·「다음 쪽」으로 쪽을 넘기고 「확대」·「축소」로 크기를 바꿉니다. 「화면에 맞춤」과 「원래 크기」는 한 단추로 오갑니다. PDF 는 「문서에서 찾기」에 낱말을 적으면 찾은 곳을 차례로 보여 줍니다. Excel 은 아래의 「시트」 탭으로 시트를 바꾸고, PowerPoint 는 슬라이드를 한 장씩 넘깁니다. 마크다운 파일은 「보기」와 「원문」으로 모양과 원본 글을 오가며 봅니다.
3. 뷰어에서 바로 일 시키기 — 「AI에게 묻기」를 누르면 이 파일에 대해 묻는 글이 입력칸에 채워집니다. 「받기」는 파일을 내 컴퓨터에 저장합니다. 「경로 복사」는 AI 에이전트가 보는 파일 위치를 복사하니, 다른 대화에서 이 파일을 말할 때 붙여 넣습니다. 회의 자료에서는 「방에 올리기」로 방 사람들과 함께 볼 수 있습니다. 「더 보기」의 「지우기」는 파일을 지웁니다.
4. 열리지 않을 때 — 암호가 걸린 PDF 는 비밀번호를 넣고 「열기」를 누르면 열립니다. 옛 형식(doc·xls·ppt)과 암호가 걸린 Office 문서는 미리 볼 수 없으니 「받기」로 저장해 엽니다. 너무 크거나 손상된 문서도 미리 볼 수 없습니다. Excel 은 앞 1,000줄·100열까지만 보입니다. 미리 보기는 원본과 모양이 조금 다를 수 있으니, 서식이 중요하면 내려받은 파일로 확인합니다.

#### 말로 입력하고 답을 소리로 듣기

키보드 대신 말로 질문하고, 받은 답은 읽어 달라고 할 수 있습니다.

입력칸의 「말로 입력」 단추를 누르고 말하면, 말한 내용이 글로 바뀌어 입력칸에 들어갑니다. 한 번에 최대 1분까지 말할 수 있고 녹음은 저장하지 않습니다. 답 아래의 「읽어 주기」를 누르면 AI 에이전트의 답을 소리로 읽어 줍니다.

언제 쓰나: 타자를 치기 어려운 곳에서 질문할 때, 긴 답을 눈으로 읽지 않고 듣고 싶을 때 씁니다. 처음 쓸 때 브라우저가 마이크 사용을 물으면 허용해야 합니다.

단계:

1. 말로 입력 시작하기 — 입력칸의 「말로 입력」 단추를 누르고 질문을 말합니다. 브라우저가 마이크 사용을 물으면 「허용」을 고릅니다. 말을 마치면 「녹음 끝내기」를 누릅니다. 1분이 지나면 저절로 끝나고, 「녹음 취소」로 버릴 수 있습니다.
2. 받아쓴 글 확인하고 보내기 — 말한 내용이 글로 바뀌어 입력칸에 들어갑니다. 틀린 글자를 고친 뒤 Enter 를 눌러 보냅니다. 「말소리를 알아듣지 못했습니다」가 나오면 조용한 곳에서 다시 말하고, 「받아쓰지 못했습니다」가 나오면 「다시 시도」를 누릅니다.
3. 답 소리로 듣기 — AI 에이전트의 답이 끝나면 답 아래에 「읽어 주기」 단추가 생깁니다. 누르면 답을 소리로 읽고, 읽는 도중에 「읽기 멈추기」로 멈춥니다. 앞부분 약 15분 분량까지만 읽습니다. 녹음 중이거나 답이 쓰이는 중에는 읽을 수 없습니다.
4. 읽어 주는 목소리 고르기 — 「설정 › 내 화면」 화면의 「읽어 주기 목소리」에서 목소리를 고릅니다. 「미리 듣기」로 들어 보고 정합니다. 이 설정은 이 브라우저에만 저장됩니다.

#### AI 에이전트가 허락이나 질문을 보냈을 때 답하기

승인 요청과 AI 에이전트의 질문은 대화 안과 받은편지함에 나타납니다. 답해야 일이 이어집니다.

AI 에이전트가 파일을 지우거나 프로그램을 실행하는 것처럼 위험할 수 있는 일을 하기 전에 허락을 구할 때가 있습니다. 일을 이어가려고 질문할 때도 있습니다. 이때 대화 안에 「승인이 필요합니다」 카드나 「AI 에이전트의 물음」 카드가 나타나고, 같은 내용이 상단 막대의 받은편지함에도 모입니다. 답하기 전에는 AI 에이전트가 기다립니다.

언제 쓰나: 받은편지함 단추에 숫자가 보일 때, AI 에이전트가 답이 없이 멈춘 것처럼 보일 때, 예약 작업이 끝났거나 실패했다는 알림을 확인할 때 씁니다.

단계:

1. 받은편지함 열기 — 상단 막대의 받은편지함(종 모양) 단추에 숫자가 보이면 눌러서 엽니다. 「답할 일」에는 승인 요청과 AI 에이전트의 질문이 모이고, 「알림」에는 끝나거나 실패한 예약 작업 같은 알려 주는 글이 모입니다.
2. 승인 요청에 답하기 — 「승인이 필요합니다」 카드에서 AI 에이전트가 무엇을 하려는지 읽고 고릅니다. 「한 번 허용」은 이번 한 번만, 「이 대화에서 허용」은 이 대화가 끝날 때까지, 「항상 허용」은 같은 종류의 일을 앞으로 계속 허용합니다. 무슨 일인지 확실하지 않으면 「거부」를 누릅니다.
3. AI 에이전트의 질문에 답하기 — 「AI 에이전트의 물음」 카드에 답을 적어 보냅니다. 답하면 AI 에이전트가 하던 일을 이어서 합니다. 오래 답하지 않으면 질문이 닫히니, 닫힌 뒤에는 채팅에서 일을 다시 시킵니다.
4. 알림 확인하기 — 「알림」은 읽고 「확인했습니다」를 누르면 사라집니다. 「모두 확인」은 알림만 한 번에 지우고, 승인과 질문처럼 답이 필요한 항목은 그대로 남깁니다.

#### 지난 대화 이어서 하기와 새 대화 시작하기

지난 대화를 찾아 이어 쓰거나, 새 주제는 새 대화로 시작합니다.

대화는 지난 대화로 남아 언제든 다시 열어 이어서 쓸 수 있습니다. 주제가 바뀌면 새 대화를 열어 앞선 대화와 섞이지 않게 합니다. AI 에이전트가 답하는 중에는 중단할 수 있습니다.

언제 쓰나: 어제 하던 일을 이어서 맡길 때, 전혀 다른 일을 물을 때, AI 에이전트가 엉뚱한 방향으로 길게 답할 때 씁니다.

단계:

1. 지난 대화 찾아 열기 — 채팅 화면의 「지난 대화」를 눌러 목록을 엽니다. 「지난 대화 검색」에 낱말을 적으면 찾아 줍니다. 대화를 누르면 이어서 쓸 수 있습니다.
2. 새 대화 시작하기 — 「새 대화」를 누르면 새 주제로 시작합니다. 지금 대화는 지난 대화로 남습니다.
3. 답하는 도중에 멈추기 — AI 에이전트가 답하는 동안 「답변 중단」을 누르면 멈춥니다. 멈춘 뒤 새 요청을 보내 방향을 바꿉니다.

#### 화면 언어와 밝기 바꾸기

언어, 밝은·어두운 테마, 날짜 시간대를 내 브라우저에 맞춥니다.

「내 화면」에서 화면 언어, 표에 보이는 줄 수, 날짜 시간대, 테마(밝게·어둡게), 오피스 배경음악, 답을 읽어 주는 목소리를 고릅니다. 이 설정은 지금 쓰는 브라우저에만 저장되어, 다른 브라우저나 컴퓨터에서는 다시 정해야 합니다.

언제 쓰나: 화면 글자가 읽기 어려울 때, 영어 화면으로 바꾸거나 되돌릴 때, 날짜가 내 시간과 다를 때 씁니다.

단계:

1. 내 화면 열기 — 왼쪽 메뉴의 「설정 › 내 화면」를 엽니다.
2. 값 고르기 — 「언어」, 「테마」(Light·Dark), 「날짜 표시용 시간대」, 「테이블의 행 수」에서 원하는 값을 고릅니다. 시간대에서 「브라우저 시간대 따르기」를 고르면 내 컴퓨터의 시간대를 씁니다.

#### 내 AI 에이전트 작업공간 확인하고 하나 더 만들기

AI 에이전트 작업공간 상태와 개수 한도를 보고 새 AI 에이전트 작업공간을 만듭니다.

「AI 에이전트 작업공간」 화면에서 내 AI 에이전트 작업공간과 각각을 지금 쓸 수 있는지 봅니다. AI 에이전트 작업공간 안에는 설정을 모아 둔 프로파일이 들어 있고, 처음 받은 AI 에이전트 작업공간에는 「주 프로파일」이 하나 있습니다. 업무마다 AI 에이전트 작업공간을 따로 만들면 성격·스킬·비밀값을 업무에 맞게 나눠 둘 수 있습니다.

언제 쓰나: AI 에이전트가 답하지 않아 상태를 확인할 때, 다른 업무를 맡을 AI 에이전트 작업공간(예: 보고서 담당)을 하나 더 두고 싶을 때 씁니다. 상태가 「준비 중」이나 「만드는 중」에서 오래 바뀌지 않으면 관리자에게 알립니다. 만들 수 있는 개수에는 한도가 있습니다.

단계:

1. AI 에이전트 작업공간 목록 보기 — 「내 AI 에이전트 › AI 에이전트 작업공간」 화면에 내 AI 에이전트 작업공간과 상태가 나옵니다. 제목 아래에 만들 수 있는 개수 한도가 있습니다.
2. AI 에이전트 작업공간 만들기 — 제목 옆 + 버튼(AI 에이전트 작업공간 만들기)을 누르고 이름을 적어 만듭니다. 만든 뒤 잠시 「준비 중」으로 보이고, 준비가 끝나면 쓸 수 있습니다. 그 안의 프로파일의 성격·스킬·비밀값은 「프로파일」 화면에서 고칩니다.

#### 다른 곳의 프로파일 가져오기

내 PC 의 Hermes 나 내 다른 AI 에이전트 작업공간의 프로파일을 가져옵니다.

내 PC 에서 쓰던 Hermes 를 내 프로파일에 넣거나, 내 다른 AI 에이전트 작업공간의 프로파일을 바탕으로 새 프로파일을 만듭니다. PC 에서 가져오면 그 프로파일의 성격·기억·스킬·예약 작업·대화 기록이 PC 의 것으로 바뀝니다. 다른 AI 에이전트 작업공간에서 가져오면 성격(SOUL)과 안전한 설정만 복사합니다.

언제 쓰나: PC 에서 쓰던 Hermes 를 AAS 에서 이어 쓰고 싶을 때, 다른 AI 에이전트 작업공간에서 다듬어 둔 성격을 새 프로파일에 쓰고 싶을 때 씁니다. 「PC 에서 가져오기」 버튼은 내 AI 에이전트 작업공간의 프로파일 상세(루트 프로파일 default 는 빼고)에서, 그 AI 에이전트 작업공간의 소유자나 관리자에게 보입니다. 한 컴퓨터용 시험 설치(Docker compose)에는 없습니다.

단계:

1. PC 에서 가져오기 버튼 누르기 — 가져올 프로파일의 오른쪽 상세 창을 엽니다. 창 맨 위 닫기 버튼 앞의 올리기 아이콘(「PC 에서 가져오기」)을 누릅니다. 가져오면 그 프로파일의 성격·기억·스킬·예약 작업·대화 기록이 바뀝니다. 이 버튼은 AI 에이전트 작업공간의 소유자와 관리자에게만 보입니다.
2. PC 에서 내보내고 올리기 — PC 의 운영체제를 고르고, 보이는 내보내기 명령을 PC 의 터미널(윈도우는 PowerShell)에서 실행합니다. 「PC 에서 내보낼 프로파일」 칸에는 PC 에서 쓰던 프로파일 이름을 적습니다(주 프로파일 main 에 가져오면 default, 다른 프로파일이면 그 이름이 미리 들어 있습니다). 만들어진 .tar.gz 파일을 놓는 칸에 끌어다 놓거나 「파일 고르기」로 올립니다. 올리기가 끝나면 확인 단계가 열립니다.
3. 확인하고 프로파일 바꾸기 — 「바뀌는 것」과 「그대로 남는 것」을 확인하고 「<프로파일 이름> 내용 바꾸기」를 누릅니다. AAS 의 비밀값·MCP 로그인·채널 연결·모델 설정은 그대로 남고, PC 의 것은 들어오지 않습니다. 예약 작업은 모두 일시정지로 들어옵니다. 결과 화면의 「아직 할 일」을 따라 비밀값을 넣고 MCP 서버에 다시 로그인합니다.
4. 새 프로파일 열기 — 「내 AI 에이전트 › 프로파일」 화면에서 제목 옆 + 버튼(새 프로파일)을 누릅니다.
5. 다른 AI 에이전트 작업공간에서 가져오기 — 이름을 적고 「다른 AI 에이전트 작업공간에서 가져오기」 칸에서 가져올 프로파일을 고릅니다. 그다음 아래의 만들기 버튼을 누릅니다. 성격(SOUL)과 안전한 설정만 복사합니다. 비밀값·채널·MCP 서버·스킬·모델 설정은 가져오지 않고, 새 프로파일이 들어갈 AI 에이전트 작업공간의 것을 씁니다. 이 칸은 내가 쓸 수 있는 다른 AI 에이전트 작업공간이 있을 때만 보입니다.

#### AI 에이전트 성격(SOUL) 바꾸기

AI 에이전트가 어떤 말투와 역할로 답할지 정합니다.

성격(SOUL)은 AI 에이전트가 늘 따르는 소개 글입니다. 맡은 역할, 말투, 지켜야 할 규칙을 적어 두면 AI 에이전트가 그에 맞춰 답합니다.

언제 쓰나: 답이 너무 길거나 말투가 업무에 맞지 않을 때, AI 에이전트에게 정해진 역할(예: 영업 지원, 보안 점검)을 맡기고 싶을 때 씁니다.

단계:

1. 성격(SOUL) 탭 열기 — 「주 프로파일」 표시가 붙은 내 프로파일의 오른쪽 상세 창에서 「성격(SOUL)」 탭을 엽니다. 지금 성격 글이 보입니다.
2. 고치고 저장하기 — 「고치기」(글이 비어 있으면 「쓰기」)를 누르고 글을 고친 뒤 저장합니다. 고친 글은 다음 대화부터 적용됩니다. 저장하기 전에 탭을 옮기거나 상세 창을 닫으면 버릴지 묻습니다. 다른 화면으로 가면 고치던 글이 임시로 남아 있어서, 다시 열면 「이어 쓰기」로 계속 고칠 수 있습니다.

#### AI 에이전트가 쓰는 모델 바꾸기

관리자에게 모델 변경 요청을 보냅니다.

주 모델은 AI 에이전트가 답을 만들 때 쓰는 AI 모델입니다. 모델에 따라 답의 품질과 속도가 달라집니다. 모델은 관리자만 바꿀 수 있어서, 사용자는 화면에서 변경 요청을 보냅니다.

언제 쓰나: 답이 자주 틀리거나 너무 느릴 때, 특정 모델을 써야 하는 업무가 생겼을 때 요청합니다.

단계:

1. 관리자에게 요청 보내기 — 내 주 프로파일 상세의 「개요」 탭, 「주 모델」 줄에 있는 「관리자에게 모델 변경 요청」을 누르고 원하는 모델을 적어 보냅니다. 요청은 관리자의 받은편지함으로 가고, 처리될 때까지 그 자리에 「처리 대기 중」이 보입니다.

#### 스킬 허브에서 스킬 설치하기

필요한 기능을 패키지로 찾아 내 프로파일에 넣습니다.

스킬은 AI 에이전트가 특정 일을 하는 방법을 적어 둔 묶음입니다. 스킬 허브에서 패키지를 설치하면 AI 에이전트가 그 일을 할 수 있게 됩니다.

언제 쓰나: AI 에이전트가 지금은 못 하는 일(예: 특정 형식의 문서 만들기)을 시키고 싶을 때, 이미 만들어진 방법을 그대로 쓰고 싶을 때 씁니다.

단계:

1. 패키지 찾기 — 「스킬 › 스킬 허브」 화면에서 쓸 패키지를 찾습니다. 행을 누르면 AI 요약과 설명, 「AI 에게 더 묻기」 버튼이 보입니다.
2. 설치하기 — 패키지 상세 창의 「이 프로파일에 설치」에서 설치할 프로파일을 고릅니다.
3. 설치한 스킬 확인하기 — 내 주 프로파일의 「스킬」 탭에서 설치한 스킬이 켜져 있는지 봅니다.

#### AAS 기본 제공 스킬 사용하기

문서 읽기·만들기, 사진 글자 읽기, 명함 정리, 사용법 묻기를 말로 시킵니다.

AAS 에는 모든 AI 에이전트가 처음부터 쓰는 기본 스킬이 있습니다. 문서 읽기(doc-to-markdown), 한글 문서 읽기(hwp-to-markdown), 사진·스캔 글자 읽기(ocr-to-markdown), 문서 만들기(markdown-to-doc), 명함 정리(business-card-ocr), 사용법 묻기(aas-help)입니다. 스킬 이름을 외울 필요는 없습니다. 하고 싶은 일을 평소 말로 적으면 AI 에이전트가 알맞은 스킬을 고릅니다.

언제 쓰나: 올린 문서를 요약하거나 표를 뽑을 때, 한글·Word·PDF 문서를 새로 만들 때, 명함 사진을 목록으로 정리할 때, AAS 사용법이 궁금할 때 씁니다.

단계:

1. 기본 제공 스킬 확인하기 — 「스킬 › 스킬 목록」 화면의 「내 스킬」 탭에서 doc-to-markdown·hwp-to-markdown·ocr-to-markdown·markdown-to-doc·business-card-ocr·aas-help 를 찾아, 누르면 하는 일과 쓰는 때가 보입니다. 이 스킬들은 스킬 허브에서 모든 프로파일에 들어옵니다. 「기본 제공」 탭에는 Hermes 가 처음부터 가진 스킬이 보입니다. 채팅 입력칸에 / 를 치면 이 목록이 떠서 하나를 골라 시킬 수도 있습니다.
2. 문서 읽고 요약하기 — 문서를 올리고 「이 문서를 요약해 줘」「표만 뽑아 줘」「Markdown 으로 바꿔 줘」라고 적습니다. Word·Excel·PowerPoint·PDF 와 한글(hwp·hwpx) 문서를 읽을 수 있습니다. 결과 파일은 답 아래에 나타나고 「파일」에서 받습니다. 읽기만 하며 원본은 고치지 않습니다.
3. 사진·스캔 문서의 글자 읽기 — 사진, 캡처, 스캔한 공문을 올리고 「글자를 읽어 줘」라고 적습니다. 한국어와 영어 글자를 읽고, 손으로 쓴 글씨와 표도 읽습니다. 한자·일본어는 거의 읽지 못합니다. 읽은 결과가 맞는지는 반드시 원본과 견주어 확인합니다.
4. 문서 파일 만들기 — 「이 내용을 한글(hwpx) 보고서로 만들어 줘」「Word 로 줘」「PDF 로 뽑아 줘」「엑셀로 정리해 줘」「발표 자료로 만들어 줘」처럼 원하는 파일 종류를 적습니다. 공문서 모양(기안문·보고서·회의록 등)도 만들 수 있고, 한글 서식의 빈칸도 채웁니다. 만든 파일은 답 아래에서 받습니다.
5. 명함 사진을 목록으로 정리하기 — 명함 사진을 올리고 「명함 등록해 줘」라고 적습니다. 이름·회사·전화·이메일을 읽어 내 명함 목록에 쌓습니다. 이름이나 연락처가 잘 읽히지 않으면 등록하기 전에 먼저 묻습니다. 「A사 사람 찾아 줘」로 찾고, 「명함 목록 엑셀로 줘」로 엑셀 파일을 받습니다. 명함 목록은 AI 에이전트(프로파일)마다 따로 쌓입니다.
6. AAS 사용법 물어보기 — 「채팅 화면에서 파일은 어떻게 올려?」「예약 작업은 어디서 만들어?」처럼 AI 에이전트에게 물어보면 aas-help 스킬로 화면 이름과 순서를 알려 줍니다. 관리자가 해야 하는 일은 관리자에게 요청하라고 안내합니다.

#### 나만의 스킬 만들기

자주 하는 일의 순서를 스킬로 적어 두면 AI 에이전트가 같은 방식으로 되풀이합니다.

스킬은 「이런 일을 시키면 이 순서로 한다」를 적어 둔 설명서입니다. 주간 보고서 쓰기처럼 자주 하는 일의 순서와 주의점을 한 번 적어 두면, AI 에이전트가 같은 일을 맡을 때마다 그 순서를 따릅니다. 직접 적거나, AI 에이전트에게 만들어 달라고 하거나, 이미 만든 스킬 묶음(zip)을 올릴 수 있습니다.

언제 쓰나: 같은 일을 시킬 때마다 같은 설명을 되풀이하게 될 때, 우리 팀의 작성 방식이나 서식을 AI 에이전트가 따르게 하고 싶을 때 씁니다.

단계:

1. 새 스킬 열기 — 「스킬 › 스킬 목록」 화면에서 「새 스킬」을 누르면 서랍이 열립니다. 서랍 위에서 「직접 쓰기」와 「zip 올리기」 가운데 고릅니다.
2. 직접 쓰기 — 「이름」에 영문 소문자·숫자·- 로 적습니다(예: weekly-report). 「설명」에는 무슨 일을 하고 언제 쓰는지 적습니다. AI 에이전트가 이 설명을 보고 스킬을 고르고 앞 60자만 목록에 보이니, 핵심을 앞에 적습니다. 「누가 쓰나」에서 모든 프로파일이 쓸지 한 프로파일만 쓸지 고릅니다. 본문에는 「언제 쓰나」와 「절차」를 번호로 적고 「스킬 만들기」를 누릅니다. 본문 틀이 미리 들어 있으니 지우고 채웁니다.
3. AI 에이전트에게 맡기기 — 무엇을 적을지 모르겠거나 프로그램(스크립트)이 필요한 스킬이면 표 위 도구줄의 「AI 에이전트에게 맡기기」를 누릅니다(새 스킬 서랍 안이 아닙니다). AI 에이전트와의 대화가 열리고 스킬 제작 요청 틀이 채워집니다. 이름·하는 일·언제 쓰나·부르는 도구를 적어 보내면, AI 에이전트가 초안을 보여 주고 확인을 받은 뒤 만듭니다. 직접 쓰기로는 스크립트 파일을 만들 수 없습니다.
4. 만들어 둔 zip 올리기 — 「zip 올리기」에서 SKILL.md 가 들어 있는 zip 파일을 끌어 놓거나 고릅니다. 512KiB 까지 올릴 수 있고, SKILL.md 한 장만 올려도 됩니다. 스킬 이름을 확인하고, 스크립트가 들어 있으면 부르는 외부 주소를 읽은 뒤 「스크립트를 확인했습니다」를 체크하고 「올리고 적용」을 누릅니다. 출처를 모르는 zip 은 올리지 않습니다.
5. 만든 스킬 확인하고 고치기 — 만든 스킬은 「내 스킬」 탭에 나타납니다. 채팅 입력칸에 / 를 치면 목록에 보입니다. 그 스킬이 필요로 하는 비밀값이 있으면 스킬 서랍의 「비밀값 탭에서 넣기」로 채웁니다. 내용은 스킬 연결도 화면에서 고치고 버전을 관리합니다. 스킬은 AI 에이전트가 스스로 쓰는 것이니, 만든 뒤 한 번 시켜 보고 결과가 기대와 다르면 본문의 절차를 고칩니다.

#### 내 스킬을 스킬 허브에 올려 함께 쓰기

내가 만든 스킬을 스킬 허브에 게시하면 다른 사람도 설치해 쓸 수 있습니다.

스킬 허브는 스킬을 모아 두고 나누는 곳입니다. 내가 만든 스킬을 게시하면 같은 AAS 의 다른 사람이 「스킬 허브」 화면에서 설치할 수 있습니다. 게시는 관리자의 검토를 거치는 것이 기본입니다. 이 AAS 에서 만들고 그 뒤 고치지 않은 스킬은 검토 없이 바로 게시되기도 합니다(관리자가 끌 수 있습니다).

언제 쓰나: 팀이 같은 스킬을 쓰게 하고 싶을 때, 내 다른 AI 에이전트에도 같은 스킬을 넣고 싶을 때, 새 버전을 퍼뜨릴 때 씁니다.

단계:

1. 게시할 스킬 열기 — 「스킬 › 스킬 목록」 화면에서 게시할 스킬을 눌러 서랍을 엽니다. 다른 프로파일에서 가져온 공용 스킬은 여기서 올릴 수 없고, 원래 프로파일에서 올려야 합니다.
2. 게시 요청하기 — 서랍의 「스킬 허브에 게시」에서 「스킬 허브 이름」(소문자·숫자·하이픈)과 「버전」을 정하고 「게시 요청」을 누릅니다. 스킬 폴더 안의 일반 파일만 올라가고 숨김 파일과 링크는 빠집니다. 비밀값처럼 보이는 글자나 사내 주소·사설 IP 가 있으면 게시할 수 없으니 먼저 지웁니다.
3. 승인 기다리기 — 요청하면 상태가 「승인 기다림」으로 보이고, 관리자가 승인하면 「게시됨」이 됩니다. 반려되면 「반려됨」으로 바뀝니다. 고쳐서 새 버전으로 다시 요청합니다. 게시한 뒤에는 되돌릴 수 없으니 올리기 전에 내용을 한 번 더 읽습니다.
4. 다른 프로파일에 설치하기 — 게시된 스킬은 「스킬 › 스킬 허브」 화면에 나타납니다. 설치할 프로파일을 골라 「설치」를 누르면 그 프로파일에서 쓸 수 있습니다. 새 버전이 나오면 「새 버전」 표시가 붙고 같은 화면에서 올릴 수 있습니다.

#### 외부 도구(MCP 서버) 연결하기

AI 에이전트가 다른 시스템의 도구를 쓰도록 MCP 서버를 붙입니다.

MCP 서버는 AI 에이전트가 다른 시스템(예: 일정 관리, 이슈 관리, 사내 데이터베이스)의 기능을 쓸 수 있게 해 주는 서버입니다. 서버를 연결하면 그 시스템의 기능이 AI 에이전트의 도구로 추가됩니다. 연결한 서버는 내가 넣은 키의 권한으로 동작합니다. 오피스·회의실에서 다른 사람이 이 AI 에이전트에게 일을 시켜도 같은 권한을 씁니다.

언제 쓰나: AI 에이전트가 사내 시스템의 데이터를 직접 조회하거나 처리하게 하고 싶을 때 씁니다. 연결할 서버의 주소나 실행 명령은 그 시스템 담당자에게 받습니다.

단계:

1. MCP · 도구 묶음 탭 열기 — 내 주 프로파일의 「MCP · 도구 묶음」 탭을 엽니다. 「MCP 서버」 구역에 연결된 서버가 보입니다.
2. 서버 추가하기 — 「서버 추가」를 누르고 추가 방식을 고릅니다. 처음에는 준비된 목록인 「카탈로그」가 열립니다. 받은 서버 주소가 있으면 「원격 주소」, 실행할 명령을 받았으면 「프로그램 실행」을 고릅니다. Docmost 위키는 카탈로그의 「docmost」를 고르고 MCP 주소와 Docmost 설정 > API keys 에서 만든 내 키를 넣습니다. 기본은 읽기 도구만 등록하고, 「쓰기 도구도 등록」을 고르면 페이지·댓글도 씁니다. 이 프로파일의 브라우저·외부 연결(connections) 도구는 꺼지고, 사용 규칙 스킬(docmost)이 함께 설치됩니다. Outline 위키는 카탈로그의 「outline」을 고르고 MCP 주소와 Outline 설정 > API 에서 만든 내 키를 넣습니다. 읽기만 쓰려면 키를 만들 때 Scopes 에 read 를 적습니다. 쓰기 도구를 골라도 삭제 도구는 등록하지 않습니다. 이 프로파일의 브라우저·외부 연결 도구는 꺼지고 사용 규칙 스킬(outline)이 함께 설치됩니다. 나중에 Outline 서버를 지워도 두 도구는 꺼진 채로 남으니 필요하면 도구 탭에서 켭니다. 쓰기 도구 스위치를 바꾼 뒤에는 「지금 적용」을 누릅니다. 연결한 뒤에는 「새 대화」에서 씁니다. 저장해 대화상자가 닫히면 카드의 「다음」을 누릅니다.
3. 연결 시험하기 — 서버 행의 「연결 시험」을 눌러 도구 수를 확인합니다. 실패하면 보이는 오류 문장을 따라 고칩니다.

#### API 키 같은 비밀값 넣기

AI 에이전트가 쓰는 키와 토큰을 넣습니다.

비밀값은 AI 에이전트가 외부 서비스에 접속할 때 쓰는 API 키·토큰·비밀번호입니다. 한 번 넣은 값은 화면에 다시 보이지 않고, AI 에이전트만 씁니다.

언제 쓰나: 스킬이나 MCP 서버가 키를 요구할 때, 키가 만료되거나 바뀌어 새 값을 넣어야 할 때 씁니다.

단계:

1. 비밀값(.env) 탭 열기 — 내 주 프로파일의 「비밀값(.env)」 탭을 엽니다. 이미 넣은 값은 이름과 「값 있음」 표시만 보입니다.
2. 새 비밀값 넣기 — 「새로 넣기」 구역에 이름을 적고 「새 비밀값 넣기」를 누른 뒤 값을 넣어 저장합니다. 이름은 영문자로 시작하고 영문 대문자·숫자·_ 로 씁니다(예: MY_API_KEY). 소문자로 적으면 대문자로 바뀝니다. 「암호화되지 않은 주소」라는 경고가 보이면 이 주소에서는 넣는 칸이 나오지 않으니 관리자에게 알립니다.

#### 메신저(텔레그램·디스코드·슬랙)로 대화하기

메신저에서 내 AI 에이전트와 대화하도록 채널을 켭니다.

채널을 켜면 AAS 화면에 들어오지 않아도 텔레그램·디스코드·슬랙에서 내 AI 에이전트와 대화할 수 있습니다.

언제 쓰나: 이동 중이거나 메신저를 주로 쓸 때, 예약 작업의 결과를 메신저로 받고 싶을 때 씁니다.

단계:

1. 메신저 연결 탭 열기 — 내 주 프로파일의 「메신저 연결」 탭을 엽니다.
2. 켜고 허용 사용자 정하기 — 쓸 메신저를 켭니다. 허용 사용자 칸을 비워 두고 봇에게 먼저 말을 걸면 「페어링 요청과 허용된 사용자」 구역에 요청이 뜹니다. 그 요청을 「승인」하는 방법이 가장 쉽습니다. 직접 적으려면 메신저 앱에서 쓰는 내 사용자 ID 를 넣습니다(AAS 아이디가 아닙니다).
3. 연결 상태 보기 — 「자동화 › 메신저 연결」 화면에서 메신저가 연결됐는지 봅니다.

#### 정해진 시각에 일 시키기(예약 작업)

매일·매주 같은 일을 AI 에이전트에게 자동으로 맡깁니다.

예약 작업(Cron)은 정해진 시각에 AI 에이전트에게 같은 일을 자동으로 시키는 기능입니다. 결과는 정해 둔 곳(예: 메신저)으로 받습니다.

언제 쓰나: 매일 아침 업무 요약이나 매주 보고서 초안처럼 반복되는 일을, 매번 요청하지 않고 맡기고 싶을 때 씁니다.

단계:

1. 예약 작업 탭 열기 — 내 주 프로파일의 「예약 작업」 탭에서 이 AI 에이전트의 정기 작업을 봅니다.
2. 새 예약 작업 만들기 — 「새 예약 작업」 버튼을 누르고 작업 이름, 시킬 일(지시문), 결과를 받을 곳, 주기를 정한 뒤 「작업 만들기」를 누릅니다. 결과를 받을 곳에는 이 프로파일에서 켜 둔 메신저가 보입니다.
3. 작업 상태 보기 — 「자동화 › 예약 작업」 화면에서 실패하거나 멈춘 작업, 알림 대상이 없는 작업을 봅니다.

#### 3D 오피스에서 함께 일하기

내 AI 에이전트의 자리를 3D 방에서 보고 대화하는 화면입니다.

3D 오피스는 내 AI 에이전트, 같은 부서의 AI 에이전트, 내가 구성원인 TFT 방(여러 AI 에이전트가 한 과제를 함께 맡는 방)의 AI 에이전트 자리를 3D 방에 보여 주는 화면입니다. 다른 부서의 AI 에이전트는 보이지 않습니다. 보이는 AI 에이전트의 이름·소유자·상태는 볼 수 있지만, 대화는 내 AI 에이전트와만 합니다. 관리자가 나를 TFT 방의 구성원으로 넣으면, 그 방의 AI 에이전트와도 대화하고 함께 회의를 할 수 있습니다.

언제 쓰나: 내 AI 에이전트들의 상태를 한눈에 보고 싶을 때, 한 가지 일을 여러 AI 에이전트에게 함께 맡기고 싶을 때 씁니다. 여러 AI 에이전트와 일하려면 먼저 관리자에게 TFT 방을 만들어 달라고 요청합니다.

단계:

1. 오피스 열기 — 「대화 › 오피스」 화면입니다. 3D 방에 내 AI 에이전트, 같은 부서의 AI 에이전트, 내가 구성원인 TFT 방의 AI 에이전트 자리가 보이고, 그중 내 AI 에이전트는 「내 AI 에이전트」로 표시됩니다. 같은 부서라도 남의 AI 에이전트에게는 대화를 보낼 수 없습니다. 내가 구성원인 TFT 방의 AI 에이전트는 예외입니다.
2. 대화하고 회의하기 — AI 에이전트 위 말풍선의 「대화」를 누르면 대화창이 뜹니다. 내가 구성원인 TFT 방이 있으면 「회의실」 탭에서 그 방의 AI 에이전트들에게 함께 요청합니다. 회의 입력칸에 @ 를 치면 AI 에이전트 이름 목록이 떠서 그 AI 에이전트에게만 보낼 수 있고, @ 를 여러 번 쓰면 여러 AI 에이전트에게 보냅니다. / 를 치면 받는 AI 에이전트들의 스킬 목록이 뜹니다. TFT 방은 관리자가 「TFT 방」 탭의 「새 TFT 방」으로 만듭니다.

#### 사용량과 변경 기록 보기

세션·메시지 수와 토큰 사용량, 내 AI 에이전트 작업공간의 변경 기록을 봅니다.

「사용량」 화면에서 AI 에이전트의 세션(대화 한 번)과 메시지 수, 토큰 사용량을 봅니다. 토큰은 AI가 읽고 쓴 글의 양을 세는 단위입니다. 「변경 기록」 화면에서는 내 AI 에이전트 작업공간의 설정을 누가 언제 바꿨는지 봅니다.

언제 쓰나: 사용량이 갑자기 늘었는지 확인할 때, AI 에이전트가 전과 다르게 답해서 최근에 바뀐 설정을 찾을 때 씁니다.

단계:

1. 사용량 보기 — 「기록 › 사용량」 화면에서 세션·메시지 수와 입력·출력 토큰을 봅니다.
2. 변경 기록 보기 — AI 에이전트 작업공간 소유자에게는 이 화면이 「내 AI 에이전트 작업공간 변경 기록」이라는 이름으로 보입니다. 내 AI 에이전트 작업공간에서 누가 언제 무엇을 바꿨는지 봅니다.

#### 우리 부서 슬로건·목표 고치기

3D 오피스 위에 걸리는 부서 현수막 문구를 정합니다.

부서 슬로건·목표는 3D 오피스 위 하늘에 현수막으로 보이는 한 줄 문구입니다. 같은 부서 사람 누구나 고칠 수 있고, 회사 안 모든 사용자가 볼 수 있습니다.

언제 쓰나: 부서의 목표나 구호가 바뀌었을 때 고칩니다. 모든 사용자가 보므로 비밀값이나 개인 정보는 적지 않습니다.

단계:

1. 회사 정보 열기 — 「설정 › 회사 정보」 화면을 엽니다.
2. 부서 한 줄 고치기 — 「부서 슬로건·목표」에서 우리 부서 줄을 고치고 저장합니다. 부서가 정해지지 않았으면 관리자에게 부서를 넣어 달라고 요청합니다.

## How to use CogentAI AAS (English)

When the user asks what to do or where something is in the AAS screens, answer from the content below. Use screen and tab names exactly as shown on screen. For admin tasks not covered here (users, departments, models), tell the user to ask an administrator.

The band at the very top of the screen (above the top bar) shows notices an administrator posted in "Admin › Notices" with a period, type and audience (everyone or departments). Maintenance and outage notices also show their end time. A closed notice can be shown in the band again from "Current notices" in the account menu. Tell the user to ask an administrator to post or edit a notice.

### Menu structure

- Dashboard
  - Dashboard: AI Agent Workspace status and everything that needs action, on one screen
- Chat
  - Chat: Pick an AI Agent and start a conversation
  - Office: AI Agents and people work together in one room
- My AI Agents
  - Profiles: Edit a profile's personality, model, skills, tools, and scheduled jobs in one place
  - AI Agent Workspaces: Create your AI Agent Workspace and check its status and limit
  - Models: AI models your profiles use (LiteLLM)
- Skills
  - Skill list: Find a skill your AI Agents have
  - Skill hub: Choose a skill package and install it to a profile
  - Skill map: See where each skill is called from and what it calls
- Automation
  - Scheduled jobs: Work your AI Agents do on a schedule (cron): failed or stalled jobs, and jobs without a notification target
  - Messenger connections: Talk to your AI Agents from messengers such as Telegram and Slack (channels and gateway)
- Records
  - Usage: Chat sessions and token usage
- Settings
  - My display: Language, table rows, time zone, and theme, saved in this browser only
  - API keys & tokens: See where the keys and tokens AI Agents use to reach LLM, MCP, REST, and WebSocket services are stored
  - Claude Code connections: Connections and tokens that let Claude Code on your PC work with your AI agents through AAS
  - Company info: Company name and AI Agent introduction

### Guides by task

#### Talk to your AI Agent for the first time

Ask your AI Agent a question on the chat screen.

An AI Agent is an AI assistant that helps with your work. Ask a question or hand over a task in the chat screen, and the AI Agent answers or uses its connected tools and skills to find information and do the work. An AI Agent's settings (personality, skills, tools and so on) live in the Profiles screen, and that set of settings is called a profile.

When to use: Use it when you start using AAS, or when you want to ask a work question or hand over a task such as summarizing or tidying up text.

Steps:

1. Open the Chat screen — It is "Chat › Chat" in the left menu. The AI Agents you can talk to are listed on the left.
2. Pick an AI Agent — Click the AI Agent you want to talk to. New users see only their main profile at first.
3. Send a question — Type your question in the box below and press Enter. Type / at the start of the box to see this AI Agent's skills and have it follow the one you pick. After you finish this guide, you can also open the same chat from other screens with the character button at the bottom right.

#### Upload a document to summarize or organize it

Attach a file in chat and the AI Agent reads it, then summarizes or organizes it for you.

You can attach documents and photos in the chat message box. The AI Agent reads Word, Excel, PowerPoint, PDF and Hancom (HWP) documents, and also the text in scanned documents and photos. You can ask for a summary, a table extract or a translation. Each file can be up to 100MB.

When to use: Use it to shorten a long report, pull only the tables out of a document, or turn the text in a photo into a document.

Steps:

1. Attach a file to the message box — Click "Attach files" next to the message box and pick a file. You cannot send while it uploads, and its name appears above the box when it finishes. Remove a wrong file with the remove button beside its name. A removed file stays in "Files".
2. Write what you want and send — Type the task, for example "Summarize this report in ten lines", and press Enter. Say which part to use and what shape you want the result in, and the result fits better.
3. Check the result and download it — When the AI Agent makes a file, its name appears under the answer. Click the name to open it on the screen. To save it on your computer, open the "Files" button at the top of the chat screen and click "Download" on that file.

#### Open files in the document viewer

Look at PDF, Word, Excel, PowerPoint and Hancom documents and images on the screen without downloading.

The document viewer opens files from chat and meetings in a window instead of saving them to your computer. It shows PDF, Word (docx), Excel (xlsx), PowerPoint (pptx) and Hancom (hwp, hwpx) documents close to their page layout. Images, video, audio, tables (csv), Markdown and text files also open. Documents open only inside your browser and are not sent elsewhere.

When to use: Use it to check a report the AI Agent made before downloading, to find a passage in an uploaded document, or to ask the AI Agent about a file while you look at it.

Steps:

1. Click a file name to open it — Click a file name under an answer or in a meeting chat to open the viewer. You can also click a file row in the "Files" button at the top of the chat screen. The top of the viewer shows the file name and where it came from (your work folder, a meeting or a kanban). Click "Close" to leave.
2. Page through and search — For PDF and Word, use the previous and next page buttons and "Zoom in" and "Zoom out". "Fit" and "Original size" switch with one button. For PDF, type a word in "Find in document" to step through matches. For Excel, change sheets with the "Sheets" tabs below. PowerPoint shows one slide at a time. For Markdown files, "View" and "Source" switch between the formatted page and the original text.
3. Act on the file from the viewer — "Ask AI" fills the message box with a question about this file. "Download" saves the file to your computer. "Copy path" copies the location the AI Agent sees, so you can paste it when you mention this file in another chat. In meeting materials, "Share to room" lets the room see the file. "Delete" under "More" removes the file.
4. When a file will not open — For a password-protected PDF, type the password and click "Open". Old formats (doc, xls, ppt) and password-protected Office files cannot be previewed, so download them and open them in their own program. Files that are too large or damaged also cannot be previewed. Excel shows only the first 1,000 rows and 100 columns. The preview can differ a little from the original, so check the downloaded file when layout matters.

#### Speak your question and listen to the answer

Ask by voice instead of typing, and have the answer read aloud.

Click "Voice input" in the message box and speak, and what you said turns into text in the box. You can speak for up to 1 minute at a time, and recordings are not stored. Click "Read aloud" under an answer and the AI Agent's answer is read out loud.

When to use: Use it when typing is hard, or when you would rather listen to a long answer than read it. The first time, allow the microphone when the browser asks.

Steps:

1. Start voice input — Click "Voice input" in the message box and speak your question. When the browser asks to use the microphone, choose "Allow". Click "Finish recording" when you are done. It ends by itself after 1 minute, and "Cancel recording" throws it away.
2. Check the text and send — What you said appears as text in the message box. Fix any wrong words, then press Enter to send. If you see "No speech recognized", speak again in a quiet place. If it could not transcribe, click "Try again".
3. Listen to the answer — When the AI Agent finishes answering, a "Read aloud" button appears under the answer. Click it to hear the answer, and click "Stop reading" to stop. Only about the first 15 minutes are read. It cannot read while you record or while the answer is still being written.
4. Pick the reading voice — In "Settings › My display", choose a voice under "Read-aloud voice". Use "Preview" to hear it first. This setting is saved only in this browser.

#### Answer when the AI Agent asks for approval or has a question

Approval requests and questions from the AI Agent show up in the chat and in the inbox. The work continues once you answer.

Before the AI Agent does something risky, such as deleting files or running a program, it can ask for your approval. It can also ask a question to continue its work. A "Approval needed" card or a "Question from the AI Agent" card appears in the chat, and the same item is collected in the inbox on the top bar. The AI Agent waits until you answer.

When to use: Use it when a number appears on the inbox button, when the AI Agent looks stuck without an answer, or to check notices that a scheduled job finished or failed.

Steps:

1. Open the inbox — When a number appears on the inbox button (the bell) on the top bar, click it. "Needs you" collects approval requests and questions from the AI Agent. "Notices" collects information such as finished or failed scheduled jobs.
2. Answer an approval request — Read what the AI Agent wants to do on the "Approval needed" card, then choose. "Allow once" is for this one time, "Allow in this conversation" lasts until the conversation ends, and "Always allow" keeps allowing the same kind of action from now on. If you are not sure what it is, click "Deny".
3. Answer the AI Agent's question — Type your answer on the "Question from the AI Agent" card and send it. The AI Agent then continues its work. A question closes if you wait too long, so after it closes, ask for the task again in chat.
4. Dismiss notices — Read a notice and click "Dismiss" to remove it. "Dismiss all" removes only notices at once and keeps the items that need an answer, such as approvals and questions.

#### Continue a past chat or start a new one

Find a past chat and keep writing in it, or start a new chat for a new topic.

Conversations stay as past chats, and you can reopen one at any time and continue. When the topic changes, open a new chat so it does not mix with the earlier one. You can stop the AI Agent while it is answering.

When to use: Use it to continue yesterday's work, to ask about something completely different, or when the AI Agent is writing a long answer in the wrong direction.

Steps:

1. Find and open a past chat — Click "Past chats" on the chat screen to open the list. Type a word in "Search past conversations" to find one. Click a chat to continue it.
2. Start a new chat — Click "New chat" to begin a new topic. The current chat stays in the past chats.
3. Stop an answer in progress — Click "Stop reply" while the AI Agent is answering to stop it. After it stops, send a new request to change direction.

#### Change the screen language and brightness

Set the language, light or dark theme and date time zone for your browser.

In "My display" you choose the screen language, the number of table rows, the time zone for dates, the theme (light or dark), the office background music and the voice that reads answers. These settings are saved only in the browser you use now, so set them again on another browser or computer.

When to use: Use it when the screen text is hard to read, to switch to English or back, or when dates do not match your time.

Steps:

1. Open My display — Open "Settings › My display" in the left menu.
2. Pick the values — Choose what you want under "Language", "Theme" (Light or Dark), "Time zone for dates" and "Table rows". If you choose to follow the browser time zone, your computer's time zone is used.

#### Check your AI Agent Workspaces and create another

See AI Agent Workspace status and your limit, then create a new AI Agent Workspace.

The AI Agent Workspaces screen shows your AI Agent Workspaces and whether each one is ready to use. An AI Agent Workspace holds profiles that keep its settings, and the AI Agent Workspace you received first has one main profile. If you create a separate AI Agent Workspace for each job, you can keep its personality, skills and secrets suited to that job.

When to use: Use it when an AI Agent does not answer and you want to check its status, or when you want another AI Agent Workspace for a different job (for example, reports). If the status stays at Preparing or Creating for a long time, tell an administrator. There is a limit on how many AI Agent Workspaces you can create.

Steps:

1. See your AI Agent Workspaces — The "My AI Agents › AI Agent Workspaces" screen lists your AI Agent Workspaces and their status. Your limit is shown under the title.
2. Create an AI Agent Workspace — Click the + button next to the title (Create AI Agent Workspace) and enter a name. The AI Agent Workspace shows "Preparing" for a while and is ready to use after that. You change the personality, skills and secrets of its profiles on the "Profiles" screen.

#### Import a profile from elsewhere

Bring in the Hermes from your PC or a profile from another of your AI Agent Workspaces.

Put the Hermes you used on your PC into one of your profiles, or create a new profile from a profile in another of your AI Agent Workspaces. An import from your PC replaces the personality, memories, skills, scheduled jobs and chat history of that profile with those from your PC. An import from another AI Agent Workspace copies only the personality (SOUL) and safe settings.

When to use: Use it when you want to continue in AAS with the Hermes you used on your PC, or when you want to use a personality from another AI Agent Workspace in a new profile. The Import from PC button appears in the profile detail of your AI Agent Workspace (except the root profile default), for the owner of the AI Agent Workspace or an admin. It is not in the single-computer test install (Docker compose).

Steps:

1. Click Import from PC — Open the detail panel on the right for the profile to import into. At the top of the panel, before the close button, click the upload icon ("Import from PC"). The import replaces the personality, memories, skills, scheduled jobs and chat history of that profile. Only the owner of the AI Agent Workspace and administrators see this button.
2. Export on your PC and upload — Choose the operating system of your PC and run the export command shown in a terminal on your PC (PowerShell on Windows). In "Profile to export on your PC", enter the name of the profile you used on your PC (default is filled in for the main profile, and the profile name for other profiles). Drag the .tar.gz file into the drop area, or upload it with "Choose a file". When the upload ends, the review step opens.
3. Review and replace the profile — Check the Replaced and Kept lists and click "Replace <profile name>". The secrets, MCP sign-ins, channel connections and model settings in AAS stay as they are, and those on your PC are not imported. Scheduled jobs are imported as paused. On the result screen, follow the things left to do: set the secrets and sign in to the MCP servers again.
4. Open New profile — On the "My AI Agents › Profiles" screen, click the + button next to the title (New profile).
5. Import from another AI Agent Workspace — Enter a name and choose the profile to import in "Import from another AI Agent Workspace". Then click the create button at the bottom. Only the personality (SOUL) and safe settings are copied. Secrets, channels, MCP servers, skills and model settings are not imported; the new profile uses those of the AI Agent Workspace it is created in. This field appears only when you can use another AI Agent Workspace.

#### Change your AI Agent's personality (SOUL)

Decide the tone and role your AI Agent answers with.

The personality (SOUL) is an introduction the AI Agent always follows. Write its role, tone and rules there, and the AI Agent answers accordingly.

When to use: Use it when answers are too long or the tone does not fit your work, or when you want the AI Agent to take a specific role (for example, sales support or security review).

Steps:

1. Open the Personality (SOUL) tab — Open the "Personality (SOUL)" tab in the detail panel on the right for your profile marked "Main profile". The current personality text is shown.
2. Edit and save — Click Edit (Write if the text is empty), change the text and save. The new text applies from the next conversation. If you switch tabs or close the detail panel before saving, you are asked whether to discard your changes. If you go to another screen, your draft is kept, and you can continue with Continue editing when you open it again.

#### Change the model your AI Agent uses

Send a model change request to an administrator.

The main model is the AI model the AI Agent uses to write its answers. The model affects answer quality and speed. Only administrators can change it, so users send a change request from the screen.

When to use: Request a change when answers are often wrong or too slow, or when your work needs a specific model.

Steps:

1. Send a request to an administrator — On the "Overview" tab of your main profile, click "Ask an admin to change the model" on the "Main model" line and write the model you want. The request goes to the administrators' inbox, and "Waiting to be handled" is shown there until it is handled.

#### Install a skill from the skill hub

Find a package with the feature you need and add it to your profile.

A skill is a package that describes how the AI Agent does a specific job. Install a package from the skill hub, and the AI Agent can do that job.

When to use: Use it when you want the AI Agent to do something it cannot do yet (for example, create documents in a specific format), or to reuse a method someone has already written.

Steps:

1. Find a package — Find a package on the "Skills › Skill hub" screen. Click a row to see its AI summary, description and the "Ask AI more" button.
2. Install it — In the package detail panel, pick the profile to install it on under "Install to this profile".
3. Check the installed skill — On the "Skills" tab of your main profile, check that the installed skill is turned on.

#### Use the skills AAS provides

Ask in plain words to read or make documents, read text in photos, organize business cards or learn how to use AAS.

AAS includes built-in skills that every AI Agent has from the start: reading documents (doc-to-markdown), reading Hancom documents (hwp-to-markdown), reading text in photos and scans (ocr-to-markdown), making documents (markdown-to-doc), organizing business cards (business-card-ocr) and asking how to use AAS (aas-help). You do not need to remember skill names. Describe the job in everyday words and the AI Agent picks the right skill.

When to use: Use them to summarize an uploaded document or pull out its tables, to create a Hancom, Word or PDF document, to turn business card photos into a list, or when you wonder how AAS works.

Steps:

1. See the built-in skills — In "Skills › Skill list", find doc-to-markdown, hwp-to-markdown, ocr-to-markdown, markdown-to-doc, business-card-ocr and aas-help in the "My skills" tab. Click one to see what it does and when it is used. These skills come into every profile from the skill hub. The "Built-in" tab shows the skills Hermes has from the start. In the chat message box, type / to open this list and pick one.
2. Read and summarize a document — Upload a document and write "Summarize this document", "Pull out only the tables" or "Convert it to Markdown". It reads Word, Excel, PowerPoint, PDF and Hancom (hwp, hwpx) files. The result file appears under the answer and can be downloaded from "Files". It only reads and does not change the original.
3. Read text in photos and scans — Upload a photo, a screenshot or a scanned official document and write "Read the text". It reads Korean and English text, including handwriting and tables. It can hardly read Chinese characters or Japanese. Always compare the result with the original.
4. Make a document file — Write the file type you want, for example "Make this a Hancom (hwpx) report", "Give me Word", "Make a PDF", "Organize it in Excel" or "Make slides". It can also produce official-document layouts (drafts, reports, minutes) and fill the blanks of a Hancom form. Download the file under the answer.
5. Organize business card photos into a list — Upload a business card photo and write "Register this business card". It reads the name, company, phone and email and adds them to your card list. If the name or contact cannot be read well, it asks you before registering. Find people with "Find people from company A" and get an Excel file with "Give me the card list in Excel". The card list is kept separately for each AI Agent (profile).
6. Ask how to use AAS — Ask the AI Agent, for example "How do I upload a file in chat?" or "Where do I create a scheduled job?" and it answers with screen names and steps using the aas-help skill. For work only administrators can do, it tells you to ask an administrator.

#### Create your own skill

Write down the steps of a job you do often as a skill, and the AI Agent repeats it the same way.

A skill is a written guide that says "when asked this, do it in this order". Write the steps and cautions of a frequent job, such as the weekly report, once, and the AI Agent follows them every time it takes that job. You can write one yourself, ask the AI Agent to make it, or upload a skill bundle (zip) you already have.

When to use: Use it when you keep repeating the same explanation, or when you want the AI Agent to follow your team's writing style or format.

Steps:

1. Open the new skill drawer — In "Skills › Skill list", click "New skill" to open the drawer. At the top choose between "Write it" and "Upload zip".
2. Write it yourself — Type the name in lowercase letters, digits and - (for example weekly-report). In "Description", say what it does and when to use it. The AI Agent picks a skill by this description and only the first 60 characters show in its list, so put the key point first. Under "Who uses it", choose all profiles or one profile. In the body, number the "When to Use" and "Steps" parts, then click "Create skill". A body template is already filled in, so replace it.
3. Hand it off to the AI Agent — If you do not know what to write, or the skill needs a program (script), click "Hand off to AI Agent" in the toolbar above the table (not inside the New skill drawer). A chat opens with a skill request template filled in. Send it with the name, the job, when to use it and the tools to call, and the AI Agent shows a draft and creates it after you confirm. Writing it yourself cannot create script files.
4. Upload a ready-made zip — In "Upload zip", drop or pick a zip that contains SKILL.md. It can be up to 512KiB, and a single SKILL.md is fine. Check the skill name. If it contains scripts, read the outside addresses it calls, tick "I checked the scripts" and click "Upload and apply". Do not upload a zip from a source you do not know.
5. Check and improve the skill — The new skill appears in the "My skills" tab and in the list when you type / in the chat message box. If it needs secret values, fill them from the skill drawer. Edit its content and manage versions in the skill flow screen. The AI Agent uses skills on its own, so try it once after creating it and fix the steps in the body if the result is not what you expected.

#### Publish your skill to the skill hub to share it

Publish a skill you made to the skill hub so other people can install and use it.

The skill hub is where skills are collected and shared. Once you publish a skill, other people on the same AAS can install it from the "Skill hub" screen. Publishing normally goes through an administrator's review. A skill made on this AAS and not changed since can be published without review (an administrator can turn this off).

When to use: Use it when your team should use the same skill, when you want the same skill on your other AI Agents, or to spread a new version.

Steps:

1. Open the skill to publish — In "Skills › Skill list", click the skill to publish to open its drawer. A shared skill taken from another profile cannot be published here. Publish it from its original profile.
2. Request publishing — Under "Publish to the skill hub" in the drawer, set the "Skill hub name" (lowercase letters, digits and hyphens) and the "Version", then click "Request publishing". Only regular files inside the skill folder are uploaded, and hidden files and links are left out. If the skill has text that looks like a secret, or an internal address or private IP, it cannot be published, so remove them first.
3. Wait for approval — After you request it, the status shows "Waiting for approval", and "Published" once an administrator approves. If it is rejected, it shows "Rejected". Fix it and request again as a new version. Publishing cannot be undone, so read the content once more before you request.
4. Install on another profile — A published skill appears in "Skills › Skill hub". Pick the profile to install on and click "Install" to use it there. When a new version comes out, a "New version" mark appears and you can update from the same screen.

#### Connect an external tool (MCP server)

Attach an MCP server so your AI Agent can use tools from another system.

An MCP server lets the AI Agent use features of another system (for example, a calendar, an issue tracker or a company database). Once connected, that system's features become tools the AI Agent can use. A connected server acts with the permissions of the key you entered. When someone else asks this AI Agent for work in the office or a meeting room, it uses the same permissions.

When to use: Use it when you want the AI Agent to read or work with data in a company system. Get the server address or command from the person who runs that system.

Steps:

1. Open the MCP · Toolsets tab — Open the "MCP · Toolsets" tab of your main profile. Connected servers are listed under "MCP servers".
2. Add a server — Click Add server and choose how to add it. The dialog opens on Catalog, a prepared list. Choose Remote address if you received a server address, or Run a program if you received a command. For a Docmost wiki, pick "docmost" in the catalog and enter the MCP address and your own key created in Docmost Settings > API keys. Read tools are registered by default; choose "Also register write tools" to write pages and comments too. This profile's browser and connections tools are turned off and the usage-rules skill (docmost) is installed with it. For an Outline wiki, pick "outline" in the catalog and enter the MCP address and your own key created in Outline Settings > API. To read only, enter read in Scopes when you create the key. Delete tools are not registered even with write tools. This profile's browser and connections tools are turned off and the usage-rules skill (outline) is installed with it. If you remove the Outline server later, those two stay off; turn them on in the Tools tab if you need them. After you change the write tools switch, click Apply now. After connecting, use it in a new chat. When you save and the dialog closes, click Next on the card.
3. Test the connection — Click "Test connection" on the server row to see the number of tools. If it fails, follow the error message.

#### Add a secret such as an API key

Enter the keys and tokens your AI Agent uses.

Secrets are API keys, tokens and passwords the AI Agent uses to sign in to outside services. Once saved, a value is never shown on screen again, and only the AI Agent uses it.

When to use: Use it when a skill or MCP server asks for a key, or when a key expires or changes and you need to enter a new value.

Steps:

1. Open the Secrets (.env) tab — Open the "Secrets (.env)" tab of your main profile. Existing values show only their name and "Set".
2. Add a new secret — In the Add new section, type a name, click Add secret, enter the value and save. Names start with a letter and use capital letters, digits and _ (for example, MY_API_KEY). Lowercase letters are changed to capitals. If you see an "unencrypted address" warning, the input is hidden on this address, so tell an administrator.

#### Chat from a messenger (Telegram, Discord, Slack)

Turn on a channel so you can talk to your AI Agent from a messenger.

Turn on a channel to talk with your AI Agent from Telegram, Discord or Slack without opening AAS.

When to use: Use it when you are on the move or mostly use a messenger, or when you want cron results sent to your messenger.

Steps:

1. Open the Messenger connections tab — Open the "Messenger connections" tab of your main profile.
2. Turn it on and set allowed users — Turn on the messenger you want. If you leave the allowed users field empty and message the bot first, a request appears under Pairing requests and allowed users. Approving that request is the easiest way. To enter it yourself, use your user ID in the messenger app (not your AAS ID).
3. Check the connection — Check that the messenger is connected on the "Automation › Messenger connections" screen.

#### Run a task on a schedule (scheduled job)

Hand the same daily or weekly task to your AI Agent automatically.

A scheduled job (cron) runs the same task for the AI Agent automatically at set times. You receive the result where you choose (for example, a messenger).

When to use: Use it for repeated work such as a morning summary or a weekly report draft, so you do not have to ask every time.

Steps:

1. Open the Scheduled jobs tab — See this AI Agent's scheduled jobs on the "Scheduled jobs" tab of your main profile.
2. Create a scheduled job — Click New scheduled job, set the job name, what to do (instructions), where to send the result and the schedule, then click Create job. The result destinations list the messengers turned on for this profile.
3. Check job status — See failed or stalled jobs and jobs without a delivery target on the "Automation › Scheduled jobs" screen.

#### Work together in the 3D office

See your AI Agents' desks in a 3D room and talk with them.

The 3D office shows, in one 3D room, the desks of your AI Agents, your department's AI Agents and the AI Agents in TFT rooms you belong to (a TFT room is a room where several AI Agents work on one task together). AI Agents of other departments are not shown. You can see the names, owners and status of the AI Agents shown, but you can only chat with your own AI Agents. When an administrator adds you to a TFT room, you can also chat and hold meetings with that room's AI Agents.

When to use: Use it to see your AI Agents' status at a glance, or to hand one job to several AI Agents together. To work with several AI Agents, first ask an administrator to create a TFT room.

Steps:

1. Open the Office — This is the Chat › Office screen. The 3D room shows desks for your AI Agents, your department's AI Agents and the AI Agents in TFT rooms you belong to; yours are marked as yours. You cannot send chat to other people's AI Agents, even in your department, except AI Agents in TFT rooms you belong to.
2. Talk and meet — Click Chat in the bubble above an AI Agent to open a chat. If you belong to a TFT room, use the Meeting rooms tab to ask that room's AI Agents together. Type @ in the meeting box to pick an AI Agent by name and send only to it; use @ several times to send to several AI Agents. Type / to see the skills of the receiving AI Agents. Administrators create TFT rooms with New TFT room in the TFT rooms tab.

#### See usage and change history

See session and message counts, token usage and your AI Agent Workspaces' change history.

The Usage screen shows your AI Agents' sessions (one conversation each), message counts and token usage. A token is the unit that measures how much text the AI read and wrote. The Change history screen shows who changed your AI Agent Workspace's settings and when.

When to use: Use it to check whether usage suddenly went up, or to find a recent settings change when the AI Agent starts answering differently.

Steps:

1. See usage — The Records › Usage screen shows session and message counts and input and output tokens.
2. See change history — AI Agent Workspace owners see this screen as My AI Agent Workspace change history. It shows who changed what in your AI Agent Workspaces, and when.

#### Edit your department's slogan or goal

Set the department banner shown above the 3D office.

The department slogan or goal is one line shown as a banner in the sky above the 3D office. Anyone in the department can edit it, and every user in the company can see it.

When to use: Edit it when your department's goal or slogan changes. Everyone can see it, so do not write secrets or personal information.

Steps:

1. Open Company info — Open the "Settings › Company info" screen.
2. Edit your department's line — Edit your department's line under "Department slogan or goal" and save. If you have no department yet, ask an administrator to set one.

