"use client";

import { memo, type ReactNode } from "react";
import { northRoomWallCenters, southLoungePictureX } from "@/features/office/scene3d/retro-office/core/aasKoreanOffice";
import { BASEBOARD, baseboardOffset } from "@/features/office/scene3d/retro-office/core/baseboard";
import {
  AAS_OUTER_WALL_THICKNESS,
  CANVAS_H,
  CANVAS_W,
  EAST_WING_ROOM_HEIGHT,
  EAST_WING_ROOM_TOP_Y,
  GYM_ROOM_WIDTH,
  GYM_ROOM_X,
  QA_LAB_WIDTH,
  QA_LAB_X,
  SCALE,
} from "@/features/office/scene3d/retro-office/core/constants";
import {
  CITY_PATH_ZONE,
  LOCAL_OFFICE_CANVAS_HEIGHT,
  LOCAL_OFFICE_CANVAS_WIDTH,
  REMOTE_OFFICE_ZONE,
} from "@/features/office/scene3d/retro-office/core/district";
import { toWorld } from "@/features/office/scene3d/retro-office/core/geometry";
import { useScenePalette } from "@/features/office/scenePaletteContext";
import { artTone } from "@/features/office/tokens";

function FramedPicture({
  position,
  rotY = 0,
  w = 0.52,
  h = 0.38,
  frameColor = "#1c1008",
  bgColor = "#f0ece0",
  art,
}: {
  position: [number, number, number];
  rotY?: number;
  w?: number;
  h?: number;
  frameColor?: string;
  bgColor?: string;
  art: ReactNode;
}) {
  const frameDepth = 0.028;
  const inset = 0.038;
  const artZ = frameDepth / 2 + 0.007;

  return (
    <group position={position} rotation={[0, rotY, 0]}>
      <mesh>
        <boxGeometry args={[w, h, frameDepth]} />
        <meshStandardMaterial
          color={frameColor}
          roughness={0.75}
          metalness={0.18}
        />
      </mesh>
      <mesh position={[0, 0, frameDepth / 2 + 0.003]}>
        <boxGeometry args={[w - inset * 2, h - inset * 2, 0.005]} />
        <meshStandardMaterial color={bgColor} roughness={0.95} metalness={0} />
      </mesh>
      <group position={[0, 0, artZ]}>{art}</group>
    </group>
  );
}


// AAS(2026-10-26-004): 탕비실 안쪽 벽 면(장면 픽셀, core/aasKoreanOffice.ts 의 탕비실 벽 + 두께 8)과
// 액자를 벽 면에서 띄우는 거리(월드, 액자 두께 0.028 의 반보다 조금 크게 — 벽 속에 묻히지 않게)
// kr-19(2026-10-26-005): 북쪽 벽은 TFT 회의실 3 의 남쪽 벽(720). kr-18 까지는 870. 서쪽 벽(1520)은 kr-20 에서 유리벽이 되어 액자를 걸지 않는다
const PANTRY_NORTH_FACE = 728;
const PICTURE_OFF_WALL = 0.016;

