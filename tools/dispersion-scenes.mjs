// The dispersion parity scenes (codepawl/crucible#1714), described once and read by both renderers:
//   - Cook packs them with buildNativeInputV2 (tools/dispersion-parity.mjs),
//   - Blender 5.3 Cycles builds the same meshes from the JSON the same script writes (tools/dispersion-parity-cycles.py).
// Scenes (y is up, metres):
//   prism-view   a prism standing in front of a row of thin bright slits on black: each slit seen through it is a spectrum
//   gem          a round brilliant gem on black under four small lights
//   prism-floor  a prism lying under a small sun over a grey floor: the rainbow on the floor (a caustic)
import { buildNativeInputV2 } from '../pack-input-v2.mjs';
import { pinholeCamera } from './make-fixture-pack.mjs';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function subtract(first, second) {
  return first.map((value, axis) => value - second[axis]);
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
  return vector.map(component => component / length);
}

/** Column-major 4x4: scale, then a turn around the x axis, then a turn around the y axis, then a move. */
export function placement({ scale = [1, 1, 1], turnX = 0, turnY = 0, translation = [0, 0, 0] }) {
  const [cosX, sinX] = [Math.cos(turnX), Math.sin(turnX)];
  const [cosY, sinY] = [Math.cos(turnY), Math.sin(turnY)];
  const columns = [[scale[0], 0, 0], [0, scale[1], 0], [0, 0, scale[2]]].map(([x, y, z]) => {
    const afterX = [x, y * cosX - z * sinX, y * sinX + z * cosX];
    return [afterX[0] * cosY + afterX[2] * sinY, afterX[1], -afterX[0] * sinY + afterX[2] * cosY];
  });
  return [...columns[0], 0, ...columns[1], 0, ...columns[2], 0, ...translation, 1];
}

/** Triangles with one flat normal each, from corner triples, each turned to face away from `inside`. */
function flatGeometry(triangles, inside) {
  const positions = [];
  const normals = [];
  const indices = [];
  for (const [first, second, third] of triangles) {
    let corners = [first, second, third];
    let normal = normalize(cross(subtract(corners[1], corners[0]), subtract(corners[2], corners[0])));
    const centre = corners[0].map((value, axis) => (value + corners[1][axis] + corners[2][axis]) / 3);
    const outward = subtract(centre, inside);
    if (normal[0] * outward[0] + normal[1] * outward[1] + normal[2] * outward[2] < 0) {
      corners = [corners[0], corners[2], corners[1]];
      normal = normal.map(component => -component);
    }
    const firstVertex = positions.length / 3;
    for (const corner of corners) {
      positions.push(...corner);
      normals.push(...normal);
    }
    indices.push(firstVertex, firstVertex + 1, firstVertex + 2);
  }
  return { positions, normals, indices };
}

/** An equilateral prism of the given side, extruded along z from -length/2 to length/2, its centroid on the origin. */
export function prismGeometry(side, length) {
  const height = (side * Math.sqrt(3)) / 2;
  const section = [[0, (2 * height) / 3], [-side / 2, -height / 3], [side / 2, -height / 3]];
  const back = section.map(([x, y]) => [x, y, -length / 2]);
  const front = section.map(([x, y]) => [x, y, length / 2]);
  const triangles = [[front[0], front[1], front[2]], [back[0], back[2], back[1]]];
  for (let edge = 0; edge < 3; edge++) {
    const next = (edge + 1) % 3;
    triangles.push([front[edge], back[edge], back[next]], [front[edge], back[next], front[next]]);
  }
  return flatGeometry(triangles, [0, 0, 0]);
}

