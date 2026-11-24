/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// AAS ↔ MindWiki 를 탭 하나로 오가기(스펙 2026-11-23-019 L1~L5). 같은 규칙을 MindWiki 레포에도 둔다 — 시험 벡터(tabHash)를 두 레포가 같게 지킨다.
//
//  찾기 순서(L2): ① 이 탭이 앞서 연 상대 창 참조 → ② window.opener(ping/pong 으로 상대 제품인지 미리 확인) → ③ window.open('', 이름).
//  다른 출처의 탭은 「familiar with」 규칙 때문에 내가 연 창만 이름으로 찾을 수 있다. 반대 방향(나를 연 탭)은 ②가 맡는다.
//  주소를 바꿀 때는 이름으로 다시 열지 않고 찾은 참조에 location.href 를 넣는다(리뷰 spec3 5-1).
//  opener 로 옮길 때는 focus() 뒤 window.open('', 이름) 을 한 번 더 부른다 — Chrome 은 opener.focus() 를 막지만 이름으로 열면
//  opener 를 돌려주며 그 탭으로 넘어가고, 주소가 비어 다시 읽지 않는다(0단계 실측 2026-11-23, 리뷰의 「새 탭이 생긴다」는 Chrome 에서 틀렸다).
//  이미 있는 탭이면 주소를 바꾸지 않고 focus() 만(L3). 500ms 안에 내 탭이 숨겨지거나(blur 포함) 하지 않으면 전환이 막힌 것(L3a).

/** 탭 이름의 앞부분(L1). 뒤에 출처 해시를 붙여 한 브라우저에서 두 설치를 함께 써도 섞이지 않게 한다(리뷰 DX A5) */
export const AAS_TAB = 'cogentai-aas';
export const MINDWIKI_TAB = 'cogentai-mindwiki';
/** opener 확인 응답을 기다리는 시간과 전환 감지 시간(ms). 0단계 실측으로 바꿀 수 있게 한 곳에 둔다(리뷰 DX E3) */
export const PING_WAIT_MS = 300;
export const SWITCH_WAIT_MS = 500;

const PING = 'cogentai-ping';
const PONG = 'cogentai-pong';

/** 출처를 맞춘다: 끝 `/`·기본 포트·대소문자·경로를 없앤다. 틀린 주소면 빈 값(리뷰 Eng M1) */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** FNV-1a 32비트를 16진수 8자로. 동기 함수라 클릭 처리 안에서 써도 사용자 활성화가 끝나지 않는다(crypto.subtle 은 비동기) */
export function tabHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 그 제품 탭의 이름. base 는 AAS_TAB·MINDWIKI_TAB, url 은 그 제품의 주소(출처만 쓴다) */
export const tabName = (base: string, url: string): string => `${base}-${tabHash(originOf(url))}`;

let remembered: Window | null = null; // ① 이 탭이 연 상대 창
let openerPeer = false; // ② opener 가 상대 제품으로 확인됐는가
let peerOrigin = '';

/** 시험에서 상태를 비운다 */
export function resetProductTab(): void {
  remembered = null;
  openerPeer = false;
  peerOrigin = '';
}

/**
 * 앱 셸이 그려질 때 한 번(L1): 내 탭에 이름을 붙이고, 상대의 ping 에 답하고, opener 가 상대인지 미리 확인한다.
 * 위젯(useEmbed)·팝아웃·인쇄 창에서는 부르지 않는다 — 위젯은 MindWiki 창 안에서 돌아 이름·답을 붙이면 MindWiki 창이 AAS 로 보인다(리뷰 Eng M6).
 * 돌려주는 함수가 정리한다.
 */
