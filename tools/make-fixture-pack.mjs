// Builds fixtures/room.cookpack: a small room (a floor, two boxes, one emissive panel and a sky colour) packed with
// buildNativeInputV2 from an explicit { instances, materials } descriptor. No 67js code is involved, and the same run
// always writes the same bytes.
//
// Usage: node tools/make-fixture-pack.mjs [output-file]   (default: fixtures/room.cookpack)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { encodePackFile } from '../pack-file.mjs';
import { buildNativeInputV2 } from '../pack-input-v2.mjs';

export const ROOM_WIDTH = 160;
export const ROOM_HEIGHT = 120;
export const ROOM_SAMPLES = 64;

const FLOOR_HALF_SIZE = 4;
const FLOOR_CELLS_PER_SIDE = 6;
const PANEL_HEIGHT = 3.4;
const PANEL_HALF_SIZE = 1.0;
const SKY_COLOR = [0.35, 0.5, 0.75];
const FIELD_OF_VIEW_DEGREES = 40;

function subtract(first, second) {
  return [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
}

function cross(first, second) {
  return [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
}

function normalize(vector) {
  const length = Math.hypot(...vector);
  return vector.map((component) => component / length);
}

/**
 * The camera object buildNativeInputV2 reads, for a fixed pinhole view. Fields: `eye` (position), `forward`, `right` and
 * `above` (unit axes of the view), `halfHeight` (tangent of half the vertical field of view) and `halfWidth` (the same
 * times the aspect ratio). The packer scales `right` and `above` by the half sizes itself. 67js computes the same fields
 * in `createCamera`; this copy has no thin lens and no lens shift.
 */
export function pinholeCamera({ eye, target, fieldOfViewDegrees, width, height }) {
  const forward = normalize(subtract(target, eye));
  const right = normalize(cross(forward, [0, 1, 0]));
  const above = cross(right, forward);
  const halfHeight = Math.tan((fieldOfViewDegrees * Math.PI) / 360);
  return { eye, forward, right, above, halfHeight, halfWidth: (halfHeight * width) / height };
}

// A box of half size 0.5 with flat shaded faces, counter-clockwise seen from outside.
function unitBoxGeometry() {
  const faces = [
    { normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
    { normal: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { normal: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0] },
    { normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { normal: [0, 0, -1], u: [0, 1, 0], v: [1, 0, 0] },
  ];
  const positions = [];
  const normals = [];
  const indices = [];
  for (const { normal, u, v } of faces) {
    const firstVertex = positions.length / 3;
    for (const [uSign, vSign] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (let axis = 0; axis < 3; axis++) {
        positions.push(0.5 * (normal[axis] + uSign * u[axis] + vSign * v[axis]));
        normals.push(normal[axis]);
      }
    }
    indices.push(firstVertex, firstVertex + 1, firstVertex + 2, firstVertex, firstVertex + 2, firstVertex + 3);
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) };
}

// A square on the plane y = height facing up, split into cells x cells squares of two triangles each.
function floorGeometry(halfSize, cells, height) {
  const positions = [];
  const normals = [];
  const indices = [];
  const verticesPerSide = cells + 1;
  for (let row = 0; row < verticesPerSide; row++) {
    for (let column = 0; column < verticesPerSide; column++) {
      positions.push(-halfSize + (2 * halfSize * column) / cells, height, -halfSize + (2 * halfSize * row) / cells);
      normals.push(0, 1, 0);
    }
  }
  for (let row = 0; row < cells; row++) {
    for (let column = 0; column < cells; column++) {
      const topLeft = row * verticesPerSide + column;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + verticesPerSide;
      const bottomRight = bottomLeft + 1;
      indices.push(topLeft, bottomRight, topRight, topLeft, bottomLeft, bottomRight);
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) };
}

// A square on the plane y = height facing down: the light panel.
function downFacingPanelGeometry(halfSize, height) {
  return {
    positions: new Float32Array([
      -halfSize, height, -halfSize,
      halfSize, height, -halfSize,
      halfSize, height, halfSize,
      -halfSize, height, halfSize,
    ]),
    normals: new Float32Array([0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

// Column-major 4x4: scale, then a turn around the y axis, then a move.
function placementMatrix({ scale, turnRadians, translation }) {
  const cosine = Math.cos(turnRadians);
  const sine = Math.sin(turnRadians);
  return [
    scale[0] * cosine, 0, -scale[0] * sine, 0,
    0, scale[1], 0, 0,
    scale[2] * sine, 0, scale[2] * cosine, 0,
    translation[0], translation[1], translation[2], 1,
  ];
}

const IDENTITY_MATRIX = placementMatrix({ scale: [1, 1, 1], turnRadians: 0, translation: [0, 0, 0] });

/** The FORMAT-v2 input of the room, as buildNativeInputV2 returns it. */
export function buildRoomInput() {
  const boxGeometry = unitBoxGeometry();
  const scene = {
    materials: [
      { color: [0.7, 0.7, 0.7], roughness: 0.8 },
      { color: [0.8, 0.2, 0.15], roughness: 0.5 },
      { color: [0.2, 0.35, 0.8], roughness: 0.3, metallic: 0.6 },
      { color: [1, 0.95, 0.85], emission: 12 },
    ],
    instances: [
      { geometry: floorGeometry(FLOOR_HALF_SIZE, FLOOR_CELLS_PER_SIDE, 0), matrix: IDENTITY_MATRIX, materialIndex: 0 },
      {
        geometry: boxGeometry,
        matrix: placementMatrix({ scale: [1.4, 2.0, 1.4], turnRadians: 0.5, translation: [-1.2, 1.0, -0.5] }),
        materialIndex: 1,
      },
      {
        geometry: boxGeometry,
        matrix: placementMatrix({ scale: [1.2, 1.2, 1.2], turnRadians: -0.4, translation: [1.4, 0.6, 0.8] }),
        materialIndex: 2,
      },
      { geometry: downFacingPanelGeometry(PANEL_HALF_SIZE, PANEL_HEIGHT), matrix: IDENTITY_MATRIX, materialIndex: 3 },
    ],
    lights: {},
  };
  const camera = pinholeCamera({
    eye: [0, 2.4, 8],
    target: [0, 1.3, 0],
    fieldOfViewDegrees: FIELD_OF_VIEW_DEGREES,
    width: ROOM_WIDTH,
    height: ROOM_HEIGHT,
  });
  return buildNativeInputV2(scene, camera, {
    width: ROOM_WIDTH,
    height: ROOM_HEIGHT,
    samples: ROOM_SAMPLES,
    backgroundColor: SKY_COLOR,
  });
}

/** The bytes of fixtures/room.cookpack. */
export function buildRoomPackBytes() {
  return encodePackFile(buildRoomInput(), { generator: 'tools/make-fixture-pack.mjs' });
}

function writeRoomPack(outputPath) {
  const bytes = buildRoomPackBytes();
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, bytes);
  console.log(`wrote ${outputPath} (${bytes.length} bytes)`);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMainModule) {
  const defaultPath = fileURLToPath(new URL('../fixtures/room.cookpack', import.meta.url));
  writeRoomPack(resolve(process.argv[2] ?? defaultPath));
}