// AAS: 헬스장(DEFAULT_GYM_ITEMS)을 기본 배치에서 뺐다(계획 007, 2026-10-12).
const AAS_DRAW_GYM_FLOOR = false;
// AAS: 한국 사무실 배치(계획 2026-10-13-001 §3-3)에는 QA 실험실이 없다 — 그 자리의 남색 바닥 무늬를 그리지 않는다
const AAS_DRAW_QA_FLOOR = false;
export const FloorAndWalls = memo(function FloorAndWalls({
  showRemoteOffice = true,
}: {
  showRemoteOffice?: boolean;
}) {
  const { palette } = useScenePalette();
  const districtWidth = CANVAS_W * SCALE;
  const districtHeight = CANVAS_H * SCALE;
  const localOfficeWidth = LOCAL_OFFICE_CANVAS_WIDTH * SCALE;
  const localOfficeHeight = LOCAL_OFFICE_CANVAS_HEIGHT * SCALE;
  const [districtCenterX, , districtCenterZ] = toWorld(CANVAS_W / 2, CANVAS_H / 2);
  const [localOfficeCenterX, , localOfficeCenterZ] = toWorld(
    LOCAL_OFFICE_CANVAS_WIDTH / 2,
    LOCAL_OFFICE_CANVAS_HEIGHT / 2,
  );
  const [gymZoneCenterX, , roomZoneCenterZ] = toWorld(
    GYM_ROOM_X + GYM_ROOM_WIDTH / 2,
    EAST_WING_ROOM_TOP_Y + EAST_WING_ROOM_HEIGHT / 2,
  );
  const [qaZoneCenterX] = toWorld(
    QA_LAB_X + QA_LAB_WIDTH / 2,
    EAST_WING_ROOM_TOP_Y + EAST_WING_ROOM_HEIGHT / 2,
  );
  const [pathCenterX, , pathCenterZ] = toWorld(
    (CITY_PATH_ZONE.minX + CITY_PATH_ZONE.maxX) / 2,
    (CITY_PATH_ZONE.minY + CITY_PATH_ZONE.maxY) / 2,
  );
  const [, , remoteOfficeCenterZ] = toWorld(
    (REMOTE_OFFICE_ZONE.minX + REMOTE_OFFICE_ZONE.maxX) / 2,
    (REMOTE_OFFICE_ZONE.minY + REMOTE_OFFICE_ZONE.maxY) / 2,
  );
  const gymZoneWidth = Math.max(0, GYM_ROOM_WIDTH * SCALE);
  const qaZoneWidth = Math.max(0, QA_LAB_WIDTH * SCALE);
  const roomZoneHeight = EAST_WING_ROOM_HEIGHT * SCALE;
  const roomFloorInset = 0.08;
  const roomZoneFloorHeight = Math.max(0, roomZoneHeight - roomFloorInset * 2);
  const gymZoneFloorWidth = Math.max(0, gymZoneWidth - roomFloorInset * 2);
  const qaZoneFloorWidth = Math.max(0, qaZoneWidth - roomFloorInset * 2);
  const qaZoneStripeHeight = roomZoneFloorHeight * 0.86;
  const qaZoneStripeWidth = qaZoneFloorWidth * 0.92;
  const remoteOfficeOffsetZ = remoteOfficeCenterZ - localOfficeCenterZ;
  const localNorthWallZ = localOfficeCenterZ - localOfficeHeight / 2;
  const localSouthWallZ = localOfficeCenterZ + localOfficeHeight / 2;
  const localWestWallX = localOfficeCenterX - localOfficeWidth / 2;
  const localEastWallX = localOfficeCenterX + localOfficeWidth / 2;
  const groundCenterX = showRemoteOffice ? districtCenterX : localOfficeCenterX;
  const groundCenterZ = showRemoteOffice ? districtCenterZ : localOfficeCenterZ;
  const groundWidth = showRemoteOffice ? districtWidth : localOfficeWidth;
  const groundHeight = showRemoteOffice ? districtHeight : localOfficeHeight;

  const bbOffset = baseboardOffset(AAS_OUTER_WALL_THICKNESS);

  return (
    <group>
      <mesh
        position={[groundCenterX, -0.015, groundCenterZ]}
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow
      >
        <planeGeometry args={[groundWidth, groundHeight, 24, 14]} />
        <meshStandardMaterial color="#263238" roughness={0.98} metalness={0.02} />
      </mesh>

      <mesh
        position={[groundCenterX, -0.012, groundCenterZ]}
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow
      >
        <planeGeometry args={[groundWidth * 0.95, groundHeight * 0.9]} />
        <meshStandardMaterial color="#1b232a" roughness={0.96} metalness={0.04} />
      </mesh>

      <mesh
        position={[localOfficeCenterX, 0, localOfficeCenterZ]}
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow
      >
        <planeGeometry args={[localOfficeWidth, localOfficeHeight, 22, 14]} />
        <meshLambertMaterial color={palette.floor} />
      </mesh>

      {showRemoteOffice ? (
        <>
          <mesh
            position={[localOfficeCenterX, 0, localOfficeCenterZ + remoteOfficeOffsetZ]}
            rotation={[-Math.PI / 2, 0, 0]}
            receiveShadow
          >
            <planeGeometry args={[localOfficeWidth, localOfficeHeight, 22, 14]} />
            <meshLambertMaterial color={palette.floor} />
          </mesh>

          <mesh
            position={[pathCenterX, 0.002, pathCenterZ]}
            rotation={[-Math.PI / 2, 0, 0]}
            receiveShadow
          >
            <planeGeometry
              args={[
                (CITY_PATH_ZONE.maxX - CITY_PATH_ZONE.minX) * SCALE,
                (CITY_PATH_ZONE.maxY - CITY_PATH_ZONE.minY) * SCALE,
              ]}
            />
            <meshStandardMaterial color="#6d8b5a" roughness={0.96} metalness={0.02} />
          </mesh>

          <mesh
            position={[pathCenterX, 0.004, pathCenterZ]}
            rotation={[-Math.PI / 2, 0, 0]}
            receiveShadow
          >
            <planeGeometry
              args={[
                (CITY_PATH_ZONE.maxX - CITY_PATH_ZONE.minX) * SCALE * 0.72,
                (CITY_PATH_ZONE.maxY - CITY_PATH_ZONE.minY) * SCALE * 0.26,
              ]}
            />
            <meshStandardMaterial color="#c9ae8d" roughness={0.94} metalness={0.02} />
          </mesh>

          {Array.from({ length: 8 }).map((_, index) => {
            const [wx, , wz] = toWorld(330 + index * 170, 820 + (index % 2 === 0 ? -44 : 44));
            return (
              <mesh key={`garden-bed-${index}`} position={[wx, 0.03, wz]} castShadow receiveShadow>
                <boxGeometry args={[0.58, 0.06, 0.18]} />
                <meshStandardMaterial color="#5d4037" roughness={0.84} metalness={0.06} />
              </mesh>
            );
          })}

          {Array.from({ length: 8 }).map((_, index) => {
            const [wx, , wz] = toWorld(330 + index * 170, 820 + (index % 2 === 0 ? -44 : 44));
            return (
              <mesh key={`garden-bed-top-${index}`} position={[wx, 0.09, wz]}>
                <boxGeometry args={[0.48, 0.05, 0.12]} />
                <meshStandardMaterial color="#7cb342" roughness={0.98} metalness={0} />
              </mesh>
            );
          })}

          {Array.from({ length: 6 }).map((_, index) => {
            const [wx, , wz] = toWorld(420 + index * 190, 900);
            return (
              <group key={`garden-light-${index}`} position={[wx, 0, wz]}>
                <mesh position={[0, 0.2, 0]} castShadow>
                  <cylinderGeometry args={[0.025, 0.025, 0.4, 10]} />
                  <meshStandardMaterial color="#d7ccc8" roughness={0.62} metalness={0.24} />
                </mesh>
                <mesh position={[0, 0.43, 0]}>
                  <sphereGeometry args={[0.05, 12, 12]} />
                  <meshStandardMaterial color="#fff3cd" emissive="#fff3cd" emissiveIntensity={0.55} />
                </mesh>
              </group>
            );
          })}

          {Array.from({ length: 8 }).map((_, index) => {
            const [wx, , wz] = toWorld(220 + index * 190, 1005);
            return (
              <mesh
                key={`city-light-${index}`}
                position={[wx, 0.18, wz]}
                castShadow
                receiveShadow
              >
                <cylinderGeometry args={[0.04, 0.04, 0.36, 10]} />
                <meshStandardMaterial color="#d7ccc8" roughness={0.6} metalness={0.35} />
              </mesh>
            );
          })}

          {Array.from({ length: 4 }).map((_, index) => {
            const [wx, , wz] = toWorld(250 + index * 430, 955);
            return (
              <mesh key={`city-planter-${index}`} position={[wx, 0.08, wz]} castShadow>
                <boxGeometry args={[0.46, 0.14, 0.26]} />
                <meshStandardMaterial color="#5d4037" roughness={0.86} metalness={0.08} />
              </mesh>
            );
          })}

          {Array.from({ length: 4 }).map((_, index) => {
            const [wx, , wz] = toWorld(250 + index * 430, 955);
            return (
              <mesh key={`city-planter-top-${index}`} position={[wx, 0.18, wz]}>
                <boxGeometry args={[0.38, 0.08, 0.18]} />
                <meshStandardMaterial color="#43a047" roughness={0.98} metalness={0} />
              </mesh>
            );
          })}
        </>
      ) : null}

      {/* AAS: 헬스장을 뺐으므로 헬스장 바닥을 그리지 않는다(계획 007) */}
      {AAS_DRAW_GYM_FLOOR && gymZoneFloorWidth > 0 && roomZoneFloorHeight > 0 ? (
        <>
          <mesh
            position={[gymZoneCenterX, 0.002, roomZoneCenterZ]}
            rotation={[-Math.PI / 2, 0, 0]}
            receiveShadow
          >
            <planeGeometry args={[gymZoneFloorWidth, roomZoneFloorHeight]} />
            <meshStandardMaterial
              color="#24272d"
              roughness={0.95}
              metalness={0.05}
            />
          </mesh>
          {showRemoteOffice ? (
            <mesh
              position={[gymZoneCenterX, 0.002, roomZoneCenterZ + remoteOfficeOffsetZ]}
              rotation={[-Math.PI / 2, 0, 0]}
              receiveShadow
            >
              <planeGeometry args={[gymZoneFloorWidth, roomZoneFloorHeight]} />
              <meshStandardMaterial
                color="#24272d"
                roughness={0.95}
                metalness={0.05}
              />
            </mesh>
          ) : null}
        </>
      ) : null}

      {AAS_DRAW_QA_FLOOR && qaZoneFloorWidth > 0 && roomZoneFloorHeight > 0 ? (
        <>
          <mesh
            position={[qaZoneCenterX, 0.003, roomZoneCenterZ]}
            rotation={[-Math.PI / 2, 0, 0]}
            receiveShadow
          >
            <planeGeometry args={[qaZoneFloorWidth, roomZoneFloorHeight]} />
            <meshStandardMaterial
              color="#12091d"
              roughness={0.92}
              metalness={0.08}
            />
          </mesh>
          {showRemoteOffice ? (
            <mesh
              position={[qaZoneCenterX, 0.003, roomZoneCenterZ + remoteOfficeOffsetZ]}
              rotation={[-Math.PI / 2, 0, 0]}
              receiveShadow
            >
              <planeGeometry args={[qaZoneFloorWidth, roomZoneFloorHeight]} />
              <meshStandardMaterial
                color="#12091d"
                roughness={0.92}
                metalness={0.08}
              />
            </mesh>
          ) : null}
          <mesh
            position={[qaZoneCenterX, 0.004, roomZoneCenterZ]}
            rotation={[-Math.PI / 2, 0, 0]}
            receiveShadow
          >
            <planeGeometry args={[qaZoneFloorWidth * 0.96, roomZoneFloorHeight * 0.88]} />
            <meshStandardMaterial
              color="#170d28"
              roughness={0.86}
              metalness={0.12}
            />
          </mesh>
          {showRemoteOffice ? (
            <mesh
              position={[qaZoneCenterX, 0.004, roomZoneCenterZ + remoteOfficeOffsetZ]}
              rotation={[-Math.PI / 2, 0, 0]}
              receiveShadow
            >
              <planeGeometry args={[qaZoneFloorWidth * 0.96, roomZoneFloorHeight * 0.88]} />
              <meshStandardMaterial
                color="#170d28"
                roughness={0.86}
                metalness={0.12}
              />
            </mesh>
          ) : null}
          {Array.from({ length: 7 }).map((_, index) => {
            const offsetX =
              qaZoneCenterX - qaZoneFloorWidth * 0.38 + index * (qaZoneFloorWidth / 7);
            return (
              <group key={`qa-vertical-group-${index}`}>
                <mesh
                  key={`qa-vertical-local-${index}`}
                  position={[offsetX, 0.006, roomZoneCenterZ]}
                  rotation={[-Math.PI / 2, 0, 0]}
                >
                  <planeGeometry args={[0.015, qaZoneStripeHeight]} />
                  <meshBasicMaterial color="#7c3aed" transparent opacity={0.34} />
                </mesh>
                {showRemoteOffice ? (
                  <mesh
                    key={`qa-vertical-remote-${index}`}
                    position={[offsetX, 0.006, roomZoneCenterZ + remoteOfficeOffsetZ]}
                    rotation={[-Math.PI / 2, 0, 0]}
                  >
                    <planeGeometry args={[0.015, qaZoneStripeHeight]} />
                    <meshBasicMaterial color="#7c3aed" transparent opacity={0.34} />
                  </mesh>
                ) : null}
              </group>
            );
          })}
          {Array.from({ length: 12 }).map((_, index) => {
            const z =
              roomZoneCenterZ -
              qaZoneStripeHeight / 2 +
              index * (qaZoneStripeHeight / 11);
            return (
              <group key={`qa-horizontal-group-${index}`}>
                <mesh
                  key={`qa-horizontal-local-${index}`}
                  position={[qaZoneCenterX, 0.006, z]}
                  rotation={[-Math.PI / 2, 0, 0]}
                >
                  <planeGeometry args={[qaZoneStripeWidth, 0.012]} />
                  <meshBasicMaterial
                    color="#38bdf8"
                    transparent
                    opacity={index % 3 === 0 ? 0.28 : 0.12}
                  />
                </mesh>
                {showRemoteOffice ? (
                  <mesh
                    key={`qa-horizontal-remote-${index}`}
                    position={[qaZoneCenterX, 0.006, z + remoteOfficeOffsetZ]}
                    rotation={[-Math.PI / 2, 0, 0]}
                  >
                    <planeGeometry args={[qaZoneStripeWidth, 0.012]} />
                    <meshBasicMaterial
                      color="#38bdf8"
                      transparent
                      opacity={index % 3 === 0 ? 0.28 : 0.12}
                    />
                  </mesh>
                ) : null}
              </group>
            );
          })}
        </>
      ) : null}

      {Array.from({ length: 18 }).map((_, index) => {
        const z =
          localOfficeCenterZ - localOfficeHeight / 2 + (index + 1) * (localOfficeHeight / 18);
        return (
          <group key={`floor-line-group-${index}`}>
            <mesh
              position={[localOfficeCenterX, 0.001, z]}
              rotation={[-Math.PI / 2, 0, 0]}
            >
              <planeGeometry args={[localOfficeWidth, 0.008]} />
              <meshBasicMaterial color={palette.floorLine.color} transparent opacity={palette.floorLine.opacity} />
            </mesh>
            {showRemoteOffice ? (
              <mesh
                position={[localOfficeCenterX, 0.001, z + remoteOfficeOffsetZ]}
                rotation={[-Math.PI / 2, 0, 0]}
              >
                <planeGeometry args={[localOfficeWidth, 0.008]} />
                <meshBasicMaterial color={palette.floorLine.color} transparent opacity={palette.floorLine.opacity} />
              </mesh>
            ) : null}
          </group>
        );
      })}

      {(() => {
        // AAS: 외벽은 테마 색이고 발광을 없앤다. 원본은 발광 0.4 로 조명과 상관없이 밝았다(스펙 2026-10-20-012 §3-1)
        const wallColor = palette.wall;

        return (
          <>
            <mesh position={[localOfficeCenterX, 0.5, localNorthWallZ]} receiveShadow>
              <boxGeometry args={[localOfficeWidth, 1, 0.12]} />
              <meshStandardMaterial
                color={wallColor}
                roughness={0.9}
              />
            </mesh>
            {showRemoteOffice ? (
              <mesh
                position={[localOfficeCenterX, 0.5, localNorthWallZ + remoteOfficeOffsetZ]}
                receiveShadow
              >
                <boxGeometry args={[localOfficeWidth, 1, 0.12]} />
                <meshStandardMaterial
                  color={wallColor}
                  roughness={0.9}
                />
              </mesh>
            ) : null}
            <mesh position={[localOfficeCenterX, 0.5, localSouthWallZ]} receiveShadow>
              <boxGeometry args={[localOfficeWidth, 1, 0.12]} />
              <meshStandardMaterial
                color={wallColor}
                roughness={0.9}
              />
            </mesh>
            {showRemoteOffice ? (
              <mesh
                position={[localOfficeCenterX, 0.5, localSouthWallZ + remoteOfficeOffsetZ]}
                receiveShadow
              >
                <boxGeometry args={[localOfficeWidth, 1, 0.12]} />
                <meshStandardMaterial
                  color={wallColor}
                  roughness={0.9}
                />
              </mesh>
            ) : null}
            <mesh position={[localWestWallX, 0.5, localOfficeCenterZ]} receiveShadow>
              <boxGeometry args={[0.12, 1, localOfficeHeight]} />
              <meshStandardMaterial
                color={wallColor}
                roughness={0.9}
              />
            </mesh>
            {showRemoteOffice ? (
              <mesh
                position={[localWestWallX, 0.5, localOfficeCenterZ + remoteOfficeOffsetZ]}
                receiveShadow
              >
                <boxGeometry args={[0.12, 1, localOfficeHeight]} />
                <meshStandardMaterial
                  color={wallColor}
                  roughness={0.9}
                />
              </mesh>
            ) : null}
            <mesh position={[localEastWallX, 0.5, localOfficeCenterZ]} receiveShadow>
              <boxGeometry args={[0.12, 1, localOfficeHeight]} />
              <meshStandardMaterial
                color={wallColor}
                roughness={0.9}
              />
            </mesh>
            {showRemoteOffice ? (
              <mesh
                position={[localEastWallX, 0.5, localOfficeCenterZ + remoteOfficeOffsetZ]}
                receiveShadow
              >
                <boxGeometry args={[0.12, 1, localOfficeHeight]} />
                <meshStandardMaterial
                  color={wallColor}
                  roughness={0.9}
                />
              </mesh>
            ) : null}
          </>
        );
      })()}

      {/* AAS(2026-10-20): 걸레받이는 벽 안쪽 면보다 조금 앞으로 내민다(core/baseboard.ts). 같은 평면이면 카메라를 움직일 때 깜빡였다 */}
      <mesh position={[localOfficeCenterX, BASEBOARD.height / 2, localNorthWallZ + bbOffset]}>
        <boxGeometry args={[localOfficeWidth, BASEBOARD.height, BASEBOARD.depth]} />
        <meshLambertMaterial color={palette.baseboard} />
      </mesh>
      {showRemoteOffice ? (
        <mesh position={[localOfficeCenterX, BASEBOARD.height / 2, localNorthWallZ + bbOffset + remoteOfficeOffsetZ]}>
          <boxGeometry args={[localOfficeWidth, BASEBOARD.height, BASEBOARD.depth]} />
          <meshLambertMaterial color={palette.baseboard} />
        </mesh>
      ) : null}
      <mesh position={[localOfficeCenterX, BASEBOARD.height / 2, localSouthWallZ - bbOffset]}>
        <boxGeometry args={[localOfficeWidth, BASEBOARD.height, BASEBOARD.depth]} />
        <meshLambertMaterial color={palette.baseboard} />
      </mesh>
      {showRemoteOffice ? (
        <mesh position={[localOfficeCenterX, BASEBOARD.height / 2, localSouthWallZ - bbOffset + remoteOfficeOffsetZ]}>
          <boxGeometry args={[localOfficeWidth, BASEBOARD.height, BASEBOARD.depth]} />
          <meshLambertMaterial color={palette.baseboard} />
        </mesh>
      ) : null}
      <mesh position={[localWestWallX + bbOffset, BASEBOARD.height / 2, localOfficeCenterZ]}>
        <boxGeometry args={[BASEBOARD.depth, BASEBOARD.height, localOfficeHeight]} />
        <meshLambertMaterial color={palette.baseboard} />
      </mesh>
      {showRemoteOffice ? (
        <mesh position={[localWestWallX + bbOffset, BASEBOARD.height / 2, localOfficeCenterZ + remoteOfficeOffsetZ]}>
          <boxGeometry args={[BASEBOARD.depth, BASEBOARD.height, localOfficeHeight]} />
          <meshLambertMaterial color={palette.baseboard} />
        </mesh>
      ) : null}
      <mesh position={[localEastWallX - bbOffset, BASEBOARD.height / 2, localOfficeCenterZ]}>
        <boxGeometry args={[BASEBOARD.depth, BASEBOARD.height, localOfficeHeight]} />
        <meshLambertMaterial color={palette.baseboard} />
      </mesh>
      {showRemoteOffice ? (
        <mesh position={[localEastWallX - bbOffset, BASEBOARD.height / 2, localOfficeCenterZ + remoteOfficeOffsetZ]}>
          <boxGeometry args={[BASEBOARD.depth, BASEBOARD.height, localOfficeHeight]} />
          <meshLambertMaterial color={palette.baseboard} />
        </mesh>
      ) : null}
    </group>
  );
});