export function startProductTab(selfBase: string, peerUrl: string): () => void {
  peerOrigin = originOf(peerUrl);
  if (!peerOrigin) return () => undefined;
  try {
    window.name = tabName(selfBase, window.location.origin);
  } catch {
    /* 이름을 못 붙이면 상대가 이름으로 찾지 못할 뿐이다 */
  }
  const onMessage = (e: MessageEvent) => {
    // 설정된 상대 출처에서, 내 opener 나 내가 연 창이 보낸 것만 받는다. ping/pong 말고는 아무 명령도 받지 않는다(리뷰 Eng L-a)
    if (e.origin !== peerOrigin || !e.data || typeof e.data !== 'object') return;
    const fromKnown = e.source !== null && (e.source === window.opener || e.source === remembered);
    if (!fromKnown) return;
    const type = (e.data as { type?: unknown }).type;
    if (type === PING) (e.source as Window).postMessage({ type: PONG }, peerOrigin);
    else if (type === PONG && e.source === window.opener) openerPeer = true;
  };
  const ping = () => {
    const op = window.opener as Window | null;
    if (!op || op.closed) {
      openerPeer = false;
      return;
    }
    try {
      op.postMessage({ type: PING }, peerOrigin); // 대상 출처를 지정하므로 다른 사이트의 opener 에는 전달되지 않는다
    } catch {
      openerPeer = false;
    }
  };
  // 누를 때가 아니라 미리 확인한다 — 누를 때 기다리면 브라우저의 일시 사용자 활성화가 끝나 창 열기·전환이 막힐 수 있다(리뷰 spec3 5-3)
  const onVisible = () => document.visibilityState === 'visible' && ping();
  window.addEventListener('message', onMessage);
  document.addEventListener('visibilitychange', onVisible);
  ping();
  return () => {
    window.removeEventListener('message', onMessage);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

/** focus() 뒤 내 탭이 숨겨지거나 창 초점을 잃었는가(L3a). 다른 창의 탭이면 visible 로 남고 blur 만 온다 */
export function watchSwitch(ms = SWITCH_WAIT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      window.removeEventListener('blur', onAway);
      document.removeEventListener('visibilitychange', onAway);
      clearTimeout(timer);
      resolve(ok);
    };
    const onAway = () => (document.visibilityState === 'hidden' || !document.hasFocus()) && finish(true);
    window.addEventListener('blur', onAway);
    document.addEventListener('visibilitychange', onAway);
    const timer = setTimeout(() => finish(false), ms);
  });
}

const alive = (w: Window | null): w is Window => {
  try {
    return !!w && !w.closed;
  } catch {
    return false;
  }
};

/** 새로 열린 빈 창인가(L3). 같은 출처의 다른 주소·읽기 오류(다른 출처)는 이미 있는 탭이다(리뷰 CEO-F2) */
function isBlank(w: Window): boolean {
  try {
    return w.location.href === 'about:blank';
  } catch {
    return false;
  }
}

export type TabResult =
  | { kind: 'opened' } // 새 탭을 열었다
  | { kind: 'focused' } // 이미 있는 탭으로 옮겼다
  | { kind: 'navigated' } // 이미 있는 탭의 주소를 바꾸고 옮겼다
  | { kind: 'blocked'; reopen?: () => Promise<TabResult> } // 전환이 막혔다. reopen 은 「그 탭에서 다시 열기」
  | { kind: 'refused' }; // 창을 받지 못했다(팝업 차단 등) — 탭 줄에서 고르라는 마지막 안내

function find(name: string): { win: Window | null; fresh: boolean } {
  if (alive(remembered)) return { win: remembered, fresh: false };
  const op = window.opener as Window | null;
  if (openerPeer && alive(op)) return { win: op, fresh: false };
  const win = window.open('', name); // noopener 를 주지 않는다 — 주면 이름으로 찾지 못한다(L2)
  if (!win) return { win: null, fresh: false };
  return { win, fresh: isBlank(win) };
}

/** 창을 앞으로. opener 면 이름으로 한 번 더 연다(위 머리말). opener 가 아닌 새 빈 창이 오면(이름이 다른 설치) 바로 닫는다 */
function raise(win: Window, name: string): void {
  try {
    win.focus();
  } catch {
    /* 막혀도 감지가 알린다 */
  }
  if (win !== window.opener) return;
  try {
    const got = window.open('', name);
    if (got && got !== win && isBlank(got)) got.close();
  } catch {
    /* 막혀도 감지가 알린다 */
  }
}

async function focusAndWatch(win: Window, name: string, onSwitched: TabResult, reopen?: () => Promise<TabResult>): Promise<TabResult> {
  const watching = watchSwitch();
  raise(win, name);
  return (await watching) ? onSwitched : { kind: 'blocked', reopen };
}

/**
 * 상대 제품 탭을 연다(L5). navigate=false(상단 단추): 이미 있으면 그 탭이 보던 화면을 바꾸지 않고 초점만.
 * navigate=true(저장 뒤 링크, L3b): 찾은 탭의 주소를 url 로 바꾼다. 어느 쪽이든 새 탭은 상대 탭이 없을 때 한 번만 생긴다.
 */
export async function openProductTab(url: string, peerBase: string, { navigate = false }: { navigate?: boolean } = {}): Promise<TabResult> {
  const name = tabName(peerBase, url);
  const { win, fresh } = find(name);
  if (!win) return { kind: 'refused' };
  if (fresh) {
    win.location.href = url;
    remembered = win;
    return { kind: 'opened' };
  }
  if (win !== window.opener) remembered = win;
  const go = (): Promise<TabResult> => {
    try {
      win.location.href = url; // 다른 출처의 창에도 주소 넣기는 된다
    } catch {
      return Promise.resolve({ kind: 'refused' });
    }
    return focusAndWatch(win, name, { kind: 'navigated' }).then((r) => (r.kind === 'blocked' ? { kind: 'refused' } : r));
  };
  if (navigate) return go();
  return focusAndWatch(win, name, { kind: 'focused' }, go);
}
