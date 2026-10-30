---
name: doc-to-markdown
description: "docx·pptx·xlsx·xls·pdf(글자 있음)·html·csv·epub·Outlook .msg 와 옛 doc·ppt·odt·rtf 를 Markdown 으로 바꿔 읽는다. 올린 문서의 내용 확인·요약·표 추출에 쓴다. / Convert Office documents, PDFs with text, HTML, CSV, EPUB and Outlook messages to Markdown."
version: 1.1.0
author: OPENMARU, Inc.
license: Apache-2.0
metadata:
  hermes:
    tags: [markdown, convert, docx, pptx, xlsx, pdf, kordoc, markitdown]
    category: productivity
    related_skills: [hwp-to-markdown, ocr-to-markdown, markdown-to-doc, docx, pdf, xlsx]
---

# 문서(Office·PDF 등) → Markdown

> `<스킬폴더>` 는 이 스킬을 불러올 때(`skill_view`) 받은 `skill_dir` 경로다(스킬 허브로 설치하면 프로파일마다 다르다). 스크립트가 종료 코드 6 으로 끝나거나 `kordoc`·`pandoc` 같은 명령이 없다(command not found)고 나오면 다시 시도하지 말고, 이 에이전트에 필요한 도구가 없다고 사용자에게 알린다.

## 언제 쓰나

- 사용자가 문서를 올리고 「내용을 알려 줘」「요약해 줘」「Markdown 으로 바꿔 줘」「표를 뽑아 줘」라고 할 때.
- 문서를 **고치거나 새로 만드는** 일은 번들 스킬(`docx`·`xlsx`·`powerpoint`·`pdf`)이나 `markdown-to-doc` 을 쓴다. 이 스킬은 읽기만 한다.
- `.hwp`·`.hwpx` 는 `hwp-to-markdown`, 그림·스캔 PDF(글자층 없음)는 `ocr-to-markdown` 을 쓴다.

## 파일 위치 (AAS)

- **입력:** 메시지 끝의 `[사용자가 파일을 올렸습니다: … 경로: /opt/data/workspace/uploads/<날짜>/<이름>]` 줄의 절대 경로를 그대로 쓴다.
- **출력:** `/opt/data/workspace/output/` 에 쓴다(없으면 만든다). 그래야 답 아래에 내려받기 칩이 붙는다. 중간 파일은 `/opt/data/workspace/.tmp/` 에 둔다(칩에 섞이지 않는다).
- **이름:** 원본 이름에서 확장자만 `.md` 로. 같은 이름이 있으면 `-2`, `-3`. 원본은 고치지 않는다.

## 바꾸는 법

먼저 `kordoc` 을 쓴다(제목 단계·표를 잘 지키고 빠르다). 실패하거나 결과가 비면 `markitdown` 으로 다시 한다.

| 형식 | 먼저 | 다음 |
|---|---|---|
| docx·pptx·xlsx·xls·pdf(글자 있음) | `kordoc "<입력>" --no-images -o "/opt/data/workspace/output/<이름>.md" --silent` | `markitdown "<입력>" > "…/<이름>.md"` |
| pdf 일부 쪽 | `kordoc "<입력>.pdf" -p 1-3 --no-images -o …` | |
| html·csv·json·xml·epub·Outlook .msg | `markitdown "<입력>" > …` | |
| doc·ppt·odt·odp·rtf(옛 형식) | `soffice --headless --convert-to docx --outdir /opt/data/workspace/.tmp "<입력>"`(ppt·odp 는 `pptx`) 뒤 위 표대로 | |

- `kordoc` 은 docx 의 굵게·기울임 표시를 빼고 쓴다. 강조 표시가 중요하면 `markitdown` 을 쓴다.
- pptx 에서 슬라이드 경계(번호)가 필요하면 `markitdown` 을 쓴다(`<!-- Slide number: N -->` 를 넣는다).

```bash
mkdir -p /opt/data/workspace/output /opt/data/workspace/.tmp
kordoc "/opt/data/workspace/uploads/2026-10-27/보고서.docx" --no-images -o "/opt/data/workspace/output/보고서.md" --silent
```

## 결과 확인

- 결과가 비었거나 몇 줄뿐이면 PDF 는 글자층이 없는 스캔일 수 있다 — `pdftotext "<입력>.pdf" - | head` 로 보고, 비면 `ocr-to-markdown` 으로 넘긴다.
- xlsx 는 시트마다 표가 나온다. 시트가 많으면 시트 이름 목록과 각 시트의 앞부분만 보이고 전체는 파일로 준다.
- 큰 문서는 대화에 전부 붙이지 않는다. 파일로 쓴 뒤 목차·앞부분·요약만 보인다.

## 사용자에게 알리기

답 끝에 저장한 경로를 적고 「답 아래 파일 칩이나 대화 메뉴의 「파일」에서 내려받을 수 있습니다」라고 안내한다. `MEDIA:` 태그나 다운로드 주소를 만들지 않는다.

## 하지 않는 것

- 인터넷에서 변환기를 받지 않는다. `pip install`·`npm install` 을 하지 않는다(폐쇄망, 필요한 도구는 이미 있다).
- 원본 파일을 덮어쓰지 않는다. 스킬 폴더(`<스킬폴더>`)에 쓰지 않는다.
