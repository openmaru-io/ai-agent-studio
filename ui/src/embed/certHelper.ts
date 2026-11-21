/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// https 사설 인증서 안내(OMAI-1873). CogentAI 위젯(cogentai-ui/widget 의 utils/certHelper.ts·wsMiddleware 의
// handleCertificateApproval)과 같은 흐름이다: 안내 창 → 단추를 누른 순간 새 창 → no-cors 로 다시 시도 → 되면 새 창을 닫고 다시 연결.
// 다른 점은 둘이다.
//  - 원인을 먼저 가린다. 다른 출처 요청은 CORS 거절도 인증서 오류와 같은 TypeError 로 보인다. no-cors 요청은 CORS 검사를 받지 않으므로
//    no-cors /healthz 가 실패할 때만 인증서·네트워크 문제로 보고 안내 창을 띄운다.
//  - 새 창은 로그인 화면으로 넘어가지 않는 /embed/cert 를 연다. 다시 시도는 /healthz 로 한다.
// 안내 창은 페이지마다 한 번만 띄우고, 떠 있는 동안 또 띄우지 않는다.
import { t } from '@/i18n';

export const POLL_START_MS = 500;
export const POLL_MAX_MS = 3000;
export const POLL_GROWTH = 1.5;
export const POLL_MAX_TRIES = 40;

let certChecked = false;
let modalOpen = false;

/** 페이지마다 한 번만 묻는다. resetUserSession 이 지운다 */
export function resetCertCheck(): void {
  certChecked = false;
}

export const certPromptAllowed = (): boolean => !certChecked && !modalOpen;

/** CORS 검사 없이 AAS 에 닿는가(no-cors 는 응답을 읽을 수 없지만, 인증서·네트워크 오류면 reject 된다) */
export async function probeReachable(backendUrl: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    await fetchImpl(`${backendUrl}/healthz`, { method: 'GET', mode: 'no-cors', cache: 'no-store', credentials: 'omit' });
    return true;
  } catch {
    return false;
  }
}

/** 응답 없는 실패의 원인. cert: https 인데 no-cors 도 안 됨(인증서), unreachable: http 인데 안 됨(네트워크), cors: no-cors 는 됨(사전 요청·출처 설정) */
export async function diagnoseNoResponse(backendUrl: string, fetchImpl: typeof fetch = fetch): Promise<'cert' | 'unreachable' | 'cors'> {
  if (await probeReachable(backendUrl, fetchImpl)) return 'cors';
  return backendUrl.startsWith('https:') ? 'cert' : 'unreachable';
}

export interface CertDeps {
  fetchImpl?: typeof fetch;
  openWindow?: (url: string, name: string, features: string) => Window | null;
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (id: ReturnType<typeof setTimeout>) => void;
}

export interface CertResult {
  approved: boolean;
}

const css = {
  backdrop:
    'position:absolute;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:10000;font-family:inherit;',
  panel:
    'background:#ffffff;color:#1f1f1f;padding:24px;border-radius:12px;width:90%;max-width:420px;box-shadow:0 12px 48px rgba(0,0,0,.25);box-sizing:border-box;',
  title: 'margin:0 0 12px;font-size:17px;font-weight:700;line-height:1.4;text-align:center;',
  text: 'margin:0 0 20px;font-size:13px;line-height:1.75;color:#4b5563;text-align:center;',
  status: 'display:none;margin:0 0 16px;padding:10px;border-radius:8px;background:#f3f4f6;font-size:13px;text-align:center;',
  row: 'display:flex;gap:8px;justify-content:center;',
  cancel: 'padding:6px 16px;background:transparent;color:#374151;border:1px solid #d1d5db;border-radius:6px;cursor:pointer;font:inherit;font-size:13px;',
  approve: 'padding:6px 16px;background:#111827;color:#f7f8f8;border:1px solid #111827;border-radius:6px;cursor:pointer;font:inherit;font-size:13px;font-weight:600;',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style: string, text = ''): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.style.cssText = style;
  if (text) n.textContent = text;
  return n;
}

