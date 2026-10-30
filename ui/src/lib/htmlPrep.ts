/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// HTML 파일 「보기」 전에 문서를 정리한다(스펙 2026-10-20-002 §3-5 HTML 줄 ①~⑤, 리뷰 R5). 빈 sandbox 와 CSP 는 iframe 자기 이동을
// 막지 못하므로 이동 요소(meta refresh·base·링크·폼 action)와 스크립트·on* 속성을 지우고, 맨 앞에 바깥 요청을 막는 CSP 를 넣는다.

export const VIEW_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

export function prepareHtml(source: string): string {
  const doc = new DOMParser().parseFromString(source, 'text/html');
  doc.querySelectorAll('script, base, meta[http-equiv], iframe, frame, object, embed, link').forEach((el) => el.remove());
  doc.querySelectorAll('a[href], area[href]').forEach((el) => el.removeAttribute('href'));
  doc.querySelectorAll('form').forEach((el) => el.removeAttribute('action'));
  doc.querySelectorAll('*').forEach((el) => {
    for (const a of Array.from(el.attributes)) {
      const name = a.name.toLowerCase();
      if (name.startsWith('on') || name === 'formaction' || name === 'srcdoc' || name === 'ping') el.removeAttribute(a.name);
      else if ((name === 'src' || name === 'srcset' || name === 'poster' || name === 'background') && !/^data:/i.test(a.value)) el.removeAttribute(a.name);
    }
  });
  const meta = doc.createElement('meta');
  meta.setAttribute('http-equiv', 'Content-Security-Policy');
  meta.setAttribute('content', VIEW_CSP);
  doc.head.prepend(meta);
  return '<!doctype html>' + doc.documentElement.outerHTML;
}
