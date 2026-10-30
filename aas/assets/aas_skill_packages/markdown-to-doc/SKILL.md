---
name: markdown-to-doc
description: "Markdown 글을 hwpx(한글)·docx·pptx·xlsx·pdf·odt·html 파일로 만든다. 공문서 모양 hwpx(기안문·보고서 등)와 한글 서식 빈칸 채우기도 한다. / Turn Markdown into HWPX (Korean Hancom), DOCX, PPTX, XLSX, PDF, ODT or HTML files, including Korean official-document HWPX and form filling."
version: 1.1.1
author: OPENMARU, Inc.
license: Apache-2.0
metadata:
  hermes:
    tags: [markdown, hwpx, docx, pptx, xlsx, pdf, pandoc, kordoc, korean, convert]
    category: productivity
    related_skills: [hwp-to-markdown, doc-to-markdown, docx, xlsx, powerpoint, pdf]
---

# Markdown → 문서 파일

> `<스킬폴더>` 는 이 스킬을 불러올 때(`skill_view`) 받은 `skill_dir` 경로다(스킬 허브로 설치하면 프로파일마다 다르다). 스크립트가 종료 코드 6 으로 끝나거나 `kordoc`·`pandoc` 같은 명령이 없다(command not found)고 나오면 다시 시도하지 말고, 이 에이전트에 필요한 도구가 없다고 사용자에게 알린다.

## 언제 쓰나

- 사용자가 「hwpx 로 만들어 줘」「워드(docx)로 줘」「PDF 로 뽑아 줘」「엑셀로 정리해 줘」「발표 자료(pptx)로」라고 할 때.
- 먼저 내용을 Markdown 으로 쓰고(제목 `#`, 목록, 표, 코드 블록) 이 스킬로 파일을 만든다.
- 이미 있는 docx·xlsx·pptx 를 세밀하게 **고치는** 일(서식·변경 내용 추적·메모)은 번들 스킬 `docx`·`xlsx`·`powerpoint` 가 낫다.

## 파일 위치 (AAS)

- Markdown 원고와 중간 파일은 `/opt/data/workspace/.tmp/` 에 둔다(내려받기 칩에 섞이지 않는다).
- **결과 파일은 `/opt/data/workspace/output/` 에 쓴다**(없으면 만든다). 그래야 답 아래에 내려받기 칩이 붙는다. `/tmp`·`uploads/` 에 쓰면 사용자가 받지 못한다.
- 같은 이름이 있으면 덮지 말고 `-2`, `-3` 을 붙인다.

## 만드는 법

```bash
mkdir -p /opt/data/workspace/output /opt/data/workspace/.tmp
cd /opt/data/workspace
```

| 결과 | 명령 |
|---|---|
| docx | `pandoc .tmp/글.md -o output/결과.docx` (회사 서식: `--reference-doc 서식.docx`) |
| pptx | `pandoc .tmp/글.md -o output/결과.pptx` — `#`·`##` 제목이 슬라이드가 된다 (서식: `--reference-doc 서식.pptx`) |
| odt·html | `pandoc .tmp/글.md -o output/결과.odt` · `pandoc .tmp/글.md -s -o output/결과.html` |
| pdf(글·표·코드) | `pandoc .tmp/글.md -o output/결과.pdf --pdf-engine=xelatex -V mainfont='Noto Sans KR' -V monofont=NanumGothicCoding -V geometry:margin=2cm` |
| pdf(서식이 중요한 문서) | docx 를 만든 뒤 `soffice --headless --convert-to pdf --outdir output output/결과.docx` |
| hwpx(일반 문서) | `pypandoc-hwpx .tmp/글.md -o output/결과.hwpx` (서식: `--reference-doc 서식.hwpx`) |
| hwpx(공문서 모양) | `kordoc generate .tmp/글.md -o output/결과.hwpx --preset 보고서` — 프리셋: 기안문·보고서·계획서·통지·회의록·개조식·업무보고·보도자료. 부서 견본이 있으면 `--template 견본.hwpx` |
| hwpx 서식 빈칸 채우기 | 먼저 `kordoc fill 서식.hwpx --dry-run` 으로 칸 이름을 보고 `kordoc fill 서식.hwpx -f '성명=홍길동,전화=010-1234-5678' -o output/결과.hwpx`. 값이 많으면 `-j 값.json`. 같은 이름 칸이 여럿이면 `--require-unique` 로 잘못 채우기를 막는다. 내장 기안문은 `kordoc fill --template gian -f … -o …` |
| xlsx(표) | `python <스킬폴더>/scripts/md_to_xlsx.py .tmp/글.md output/결과.xlsx` — 표마다 시트 하나(GFM 표와 HTML 표 모두, HTML 표의 병합 칸은 엑셀 병합 칸), 시트 이름은 표 위 제목 |