/** A brilliant-cut gem of unit girdle radius with `facets` facets around: table, crown, girdle ring and pavilion. */
export function gemGeometry(facets) {
  const ring = (radius, y, phase) => Array.from({ length: facets }, (_, index) => {
    const angle = ((index + phase) / facets) * 2 * Math.PI;
    return [radius * Math.cos(angle), y, radius * Math.sin(angle)];
  });
  const girdle = ring(1, 0, 0);
  const crownMiddle = ring(0.76, 0.15, 0.5);
  const table = ring(0.55, 0.29, 0);
  const pavilionMiddle = ring(0.6, -0.36, 0.5);
  const culet = [0, -0.85, 0];
  const triangles = [];
  for (let index = 0; index < facets; index++) {
    const next = (index + 1) % facets;
    const previous = (index + facets - 1) % facets;
    // Two rings that are half a step apart join as an antiprism: one triangle pointing each way per step.
    triangles.push([girdle[index], girdle[next], crownMiddle[index]]);
    triangles.push([crownMiddle[previous], crownMiddle[index], girdle[index]]);
    triangles.push([crownMiddle[index], table[next], table[index]]);
    triangles.push([table[index], crownMiddle[previous], crownMiddle[index]]);
    if (index > 0 && next > 0) {
      triangles.push([table[0], table[index], table[next]]);
    }
    triangles.push([girdle[index], pavilionMiddle[index], girdle[next]]);
    triangles.push([pavilionMiddle[previous], pavilionMiddle[index], girdle[index]]);
    triangles.push([pavilionMiddle[index], culet, pavilionMiddle[previous]]);
  }
  return flatGeometry(triangles, [0, -0.1, 0]);
}

/** A smooth sphere of radius 1 as `columns` by `rows` quads. */
export function sphereGeometry(columns = 24, rows = 16) {
  const positions = [];
  const indices = [];
  for (let row = 0; row <= rows; row++) {
    const polar = (row / rows) * Math.PI;
    for (let column = 0; column <= columns; column++) {
      const azimuth = (column / columns) * 2 * Math.PI;
      positions.push(Math.sin(polar) * Math.cos(azimuth), Math.cos(polar), Math.sin(polar) * Math.sin(azimuth));
    }
  }
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const topLeft = row * (columns + 1) + column;
      const bottomLeft = topLeft + columns + 1;
      indices.push(topLeft, topLeft + 1, bottomLeft, topLeft + 1, bottomLeft + 1, bottomLeft);
    }
  }
  const outward = flatGeometry(
    Array.from({ length: indices.length / 3 }, (_, triangle) => [0, 1, 2].map(corner => {
      const vertex = indices[triangle * 3 + corner] * 3;
      return positions.slice(vertex, vertex + 3);
    })),
    [0, 0, 0],
  );
  return {
    positions: outward.positions,
    normals: outward.positions.slice(),
    indices: outward.indices,
  };
}

/** A square of the given half size facing +y at height 0, or facing the given way when `normal` is set. */
export function floorGeometry(halfSize) {
  return {
    positions: [-halfSize, 0, -halfSize, halfSize, 0, -halfSize, halfSize, 0, halfSize, -halfSize, 0, halfSize],
    normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
    indices: [0, 2, 1, 0, 3, 2],
  };
}

/** A flat quad of half sizes (halfWidth, halfHeight) in the xy plane, facing +z. */
export function panelGeometry(halfWidth, halfHeight) {
  return {
    positions: [-halfWidth, -halfHeight, 0, halfWidth, -halfHeight, 0, halfWidth, halfHeight, 0, -halfWidth, halfHeight, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2, 0, 2, 3],
  };
}

const MATTE_FLOOR = { color: [0.3, 0.3, 0.3], roughness: 1 };
const BLACK_FLOOR = { color: [0, 0, 0], roughness: 1 };

function glass(ior, dispersion) {
  return { color: [1, 1, 1], roughness: 0, ior, transmission: 1, dispersion };
}

function emitter(emission, color = [1, 1, 1]) {
  return { color, roughness: 1, emission };
}

/**
 * The scene `name`: `{ objects, camera, width, height, bounces }`. Each object has a name, geometry, a column-major matrix and
 * a material (Cook field names). `dispersion` is the dispersion of every glass (0 leaves the field out).
 */
