/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  balloonSpan,
  bandHeight,
  BANNER_ROTATE_MS,
  bannerFrame,
  bannerShift,
  fitOverview,
  layoutBanner,
  orderBanners,
  pickBanner,
  readBannerOff,
  screenAxes,
  splitTwo,
  writeBannerOff,
} from './banner';

const B = (team: string, goal = team + ' 문구') => ({ team, goal });

describe('현수막 문구 고르기(스펙 2026-10-15-018)', () => {
  it('문구가 없으면 null, 하나면 그대로', () => {
    expect(pickBanner([], '개발', 0, false)).toBeNull();
    expect(pickBanner([B('개발')], '', 99999, false)?.team).toBe('개발');
  });

  it('내 부서를 맨 앞에 두고 나머지는 주어진 순서를 지킨다', () => {
    expect(orderBanners([B('개발'), B('기획'), B('영업')], '영업').map((b) => b.team)).toEqual(['영업', '개발', '기획']);
    expect(orderBanners([B('개발'), B('기획')], '').map((b) => b.team)).toEqual(['개발', '기획']);
  });

  it('둘 이상이면 12초마다 다음 부서로 돌아간다', () => {
    const list = [B('개발'), B('기획'), B('영업')];
    const at = (n: number) => pickBanner(list, '기획', n * BANNER_ROTATE_MS + 1, false)?.team;
    expect([at(0), at(1), at(2), at(3)]).toEqual(['기획', '개발', '영업', '기획']);
  });

  it('움직임 줄이기가 켜져 있으면 돌리지 않고 내 부서(없으면 첫 부서)를 고정한다', () => {
    const list = [B('개발'), B('기획')];
    expect([0, 12_001, 30_000].map((n) => pickBanner(list, '기획', n, true)?.team)).toEqual(['기획', '기획', '기획']);
    expect(pickBanner(list, '', 60_000, true)?.team).toBe('개발');
  });
});

describe('처음 구도: 건물 위에 띠를 남긴다', () => {
  const pos: [number, number, number] = [14, 16, 18];
  const target: [number, number, number] = [0, 0, 1];
  const corners: [number, number, number][] = [];
  for (const x of [-16, 16]) for (const z of [-10, 10]) for (const y of [0, 1.5]) corners.push([x, y, z]);

  it('카메라 축: 오른쪽·위쪽은 서로 수직이고 위쪽은 세계의 위를 향한다', () => {
    const { right, up } = screenAxes(pos, target);
    expect(Math.abs(right[0] * up[0] + right[1] * up[1] + right[2] * up[2])).toBeLessThan(1e-9);
    expect(up[1]).toBeGreaterThan(0);
  });

  it('넓은 캔버스에서는 처음 확대를 줄이지 않고, 좁은 캔버스에서는 건물이 띠 아래에 들어오게 줄인다', () => {
    const big = fitOverview({ corners, pos, target, canvasW: 3000, canvasH: 1800, baseZoom: 20 });
    expect(big.zoom).toBe(20);
    const small = fitOverview({ corners, pos, target, canvasW: 1120, canvasH: 670, baseZoom: 40 });
    expect(small.zoom).toBeLessThan(40);
    // 줄인 확대에서 건물의 화면 높이가 (캔버스 − 띠 − 틈 − 여백) 이하다
    const { up } = screenAxes(pos, target);
    const ys = corners.map((c) => (c[0] - target[0]) * up[0] + (c[1] - target[1]) * up[1] + (c[2] - target[2]) * up[2]);
    const h = (Math.max(...ys) - Math.min(...ys)) * small.zoom;
    expect(h).toBeLessThanOrEqual(670 - bandHeight(670) - 670 * 0.02 - 670 * 0.02 + 1e-6);
  });

  it('카메라를 옮긴 뒤 건물의 위 모서리가 띠(+틈) 아래에 있다', () => {
    const f = fitOverview({ corners, pos, target, canvasW: 1120, canvasH: 670, baseZoom: 40 });
    const { up } = screenAxes(pos, target);
    const top = Math.max(...corners.map((c) => (c[0] - target[0]) * up[0] + (c[1] - target[1]) * up[1] + (c[2] - target[2]) * up[2]));
    const topPx = (top - f.shiftUp) * f.zoom; // 캔버스 가운데 기준, 위가 +
    expect(335 - topPx).toBeGreaterThanOrEqual(bandHeight(670) + 670 * 0.02 - 1e-6); // 캔버스 위쪽에서 건물까지의 거리
  });
});