- **Markdown 에 HTML 표(`<table>`, 병합 칸 `rowspan`·`colspan`)가 있으면** — OCR·HWP·문서 읽기(`ocr-to-markdown`·`hwp-to-markdown`·`doc-to-markdown`) 결과가 그렇다 — **pandoc·pypandoc-hwpx 에 Markdown 을 바로 주지 않는다.** 그러면 표가 통째로 빠진다. 먼저 HTML 을 만들고 그 HTML 을 준다(병합 칸까지 표로 남는다):

  ```bash
  pandoc .tmp/글.md -t html5 -s -o .tmp/글.html --metadata title=글
  pandoc .tmp/글.html -o output/결과.docx
  pandoc .tmp/글.html -o output/결과.pptx
  pypandoc-hwpx .tmp/글.html -o output/결과.hwpx
  ```

  - 공문서 모양 hwpx 는 지금처럼 `kordoc generate .tmp/글.md …` 로 만든다(병합 칸을 한글 표로 옮긴다). **hwpx 는 `kordoc generate` 로 만든다**가 기본이고, 일반 hwpx 가 필요할 때만 위 `pypandoc-hwpx .tmp/글.html`.
  - pptx 는 병합 칸이 풀린다(표와 값은 남는다). 병합이 중요하면 사용자에게 먼저 알린다.
  - docx·일반 hwpx 도 **머리글 칸(`<th>`)에서 아래 줄로 이어지는 세로 병합은 풀린다**(값은 남는다). 가로 병합과 본문 안 세로 병합은 남는다. 그 표의 병합이 중요하면 hwpx 는 `kordoc generate` 로, xlsx 는 `md_to_xlsx.py` 로 만든다(둘 다 그대로 옮긴다).
  - pdf 는 docx 를 만든 뒤 `soffice` 로 바꾼다(위 「pdf(서식이 중요한 문서)」). xelatex 길은 병합 칸을 잃는다.
  - xlsx 는 `md_to_xlsx.py` 가 HTML 표를 직접 읽어 엑셀 병합 칸으로 쓴다(HTML 을 만들 필요 없음).
  - **표를 Markdown 표로 다시 옮겨 적지 않는다** — 칸과 값이 빠진다.
- PDF 의 한글 글꼴은 Noto Sans KR, 코드는 나눔고딕코딩이다. 목차가 필요하면 `--toc` 를 더한다.
- `pypandoc-hwpx` 는 표준 출력에 `[Debug]` 줄을 찍는다. 무시해도 된다.
- `md_to_xlsx.py` 종료 코드 1 은 「표가 없음」, 2 는 「출력 파일이 이미 있음」이다(2 이면 지우지 말고 이름에 `-2`, `-3` 을 붙여 다시 실행한다). 숫자만 있는 칸은 숫자로, 앞자리 0·전화번호는 글자로 쓴다.

## 결과 확인

- 만든 파일이 있고 크기가 0 이 아닌지 본다(`ls -l output/결과.*`).
- 내용을 다시 읽어 본다: docx·pptx·xlsx 는 `markitdown output/결과.docx | head`, pdf 는 `pdftotext output/결과.pdf - | head`·`pdffonts output/결과.pdf`(Noto Sans KR 이 들어갔는지), hwpx 는 `kordoc output/결과.hwpx | head`.
- 한컴오피스·MS Office 에서 열린 모양은 여기서 볼 수 없다. 서식이 중요하면 사용자에게 열어 보고 알려 달라고 한다.

## 사용자에게 알리기

답 끝에 만든 파일 경로를 적고 「답 아래 파일 칩이나 대화 메뉴의 「파일」에서 내려받을 수 있습니다」라고 안내한다. `MEDIA:` 태그나 다운로드 주소를 만들지 않는다.

## 하지 않는 것

- 인터넷에서 변환기·글꼴·LaTeX 묶음을 받지 않는다. `pip install`·`npm install`·`tlmgr install` 을 하지 않는다(폐쇄망, 필요한 도구는 이미 있다).
- 사용자가 준 서식·견본 파일을 덮어쓰지 않는다. 스킬 폴더(`<스킬폴더>`)에 쓰지 않는다.
