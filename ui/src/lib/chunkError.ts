/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 다시 배포 뒤 옛 묶음(assets/<이름>-<해시>.js)을 받지 못한 오류 가리기와 한 번 새로 고치기.
// 문서 뷰어(DocBody, 스펙 2026-10-20-005 리뷰 D12)·화면 오류 경계(ScreenBoundary)·3D 장면 경계(SceneBoundary)가 함께 쓴다.

/** 동적 import 실패 문구(브라우저마다 다르다). 이 경우는 새 버전이 배포되어 옛 묶음이 지워진 것이다 */
export function isChunkError(e: unknown, depth = 0): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  if (/dynamically imported module|Importing a module script failed|error loading dynamically imported|Failed to fetch module|ChunkLoadError/i.test(msg)) return true;
  // 감싼 오류(cause)도 본다 — 번들러·시험 도구가 import 실패를 한 번 감싼다
  return depth < 3 && e instanceof Error && e.cause != null && isChunkError(e.cause, depth + 1);
}

/** 시험이 바꿔 끼운다(jsdom 의 location.reload 는 바꿀 수 없다) */
export const page = { reload: () => window.location.reload() };

export const RELOAD_KEY = 'aas.newVersionReloadAt';
export const RELOAD_GAP_MS = 30_000;

/** 새로 고칠 수 있을 때까지 남은 시간(ms). 0 이면 지금 새로 고칠 수 있다. 저장소를 쓸 수 없으면 null(횟수를 셀 수 없어 새로 고치지 않는다) */
export function reloadWait(now = Date.now()): number | null {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    return Math.max(0, last + RELOAD_GAP_MS + 1 - now);
  } catch {
    return null;
  }
}

/** 새 index.html 을 받도록 새로 고친다. 30초 안에 이미 새로 고쳤으면(배포 중 옛·새 파드가 섞여 또 실패) 하지 않는다.
 *  새로 고쳤으면 참. 화면 오류 경계는 거짓이면 reloadWait 만큼 기다렸다 다시 부른다(30초마다 다시 시도) */
export function reloadOnce(now = Date.now()): boolean {
  if (reloadWait(now) !== 0) return false;
  try {
    sessionStorage.setItem(RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  page.reload();
  return true;
}

/** 새로 고칠 수 있으면 지금, 아니면 남은 시간 뒤에 다시 해 본다(배포가 끝나면 열린다). 저장소를 쓸 수 없으면 멈춘다. 돌려준 함수로 그친다 */
export function keepReloading(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    if (reloadOnce()) return;
    const wait = reloadWait();
    if (wait) timer = setTimeout(run, wait);
  };
  run();
  return () => clearTimeout(timer);
}