describe('천 안의 글자 배치', () => {
  it('짧은 문구는 한 줄 큰 글자, 천 폭은 캔버스 폭의 60% 이하', () => {
    const l = layoutBanner('고객이 먼저 쓰는 제품', 1400, 800);
    expect(l.lines).toEqual(['고객이 먼저 쓰는 제품']);
    expect(l.clothW).toBeLessThanOrEqual(1400 * 0.6);
    expect(l.clothH).toBeLessThanOrEqual(bandHeight(800));
  });

  it('긴 문구는 줄이고, 그래도 넘치면 두 줄로 나누며, 어떤 경우에도 폭 안에 든다', () => {
    const long = '우리는 고객이 가장 먼저 찾는 제품을 만들고 끝까지 책임진다 그리고 함께 자란다 ok';
    const l = layoutBanner(long, 900, 600);
    expect(l.lines.length).toBeGreaterThanOrEqual(1);
    expect(l.clothW).toBeLessThanOrEqual(900 * 0.6 + 1);
    expect(l.fontPx).toBeGreaterThanOrEqual(12);
  });

  it('두 줄 나누기는 가운데 띄어쓰기를 쓴다', () => {
    expect(splitTwo('가나다 라마바사 아')).toEqual(['가나다', '라마바사 아']);
    expect(splitTwo('가나다라마바')).toEqual(['가나다', '라마바']);
  });
});

describe('현수막의 가로 배치(명단 상자를 피한다)', () => {
  it('짧은 문구는 넓은 캔버스에서 가운데에 두고, 좁은 캔버스에서는 명단 상자 왼쪽으로 옮겨 전체가 그 안에 든다', () => {
    const { extra } = balloonSpan(850);
    expect(bannerShift(1640, 850, 570)).toBe(0);
    const w = 1120;
    const f = bannerFrame(w, 670);
    const total = f.maxCloth + balloonSpan(670).extra;
    const shift = bannerShift(w, 670, f.maxCloth);
    expect(shift).toBeLessThan(0);
    expect(w / 2 + shift + total / 2).toBeLessThanOrEqual(w - 332);
    expect(w / 2 + shift - total / 2).toBeGreaterThanOrEqual(0);
    expect(extra).toBeGreaterThan(0);
  });

  it('긴 문구도 천 폭이 최대 폭을 넘지 않고, 최대 폭은 캔버스 폭의 60% 이하다', () => {
    for (const [w, h] of [[1120, 670], [1640, 850], [700, 600]]) {
      const l = layoutBanner('우리는 고객이 가장 먼저 찾는 제품을 만든다', w, h);
      expect(l.clothW).toBeLessThanOrEqual(bannerFrame(w, h).maxCloth + 1);
      expect(bannerFrame(w, h).maxCloth).toBeLessThanOrEqual(w * 0.6 + 1);
    }
  });
});

describe('끄기 선택', () => {
  beforeEach(() => localStorage.clear());
  it('이 브라우저에 기억하고, 저장소를 못 써도 깨지지 않는다', () => {
    expect(readBannerOff()).toBe(false);
    writeBannerOff(true);
    expect(readBannerOff()).toBe(true);
    writeBannerOff(false);
    expect(readBannerOff()).toBe(false);
    const spy = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', { get: () => { throw new Error('blocked'); }, configurable: true });
    expect(readBannerOff()).toBe(false);
    expect(() => writeBannerOff(true)).not.toThrow();
    if (spy) Object.defineProperty(window, 'localStorage', spy);
  });
});
