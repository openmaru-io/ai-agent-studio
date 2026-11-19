---
name: cogentai-chart
description: 표 데이터로 선·막대·원·영역·산점도 등 차트를 그릴 때 쓴다. 도구 결과의 echarts_option 을 답에 ```echarts 블록으로 그대로 넣는다. 이미지(base64)·MEDIA 는 쓰지 않는다. 도구는 이름으로 직접 부르고 tool_call 로 감싸지 않는다. mcp__cogentai_chart__ 도구가 있을 때 고른다.
version: 0.1.7
metadata:
  aas:
    auto_edit: false
---

# CogentAI 차트

이 스킬은 MCP 서버 `cogentai-chart` 의 도구(`mcp__cogentai_chart__generate_*_chart`)를 언제, 어떻게 쓰는지 정한다.
서버 이름의 하이픈은 도구 이름에서 `_` 로 바뀐다.

## 1. 먼저 연결을 확인한다

- `mcp__cogentai_chart__` 도구가 없으면 차트 서버가 연결되지 않은 것이다. 이렇게 안내한다:
  「AAS 의 내 AI 에이전트 > 프로파일 > 도구 탭 > 새 MCP 서버 > 카탈로그에서 cogentai-chart 를 고르고, 관리자에게 받은 MCP 주소(…/mcp)와 키를 넣으세요. 넣은 뒤 「새 대화」로 다시 물어 주세요.」
- 키를 대화에 붙여 넣으라고 하지 않는다.

## 2. 도구를 부르는 방법

- 차트 도구는 처음에 목록에 없다(지연 등록). `tool_describe` 로 불러온 뒤 **`tool_call` 로 부른다.** 이름으로 직접 부르면 「does not exist」로 실패한다. `calls` 는 JSON 배열로 넘기고 문자열로 만들지 않는다. `execute_code` 로 감싸지 않는다.
- 차트 하나에 도구는 한 번 부른다.

## 3. 언제 그리는가

- 사용자가 차트·그래프를 그려 달라고 하거나, 사용자가 준 표·숫자를 비교해 보여 달라고 할 때 그린다.
- CogentAI 청약 통계 답(`ask_subscription_statistics`)에 이미 ```` ```echarts ```` 블록이 있으면 다시 그리지 않는다.
- 청약 통계 결과를 다른 차트로 다시 그릴 때는 이 스킬의 차트 도구를 쓰지 않는다. `export_subscription_result` 에 `format=chart` 와 `chart_type`·`sort_by`·`order`·`limit`·`value`·`category` 를 넘기면 orchestrator 가 DB 에서 정렬해 그린다(`cogentai-database-reb` 스킬 7절). 결과에 「합성 데이터(시험용, 실제 청약 통계가 아님)」가 있으면 차트 제목에도 「(합성 데이터)」를 붙인다.
- 데이터는 사용자가 준 값이나 도구 결과에 있는 값만 쓴다. 값을 지어내거나 채워 넣지 않는다. 값이 없으면 무엇이 필요한지 묻는다.
- **순위·상위 N·정렬은 직접 하지 않는다.** 행을 골라 `data` 를 만들지 말고, `query_result` 를 그대로 넘기면서 `sort_by`(정렬할 컬럼)·`order`(`desc` 기본, `asc`)·`limit`(남길 행 수)·`value`(값 컬럼)·`category`(이름 컬럼)를 준다. 예: 「공급세대수가 많은 상위 5개 단지를 파이 차트로」 → `category=주택명`, `value=공급세대수(전체)`, `sort_by=공급세대수(전체)`, `limit=5`. 표에서 직접 고르다 행을 빠뜨린 적이 있다(OKE 2026-11-08).
- `value` 를 주지 않으면 번호·코드·id 같은 식별자 컬럼은 값으로 쓰지 않는다. 값 컬럼이 여럿이면 `value` 로 하나를 정한다.

## 4. 차트 종류

- 시간에 따른 변화는 `generate_line_chart`(누적이면 `generate_area_chart`)로 그린다.
- 항목끼리 비교는 `generate_bar_chart` 로 그린다.
- 전체 중 비율은 `generate_pie_chart` 로 그린다. 항목이 7개를 넘으면 막대로 그린다.
- 두 값의 관계는 `generate_scatter_chart`, 두 축의 칸 값은 `generate_heatmap_chart` 로 그린다.
- 한 값의 달성률은 `generate_gauge_chart`, 단계별 감소는 `generate_funnel_chart`, 여러 지표 비교는 `generate_radar_chart` 로 그린다.
- 단위가 다른 두 지표를 한 차트에 둘 때는 `generate_multi_chart` 로 그린다.

## 5. 답에 넣는 방법

- 도구 결과의 `echarts_option`(JSON)을 **고치지 않고** 답에 이렇게 넣는다:

  ````
  ```echarts
  <echarts_option JSON>
  ```
  ````

- `image_base64`·`markdown_image`·`MEDIA:` 줄은 답에 넣지 않는다. 웹 채팅이 ```` ```echarts ```` 블록을 차트로 그린다.
- 차트 아래에 데이터의 출처(사용자가 준 표, 어느 도구의 결과)를 한 줄로 쓴다.
- 도구가 실패하면 실패했다고 알리고, 같은 데이터를 표로 보인다.
