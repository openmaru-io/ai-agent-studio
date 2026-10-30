---
name: hwp-to-markdown
description: "한글(한컴) 문서 HWP·HWPX(HWP 5.0·3.x)를 Markdown 으로 바꿔 읽는다. 사용자가 .hwp·.hwpx 파일을 올리고 읽기·요약·번역·Markdown 변환을 부탁할 때 쓴다. / Convert Korean Hancom HWP/HWPX documents to Markdown to read, summarize or translate them."
version: 1.1.0
author: OPENMARU, Inc.
license: Apache-2.0
metadata:
  hermes:
    tags: [hwp, hwpx, hancom, korean, markdown, convert]
    category: productivity
    related_skills: [doc-to-markdown, ocr-to-markdown, markdown-to-doc]
---

# 한글 문서(HWP·HWPX) → Markdown

> `<스킬폴더>` 는 이 스킬을 불러올 때(`skill_view`) 받은 `skill_dir` 경로다(스킬 허브로 설치하면 프로파일마다 다르다). 스크립트가 종료 코드 6 으로 끝나거나 `kordoc`·`pandoc` 같은 명령이 없다(command not found)고 나오면 다시 시도하지 말고, 이 에이전트에 필요한 도구가 없다고 사용자에게 알린다.

## 언제 쓰나

- 사용자가 `.hwp`·`.hwpx` 파일을 올리거나 경로를 주고 「읽어 줘」「요약해 줘」「Markdown 으로 바꿔 줘」「표를 뽑아 줘」라고 할 때.
- 한글 문서를 만들거나 고치는 일은 이 스킬이 아니다 — `markdown-to-doc` 를 쓴다.
- docx·pptx·xlsx·pdf 는 `doc-to-markdown`, 그림·스캔 PDF 는 `ocr-to-markdown` 을 쓴다.

## 파일 위치 (AAS)

- **입력:** 사용자가 올린 파일은 메시지 끝의 `[사용자가 파일을 올렸습니다: "<이름>" (<크기>). 경로: /opt/data/workspace/uploads/<날짜>/<이름>]` 줄에 절대 경로가 있다. 그 경로를 그대로 쓴다.
- **출력:** 결과는 `/opt/data/workspace/output/` 에 쓴다(없으면 만든다). 여기에 쓴 파일은 답 아래에 내려받기 칩이 붙는다. `uploads/` 안·`/tmp`·점(.)으로 시작하는 폴더에 쓰면 사용자가 받지 못한다.
- **이름:** 원본 이름에서 확장자만 바꾼다(`보고서.hwp` → `보고서.md`). 같은 이름이 있으면 `-2`, `-3` 을 붙인다. 원본은 고치지 않는다.
- 회의실(오피스)에서는 회의 지침의 결과 폴더(`/opt/data/workspace/rooms/<방id>/`)를 따른다.

## 바꾸는 법

스크립트 하나로 한다. 먼저 `kordoc` 으로 읽고, 실패하거나 결과가 비면 `hwpforge` 로 다시 한다.

```bash
mkdir -p /opt/data/workspace/output
python <스킬폴더>/scripts/hwp_to_md.py "<입력.hwp|.hwpx>" "/opt/data/workspace/output/<이름>.md"
```

- 끝에 「kordoc 로 바꿨습니다: … (글자 N, 표 M)」처럼 쓴 도구와 크기가 나온다.
- 한글 메모(검토 의견)까지 필요하면 `--with-memos` 를 앞에 붙인다(`hwpforge` 만 쓰고 메모를 `<!-- memo: … -->` 로 넣는다).
- 종료 코드 1 은 두 도구 모두 실패, 2 는 출력 파일이 이미 있음이다.

직접 다른 도구로 해 볼 때:

```bash
kordoc "<입력>" --table-format gfm --no-images -o "…/<이름>.md"           # 병합 셀 표도 Markdown 파이프 표로
kordoc "<입력>" -p 1-3 --no-images -o "…/<이름>.md"                        # 일부 쪽만
soffice --headless --convert-to docx --outdir /opt/data/workspace/.tmp "<입력>"   # 마지막 대체: docx 로 바꾼 뒤
markitdown /opt/data/workspace/.tmp/<이름>.docx > "/opt/data/workspace/output/<이름>.md"
```

## 결과 확인

- 결과 글자 수가 원본 크기에 비해 너무 적거나, 제목·본문 없이 표만 나오면 `--with-memos`(hwpforge)로 다시 해 비교한다.
- 병합 셀이 있는 표는 HTML `<table>` 로 나온다(병합 정보를 지키려고). 사용자가 Markdown 표를 원하면 `kordoc … --table-format gfm` 을 쓴다.
- `kordoc` 은 한글 메모(검토 의견)를 읽지 않는다. 검토 의견이 든 문서라면 `--with-memos` 로 다시 읽는다.
- 큰 문서는 대화에 전부 붙이지 말고 파일로 쓴 뒤 앞부분·목차·요약만 보인다.

## 사용자에게 알리기

답 끝에 저장한 경로를 적고 「답 아래 파일 칩이나 대화 메뉴의 「파일」에서 내려받을 수 있습니다」라고 안내한다. `MEDIA:` 태그나 다운로드 주소를 만들지 않는다.

## 하지 않는 것

- 인터넷에서 변환기를 받지 않는다. `pip install`·`npm install` 을 하지 않는다(폐쇄망, 필요한 도구는 이미 있다).
- 원본 파일을 덮어쓰지 않는다. 스킬 폴더(`<스킬폴더>`)에 쓰지 않는다.
- 암호가 걸린 문서는 사용자에게 암호를 받아 `kordoc "<입력>" --password "<암호>" -o …` 로 연다. 암호를 결과나 답에 남기지 않는다.