export function dispersionScene(name, { dispersion = 1, width, height } = {}) {
  const withDispersion = material => {
    if (!(dispersion > 0)) {
      const { dispersion: ignored, ...plain } = material;
      return plain;
    }
    return material;
  };
  if (name === 'prism-view') {
    const side = 0.3;
    const outputWidth = width ?? 640;
    const outputHeight = height ?? 360;
    return {
      width: outputWidth,
      height: outputHeight,
      bounces: 12,
      camera: { eye: [0, 0.15, 1.6], target: [0, 0.15, 0], fieldOfViewDegrees: 24 },
      objects: [
        { name: 'prism', geometry: prismGeometry(side, 0.4), matrix: placement({ turnX: Math.PI / 2, translation: [0, 0.15, 0] }), material: withDispersion(glass(1.52, dispersion)) },
        ...Array.from({ length: 9 }, (_, index) => ({
          name: `slit-${index}`, geometry: panelGeometry(0.012, 0.3), matrix: placement({ translation: [-1.2 + 0.3 * index, 0.15, -1.1] }), material: emitter(15),
        })),
        { name: 'floor', geometry: floorGeometry(6), matrix: placement({ translation: [0, -0.06, 0] }), material: BLACK_FLOOR },
      ],
    };
  }
  if (name === 'gem') {
    const outputWidth = width ?? 512;
    const outputHeight = height ?? 512;
    const lights = [
      [[-1.6, 1.4, 1.2], 0.05, 160],
      [[1.5, 1.1, 0.9], 0.05, 140],
      [[0.3, 2.0, -1.2], 0.06, 120],
      [[-0.6, 0.4, 2.0], 0.04, 90],
    ];
    return {
      width: outputWidth,
      height: outputHeight,
      bounces: 16,
      camera: { eye: [0, 0.55, 1.6], target: [0, 0.07, 0], fieldOfViewDegrees: 24 },
      objects: [
        { name: 'gem', geometry: gemGeometry(16), matrix: placement({ scale: [0.11, 0.11, 0.11], turnX: 0.3, translation: [0, 0.075, 0] }), material: withDispersion(glass(2.42, dispersion)) },
        { name: 'floor', geometry: floorGeometry(8), matrix: placement({ translation: [0, -0.06, 0] }), material: BLACK_FLOOR },
        ...lights.map(([position, size, strength], index) => ({
          name: `light-${index}`, geometry: sphereGeometry(), matrix: placement({ scale: [size, size, size], translation: position }), material: emitter(strength),
        })),
      ],
    };
  }
  if (name === 'prism-floor') {
    const side = 0.3;
    const prismHeight = (side * Math.sqrt(3)) / 2;
    return {
      width: width ?? 1920,
      height: height ?? 1080,
      bounces: 12,
      camera: { eye: [0.55, 0.85, 1.35], target: [0.6, 0, 0], fieldOfViewDegrees: 38 },
      objects: [
        { name: 'prism', geometry: prismGeometry(side, 0.5), matrix: placement({ translation: [0, prismHeight / 3, 0] }), material: withDispersion(glass(1.517, dispersion)) },
        { name: 'floor', geometry: floorGeometry(6), matrix: placement({ translation: [0.3, 0, 0] }), material: MATTE_FLOOR },
        { name: 'sun', geometry: sphereGeometry(), matrix: placement({ scale: [0.09, 0.09, 0.09], translation: [-2.6, 1.15, 0] }), material: emitter(900, [1, 0.95, 0.86]) },
      ],
    };
  }
  throw new RangeError(`Unknown dispersion scene "${name}". Use prism-view, gem or prism-floor.`);
}

/** The FORMAT-v2 input Cook traces for a scene description. */
export function packDispersionScene(description, { samples, seed = 1 }) {
  const materials = description.objects.map(object => object.material);
  const instances = description.objects.map((object, index) => ({
    geometry: {
      positions: Float32Array.from(object.geometry.positions),
      normals: Float32Array.from(object.geometry.normals),
      indices: Uint32Array.from(object.geometry.indices),
    },
    matrix: object.matrix ?? IDENTITY,
    materialIndex: index,
  }));
  const camera = pinholeCamera({ ...description.camera, width: description.width, height: description.height });
  return buildNativeInputV2({ materials, instances, lights: {} }, camera, {
    width: description.width,
    height: description.height,
    samples,
    seed,
    bounces: description.bounces,
    backgroundColor: [0, 0, 0],
  });
}