/** 안내 창을 container(Shadow DOM 안)에 띄우고, 사용자가 인증서를 받아들일 때까지 기다린다. 이미 물었거나 떠 있으면 바로 거짓 */
export function promptCertApproval(backendUrl: string, container: HTMLElement | ShadowRoot, deps: CertDeps = {}): Promise<CertResult> {
  if (!certPromptAllowed()) return Promise.resolve({ approved: false });
  const fetchImpl = deps.fetchImpl ?? fetch;
  const open = deps.openWindow ?? ((u, n, f) => window.open(u, n, f));
  const later = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancelTimer = deps.clearTimeout ?? ((id) => clearTimeout(id));
  modalOpen = true;
  return new Promise((resolve) => {
    const back = el('div', css.backdrop);
    back.setAttribute('data-testid', 'aas-cert-modal');
    const panel = el('div', css.panel);
    panel.setAttribute('role', 'alertdialog');
    panel.setAttribute('aria-modal', 'true');
    const title = el('h2', css.title, t('embed.cert.title'));
    title.id = 'aas-cert-title';
    panel.setAttribute('aria-labelledby', title.id);
    const text = el('p', css.text);
    text.id = 'aas-cert-text';
    panel.setAttribute('aria-describedby', text.id);
    for (const [i, line] of [t('embed.cert.problem'), t('embed.cert.step1'), t('embed.cert.step2')].entries()) {
      if (i) text.appendChild(document.createElement('br'));
      text.appendChild(document.createTextNode(line));
    }
    const status = el('div', css.status);
    status.setAttribute('role', 'status');
    const row = el('div', css.row);
    const cancel = el('button', css.cancel, t('embed.cert.cancel'));
    cancel.type = 'button';
    const approve = el('button', css.approve, t('embed.cert.setup'));
    approve.type = 'button';
    row.append(cancel, approve);
    panel.append(title, text, status, row);
    back.appendChild(panel);
    container.appendChild(back);
    approve.focus();

    let timer: ReturnType<typeof setTimeout> | null = null;
    let win: Window | null = null;
    let done = false;
    const finish = (approved: boolean) => {
      if (done) return;
      done = true;
      if (timer) cancelTimer(timer);
      if (win && !win.closed) win.close();
      back.remove();
      modalOpen = false;
      if (approved) certChecked = true;
      resolve({ approved });
    };
    // 포커스를 창 안에 가둔다(Tab·Shift+Tab 은 두 단추 사이를 돈다), Esc 는 취소
    back.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const list = [cancel, approve].filter((b) => !b.disabled);
        const root = container instanceof ShadowRoot ? container : container.getRootNode();
        const active = (root as Document | ShadowRoot).activeElement;
        const at = list.indexOf(active as HTMLButtonElement);
        list[(at + (e.shiftKey ? -1 : 1) + list.length) % list.length]?.focus();
      }
    });
    cancel.onclick = () => finish(false);
    approve.onclick = () => {
      // 단추를 누른 그 순간에 연다 — 늦게 열면 팝업 차단에 걸린다
      const w = 700;
      const h = 550;
      const left = Math.max(0, (window.screen.width - w) / 2);
      const top = Math.max(0, (window.screen.height - h) / 2);
      win = open(`${backendUrl}/embed/cert`, '_blank', `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=yes`);
      text.style.display = 'none';
      status.style.display = 'block';
      status.textContent = t('embed.cert.waiting');
      approve.disabled = true;
      approve.style.opacity = '0.5';
      approve.style.cursor = 'not-allowed';
      cancel.textContent = t('embed.cert.close');
      cancel.focus();
      let tries = 0;
      let delay = POLL_START_MS;
      const poll = async () => {
        timer = null;
        tries += 1;
        if (await probeReachable(backendUrl, fetchImpl)) {
          if (done) return;
          status.textContent = t('embed.cert.success');
          if (win && !win.closed) win.close();
          timer = later(() => finish(true), 800);
          return;
        }
        if (done) return;
        if (tries >= POLL_MAX_TRIES) {
          status.textContent = t('embed.cert.timeout');
          approve.disabled = false;
          approve.style.opacity = '1';
          approve.style.cursor = 'pointer';
          if (win && !win.closed) win.close();
          return;
        }
        delay = Math.min(delay * POLL_GROWTH, POLL_MAX_MS);
        timer = later(() => void poll(), delay);
      };
      timer = later(() => void poll(), delay);
    };
  });
}
