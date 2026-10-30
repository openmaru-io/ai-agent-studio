/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 가구 모델과 글꼴. Vite 가 내용 해시가 붙은 파일로 /assets/ 에 내므로 서버의 불변 캐시를 그대로 쓰고, 외부 주소가 없다.

// 모델: Kenney Furniture Kit 2.0(CC0, 원본과 바이트까지 같음을 2026-10-13 확인)과 화분 4개는 Kenney Nature Kit 2.1(CC0). 출처는 THIRD_PARTY_NOTICES.md 에 적었다.

import cactusShort from './assets/models/cactus_short.glb?url';
import cactusTall from './assets/models/cactus_tall.glb?url';
import bookcaseClosed from './assets/models/bookcaseClosed.glb?url';
import bookcaseClosedDoors from './assets/models/bookcaseClosedDoors.glb?url';
import bookcaseClosedWide from './assets/models/bookcaseClosedWide.glb?url';
import chairDesk from './assets/models/chairDesk.glb?url';
import chairModernCushion from './assets/models/chairModernCushion.glb?url';
import coatRackStanding from './assets/models/coatRackStanding.glb?url';
import computerScreen from './assets/models/computerScreen.glb?url';
import desk from './assets/models/desk.glb?url';
import deskCorner from './assets/models/deskCorner.glb?url';
import kitchenCabinet from './assets/models/kitchenCabinet.glb?url';
import kitchenCoffeeMachine from './assets/models/kitchenCoffeeMachine.glb?url';
import kitchenFridgeSmall from './assets/models/kitchenFridgeSmall.glb?url';
import kitchenMicrowave from './assets/models/kitchenMicrowave.glb?url';
import lampRoundFloor from './assets/models/lampRoundFloor.glb?url';
import loungeDesignChair from './assets/models/loungeDesignChair.glb?url';
import loungeSofa from './assets/models/loungeSofa.glb?url';
import paneling from './assets/models/paneling.glb?url';
import plantSmall1 from './assets/models/plantSmall1.glb?url';
import pottedPlant from './assets/models/pottedPlant.glb?url';
import rugRectangle from './assets/models/rugRectangle.glb?url';
import table from './assets/models/table.glb?url';
import tableCoffee from './assets/models/tableCoffee.glb?url';
import tableRound from './assets/models/tableRound.glb?url';
import televisionModern from './assets/models/televisionModern.glb?url';
import treePalmShort from './assets/models/tree_palmShort.glb?url';
import treeSmall from './assets/models/tree_small.glb?url';
import balloon from './assets/models/balloon.glb?url';
import fontUrl from './assets/fonts/NotoSansKR-Regular-subset.woff?url';

export const FONT_URL: string = fontUrl;
/** 부서 현수막의 애드벌룬(CC BY 3.0, THIRD_PARTY_NOTICES.md). 가구 목록(MODEL_URL)과 따로 둔다. */
export const BALLOON_URL: string = balloon;
export const MODEL_URL: Record<string, string> = {
  bookcaseClosed: bookcaseClosed,
  bookcaseClosedDoors: bookcaseClosedDoors,
  bookcaseClosedWide: bookcaseClosedWide,
  chairDesk: chairDesk,
  chairModernCushion: chairModernCushion,
  coatRackStanding: coatRackStanding,
  computerScreen: computerScreen,
  desk: desk,
  deskCorner: deskCorner,
  kitchenCabinet: kitchenCabinet,
  kitchenCoffeeMachine: kitchenCoffeeMachine,
  kitchenFridgeSmall: kitchenFridgeSmall,
  kitchenMicrowave: kitchenMicrowave,
  lampRoundFloor: lampRoundFloor,
  loungeDesignChair: loungeDesignChair,
  loungeSofa: loungeSofa,
  paneling: paneling,
  plantSmall1: plantSmall1,
  pottedPlant: pottedPlant,
  rugRectangle: rugRectangle,
  table: table,
  tableCoffee: tableCoffee,
  tableRound: tableRound,
  televisionModern: televisionModern,
  // 화분 종류를 늘렸다(2026-10-16, Kenney Nature Kit 2.1 CC0)
  cactusShort: cactusShort,
  cactusTall: cactusTall,
  treePalmShort: treePalmShort,
  treeSmall: treeSmall,
};