export const WallPictures = memo(function WallPictures({
  showRemoteOffice = true,
}: {
  showRemoteOffice?: boolean;
}) {
  const { palette } = useScenePalette();
  // AAS: 그림 색은 원본 색을 휘도가 가까운 차분한 색(tokens.ts artTone)으로 바꾼다. 원본은 빨강·주황·노랑 원색이었다(스펙 2026-10-20-012 §3-4)
  const tone = (hex: string) => artTone(palette, hex);
  const localWidth = LOCAL_OFFICE_CANVAS_WIDTH * SCALE;
  const localHeight = LOCAL_OFFICE_CANVAS_HEIGHT * SCALE;
  const [localCenterX, , localCenterZ] = toWorld(
    LOCAL_OFFICE_CANVAS_WIDTH / 2,
    LOCAL_OFFICE_CANVAS_HEIGHT / 2,
  );
  const northZ = localCenterZ - localHeight / 2 + 0.07;
  const southZ = localCenterZ + localHeight / 2 - 0.07;
  const westX = localCenterX - localWidth / 2 + 0.07;
  const eastX = localCenterX + localWidth / 2 - 0.07;
  const pictureY = 0.64;
  // AAS: 액자는 한국 사무실 배치(core/aasKoreanOffice.ts)의 좌표(장면 픽셀)로 건다. 배치 데이터가 아니라 판본과 관계없다.
  // 원본 자리는 배치와 관계없는 고정 좌표라 회의실 벽 가운데에서 벗어나고, 남쪽 것은 문서함·소파 뒤에,
  // 동쪽 것은 TFT 회의실 프로젝터 스크린과 겹쳤다. 북쪽: 회의실마다 북쪽 벽 가운데, 남쪽: 가구가 없는 벽,
  // 서쪽·동쪽: 칸반 판·스크린을 피한 벽. 액자 앞면은 +z 라 서쪽 벽은 +90°, 동쪽 벽은 -90° 로 돌린다
  // (원본은 반대로 돌아 그림이 벽 쪽을 봤다).
  // OMAI-1510: 북쪽 벽 액자는 회의실마다 하나, 방 가운데에 건다. 고정 좌표(180·480·720·960·1200)는 대회의실 +
  // 팀 회의실 4 배치(kr-20 까지) 기준이라 kr-21(회의실 3)에서 가운데를 벗어나고 한 방에 둘씩 걸렸다.
  const wallCenters = northRoomWallCenters();
  const southPictureX = southLoungePictureX();
  const px = (canvasX: number) => localCenterX + (canvasX - LOCAL_OFFICE_CANVAS_WIDTH / 2) * SCALE;
  const pz = (canvasY: number) => localCenterZ + (canvasY - LOCAL_OFFICE_CANVAS_HEIGHT / 2) * SCALE;

  return (
    <group>

      <FramedPicture
        position={[px(wallCenters[0]), pictureY, northZ]} // 팀 회의실 1
        rotY={0}
        w={0.58}
        h={0.42}
        frameColor={palette.art.frame}
        bgColor={tone("#f8f4ec")}
        art={
          <>
            <mesh position={[-0.12, 0.07, 0]}>
              <planeGeometry args={[0.22, 0.14]} />
              <meshBasicMaterial color={tone("#c0392b")} />
            </mesh>
            <mesh position={[0.09, 0.07, 0]}>
              <planeGeometry args={[0.18, 0.14]} />
              <meshBasicMaterial color={tone("#2980b9")} />
            </mesh>
            <mesh position={[0.04, -0.07, 0]}>
              <planeGeometry args={[0.26, 0.12]} />
              <meshBasicMaterial color={tone("#f39c12")} />
            </mesh>
            <mesh position={[0, 0, 0.001]}>
              <planeGeometry args={[0.006, 0.3]} />
              <meshBasicMaterial color={tone("#1c1008")} />
            </mesh>
            <mesh position={[0, 0.01, 0.001]}>
              <planeGeometry args={[0.4, 0.006]} />
              <meshBasicMaterial color={tone("#1c1008")} />
            </mesh>
          </>
        }
      />

      <FramedPicture
        position={[px(wallCenters[1]), pictureY, northZ]} // 팀 회의실 2
        rotY={0}
        w={0.64}
        h={0.4}
        frameColor={palette.art.frame}
        bgColor={tone("#a8d8f0")}
        art={
          <>
            <mesh position={[0, 0.08, 0]}>
              <planeGeometry args={[0.56, 0.1]} />
              <meshBasicMaterial color={tone("#6ab8e8")} />
            </mesh>
            <mesh position={[0.18, 0.09, 0.001]}>
              <circleGeometry args={[0.038, 12]} />
              <meshBasicMaterial color={tone("#f8d060")} />
            </mesh>
            <mesh position={[0, 0, 0.001]}>
              <planeGeometry args={[0.56, 0.1]} />
              <meshBasicMaterial color={tone("#7ab870")} />
            </mesh>
            <mesh position={[-0.12, -0.04, 0.002]}>
              <planeGeometry args={[0.28, 0.1]} />
              <meshBasicMaterial color={tone("#5a9a58")} />
            </mesh>
            <mesh position={[0, -0.1, 0.001]}>
              <planeGeometry args={[0.56, 0.08]} />
              <meshBasicMaterial color={tone("#8b6348")} />
            </mesh>
          </>
        }
      />

      <FramedPicture
        position={[px(wallCenters[2]), pictureY, northZ]} // 팀 회의실 3
        rotY={0}
        w={0.5}
        h={0.42}
        frameColor={palette.art.frame}
        bgColor={tone("#f0d090")}
        art={
          <>
            <mesh position={[0, 0.07, 0]}>
              <planeGeometry args={[0.4, 0.12]} />
              <meshBasicMaterial color={tone("#e07820")} />
            </mesh>
            <mesh position={[0, -0.02, 0]}>
              <planeGeometry args={[0.4, 0.09]} />
              <meshBasicMaterial color={tone("#c0403a")} />
            </mesh>
            <mesh position={[0, -0.1, 0]}>
              <planeGeometry args={[0.4, 0.08]} />
              <meshBasicMaterial color={tone("#4a2870")} />
            </mesh>
          </>
        }
      />

      <FramedPicture
        position={[px(160), pictureY, southZ]} // 전화 부스와 휴게 공간 사이
        rotY={Math.PI}
        w={0.6}
        h={0.4}
        frameColor={palette.art.frame}
        bgColor={tone("#e8e0f0")}
        art={
          <>
            <mesh position={[-0.14, 0.06, 0]}>
              <planeGeometry args={[0.2, 0.22]} />
              <meshBasicMaterial color={tone("#7b68ee")} />
            </mesh>
            <mesh position={[0.06, 0.04, 0]}>
              <planeGeometry args={[0.26, 0.18]} />
              <meshBasicMaterial color={tone("#20b2aa")} />
            </mesh>
            <mesh position={[-0.05, -0.1, 0]}>
              <planeGeometry args={[0.32, 0.1]} />
              <meshBasicMaterial color={tone("#ff7f50")} />
            </mesh>
          </>
        }
      />

      <FramedPicture
        position={[px(300), pictureY, southZ]}
        rotY={Math.PI}
        w={0.5}
        h={0.36}
        frameColor={palette.art.frame}
        bgColor={tone("#0a0a12")}
        art={
          <>
            {([0, 1, 2, 3, 4, 5] as const).map((index) => (
              <mesh key={index} position={[-0.17 + index * 0.068, 0, 0]}>
                <planeGeometry args={[0.052, 0.26]} />
                <meshBasicMaterial
                  color={
                    [
                      tone("#ef4444"),
                      tone("#f97316"),
                      tone("#eab308"),
                      tone("#22c55e"),
                      tone("#3b82f6"),
                      tone("#a855f7"),
                    ][index]
                  }
                />
              </mesh>
            ))}
          </>
        }
      />

      <FramedPicture
        position={[px(southPictureX), pictureY, southZ]} // 휴게 소파와 알림판 사이 벽 가운데(전에는 알림판과 출입문 사이 830)
        rotY={Math.PI}
        w={0.46}
        h={0.42}
        frameColor={palette.art.frame}
        bgColor={tone("#efe3c4")}
        // 산과 해. 예전에는 사람 모양 그림이라 입구 옆에서 화장실 표시로 읽혔다.
        // 세 칸짜리 원(circleGeometry 의 변 3개)을 삼각형 산으로 쓴다 — thetaStart 를 90° 로 두어 꼭짓점이 위로 간다.
        art={
          <>
            <mesh position={[0.1, 0.09, 0]}>
              <circleGeometry args={[0.042, 20]} />
              <meshBasicMaterial color={tone("#d9642f")} />
            </mesh>
            <mesh position={[0.07, -0.035, 0.001]}>
              <circleGeometry args={[0.115, 3, Math.PI / 2]} />
              <meshBasicMaterial color={tone("#7fa497")} />
            </mesh>
            <mesh position={[-0.05, -0.06, 0.002]}>
              <circleGeometry args={[0.14, 3, Math.PI / 2]} />
              <meshBasicMaterial color={tone("#3d6660")} />
            </mesh>
            <mesh position={[0, -0.145, 0.003]}>
              <planeGeometry args={[0.384, 0.056]} />
              <meshBasicMaterial color={tone("#8a6a4a")} />
            </mesh>
          </>
        }
      />

      <FramedPicture
        position={[westX, pictureY, pz(346)]}
        rotY={Math.PI / 2}
        w={0.52}
        h={0.4}
        frameColor={palette.art.frame}
        bgColor={tone("#f0c840")}
        art={
          <>
            {([0, Math.PI / 3, -Math.PI / 3] as const).map(
              (rotation, index) => (
                <mesh
                  key={index}
                  position={[0, 0, 0]}
                  rotation={[0, 0, rotation]}
                >
                  <boxGeometry args={[0.08, 0.28, 0.001]} />
                  <meshBasicMaterial color={tone("#c84020")} />
                </mesh>
              ),
            )}
          </>
        }
      />

      <FramedPicture
        position={[westX, pictureY, pz(640)]}
        rotY={Math.PI / 2}
        w={0.58}
        h={0.44}
        frameColor={palette.art.frame}
        bgColor={tone("#1a3a6a")}
        art={
          <>
            {([-0.14, -0.07, 0, 0.07, 0.14] as const).map((x, index) => (
              <mesh key={`bv${index}`} position={[x, 0, 0]}>
                <planeGeometry args={[0.004, 0.34]} />
                <meshBasicMaterial color={tone("#4080c0")} transparent opacity={0.5} />
              </mesh>
            ))}
            {([-0.12, -0.06, 0, 0.06, 0.12] as const).map((y, index) => (
              <mesh key={`bh${index}`} position={[0, y, 0]}>
                <planeGeometry args={[0.42, 0.004]} />
                <meshBasicMaterial color={tone("#4080c0")} transparent opacity={0.5} />
              </mesh>
            ))}
            <mesh position={[-0.05, 0.04, 0.001]}>
              <planeGeometry args={[0.16, 0.12]} />
              <meshBasicMaterial color={tone("#4080c0")} transparent opacity={0.3} />
            </mesh>
            <mesh position={[0.1, -0.05, 0.001]}>
              <planeGeometry args={[0.12, 0.1]} />
              <meshBasicMaterial color={tone("#4080c0")} transparent opacity={0.3} />
            </mesh>
          </>
        }
      />

      <FramedPicture
        position={[eastX, pictureY, pz(799)]} // 동쪽 외벽. kr-19 부터 탕비실 안(북쪽 끝)이다 — 아래 탕비실 동쪽 액자(960)와 한 벽에 둘
        rotY={-Math.PI / 2}
        w={0.48}
        h={0.44}
        frameColor={palette.art.frame}
        bgColor={tone("#f8f4e8")}
        art={
          <>
            <mesh position={[0, -0.06, 0]}>
              <boxGeometry args={[0.018, 0.18, 0.001]} />
              <meshBasicMaterial color={tone("#3a6a2a")} />
            </mesh>
            <mesh position={[-0.07, 0.04, 0.001]} rotation={[0, 0, 0.4]}>
              <boxGeometry args={[0.12, 0.06, 0.001]} />
              <meshBasicMaterial color={tone("#4a8a38")} />
            </mesh>
            <mesh position={[0.07, 0.02, 0.001]} rotation={[0, 0, -0.4]}>
              <boxGeometry args={[0.12, 0.06, 0.001]} />
              <meshBasicMaterial color={tone("#5aa042")} />
            </mesh>
            <mesh position={[0, 0.1, 0.001]}>
              <boxGeometry args={[0.08, 0.1, 0.001]} />
              <meshBasicMaterial color={tone("#48904a")} />
            </mesh>
            <mesh position={[0, -0.14, 0.001]}>
              <boxGeometry args={[0.1, 0.05, 0.001]} />
              <meshBasicMaterial color={tone("#b86040")} />
            </mesh>
          </>
        }
      />

      {/* AAS(2026-10-26-004): 탕비실 벽마다 액자 하나씩. kr-19(2026-10-26-005)부터 탕비실은 1520~1800 × 720~1080 이고
          문은 서쪽 벽(780~845)이다. 북쪽 벽(TFT 회의실 3 과 함께 쓰는 벽의 탕비실 쪽 면)에 둘(kr-20 부터 서쪽 벽은 유리벽), 동쪽은 외벽.
          남쪽 상판·냉장고(1040~) 위는 피한다 */}
      <FramedPicture
        position={[px(1690), pictureY, pz(PANTRY_NORTH_FACE) + PICTURE_OFF_WALL]} // 탕비실 북쪽 벽(안쪽 면)
        rotY={0}
        w={0.5}
        h={0.38}
        frameColor={palette.art.frame}
        bgColor={tone("#f4ead8")}
        // 김이 오르는 커피잔
        art={
          <>
            <mesh position={[0, -0.05, 0]}>
              <planeGeometry args={[0.14, 0.12]} />
              <meshBasicMaterial color={tone("#8a5a3c")} />
            </mesh>
            <mesh position={[0.09, -0.04, 0]}>
              <ringGeometry args={[0.022, 0.034, 16]} />
              <meshBasicMaterial color={tone("#8a5a3c")} />
            </mesh>
            <mesh position={[0, -0.12, 0.001]}>
              <planeGeometry args={[0.22, 0.02]} />
              <meshBasicMaterial color={tone("#5a3a28")} />
            </mesh>
            {([-0.035, 0, 0.035] as const).map((x, index) => (
              <mesh key={index} position={[x, 0.06 + (index % 2) * 0.015, 0]}>
                <planeGeometry args={[0.012, 0.07]} />
                <meshBasicMaterial color={tone("#c8b8a8")} />
              </mesh>
            ))}
          </>
        }
      />

      <FramedPicture
        // kr-20(2026-10-26-006): 서쪽 벽이 유리벽이 되어 북쪽 벽(TFT 회의실 3 과 함께 쓰는 막힌 벽) 서쪽 끝으로 옮겼다. 전에는 서쪽 벽 안쪽 면 y 960
        position={[px(1590), pictureY, pz(PANTRY_NORTH_FACE) + PICTURE_OFF_WALL]} // 탕비실 북쪽 벽(안쪽 면)
        rotY={0}
        w={0.44}
        h={0.44}
        frameColor={palette.art.frame}
        bgColor={tone("#e8f0e0")}
        // 과일 그릇
        art={
          <>
            <mesh position={[0, -0.09, 0]}>
              <planeGeometry args={[0.28, 0.06]} />
              <meshBasicMaterial color={tone("#6a8aa0")} />
            </mesh>
            <mesh position={[-0.07, -0.02, 0.001]}>
              <circleGeometry args={[0.05, 16]} />
              <meshBasicMaterial color={tone("#c84a3a")} />
            </mesh>
            <mesh position={[0.06, -0.02, 0.001]}>
              <circleGeometry args={[0.048, 16]} />
              <meshBasicMaterial color={tone("#e8a030")} />
            </mesh>
            <mesh position={[0, 0.05, 0.002]}>
              <circleGeometry args={[0.044, 16]} />
              <meshBasicMaterial color={tone("#7ab050")} />
            </mesh>
          </>
        }
      />

      <FramedPicture
        position={[eastX, pictureY, pz(960)]} // 탕비실 동쪽 외벽
        rotY={-Math.PI / 2}
        w={0.56}
        h={0.36}
        frameColor={palette.art.frame}
        bgColor={tone("#1e2a3a")}
        // 창밖 노을(가로 띠)
        art={
          <>
            {([0.1, 0.04, -0.02] as const).map((y, index) => (
              <mesh key={index} position={[0, y, 0]}>
                <planeGeometry args={[0.46, 0.06]} />
                <meshBasicMaterial color={[tone("#e89060"), tone("#d06850"), tone("#8a4a6a")][index]} />
              </mesh>
            ))}
            <mesh position={[0.12, 0.05, 0.001]}>
              <circleGeometry args={[0.03, 16]} />
              <meshBasicMaterial color={tone("#f8d080")} />
            </mesh>
            <mesh position={[0, -0.09, 0.001]}>
              <planeGeometry args={[0.46, 0.08]} />
              <meshBasicMaterial color={tone("#2a3a50")} />
            </mesh>
          </>
        }
      />
    </group>
  );
});
