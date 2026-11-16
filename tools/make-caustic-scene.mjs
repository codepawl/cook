// Scenes for the caustic estimator (FORMAT-v2.md, "Caustic casters and receivers"), packed with buildNativeInputV2 from an explicit
// descriptor. No Crucible code is involved.
//   ball:  a glass ball on a grey floor under a small emissive sphere (the repro of crucible#1715).
//   prism: a glass prism under a small emissive sphere, throwing a band on the floor (the scene of the dispersion short).
// `caustics: true` marks the glass as a caster and the floor as a receiver.
import { INSTANCE_FLAG_CAUSTIC_CASTER, INSTANCE_FLAG_CAUSTIC_RECEIVER, buildNativeInputV2 } from '../pack-input-v2.mjs';
import { pinholeCamera } from './make-fixture-pack.mjs';

const ALL_RAY_KINDS = 1 | 2 | 4 | 8 | 16 | 32;

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

function dot(first, second) {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

function translationMatrix(translation, scale = [1, 1, 1]) {
  return [scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1];
}

// Turns every triangle so that its winding normal agrees with `desiredNormal(centroid, windingNormal)` (a positive dot product).
function windOutward(geometry, desiredNormal) {
  const indices = Array.from(geometry.indices);
  const position = (vertex) => [geometry.positions[vertex * 3], geometry.positions[vertex * 3 + 1], geometry.positions[vertex * 3 + 2]];
  for (let corner = 0; corner < indices.length; corner += 3) {
    const [first, second, third] = [position(indices[corner]), position(indices[corner + 1]), position(indices[corner + 2])];
    const windingNormal = cross(subtract(second, first), subtract(third, first));
    const centroid = [0, 1, 2].map((axis) => (first[axis] + second[axis] + third[axis]) / 3);
    if (dot(windingNormal, desiredNormal(centroid)) < 0) {
      [indices[corner + 1], indices[corner + 2]] = [indices[corner + 2], indices[corner + 1]];
    }
  }
  return { ...geometry, indices: new Uint32Array(indices) };
}

/** A unit-radius sphere centred on the origin with smooth normals. */
export function sphereGeometry(rings = 24, segments = 48) {
  const positions = [];
  for (let ring = 0; ring <= rings; ring++) {
    const polar = (Math.PI * ring) / rings;
    for (let segment = 0; segment <= segments; segment++) {
      const azimuth = (2 * Math.PI * segment) / segments;
      positions.push(Math.sin(polar) * Math.cos(azimuth), Math.cos(polar), Math.sin(polar) * Math.sin(azimuth));
    }
  }
  const indices = [];
  for (let ring = 0; ring < rings; ring++) {
    for (let segment = 0; segment < segments; segment++) {
      const topLeft = ring * (segments + 1) + segment;
      const bottomLeft = topLeft + segments + 1;
      indices.push(topLeft, bottomLeft, topLeft + 1, topLeft + 1, bottomLeft, bottomLeft + 1);
    }
  }
  const geometry = { positions: new Float32Array(positions), normals: new Float32Array(positions), indices: new Uint32Array(indices) };
  return windOutward(geometry, (centroid) => centroid);
}

/** An equilateral prism of side 1 and length 1 along z, apex up, centred on its centroid, with flat faces. */
export function prismGeometry() {
  const height = Math.sqrt(3) / 2;
  const corners = [[-0.5, -height / 3], [0.5, -height / 3], [0, (2 * height) / 3]];
  const positions = [];
  const normals = [];
  const indices = [];
  const addFace = (vertices, normal) => {
    const first = positions.length / 3;
    for (const vertex of vertices) {
      positions.push(...vertex);
      normals.push(...normal);
    }
    indices.push(first, first + 1, first + 2);
    if (vertices.length === 4) {
      indices.push(first, first + 2, first + 3);
    }
  };
  for (const side of [-1, 1]) {
    addFace(corners.map(([x, y]) => [x, y, side * 0.5]), [0, 0, side]);
  }
  for (let edge = 0; edge < 3; edge++) {
    const [fromX, fromY] = corners[edge];
    const [toX, toY] = corners[(edge + 1) % 3];
    const outward = [toY - fromY, fromX - toX, 0];
    const length = Math.hypot(outward[0], outward[1]);
    const normal = [outward[0] / length, outward[1] / length, 0];
    addFace([[fromX, fromY, -0.5], [toX, toY, -0.5], [toX, toY, 0.5], [fromX, fromY, 0.5]], normal);
  }
  const geometry = { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) };
  return windOutward(geometry, (centroid) => [centroid[0], centroid[1], centroid[2] * 0.001]);
}

function floorGeometry(halfSize) {
  const geometry = {
    positions: new Float32Array([-halfSize, 0, -halfSize, halfSize, 0, -halfSize, halfSize, 0, halfSize, -halfSize, 0, halfSize]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
  return windOutward(geometry, () => [0, 1, 0]);
}

const GLASS = { color: [1, 1, 1], roughness: 0, ior: 1.5, transmission: 1 };
const OPAQUE_GREY = { color: [0.5, 0.5, 0.5], roughness: 0.5 };

function describeScene({ caster, lightPosition, lightRadius, lightEmission, casterMatrix, camera, caustics, opaqueCaster }) {
  const floorFlags = ALL_RAY_KINDS | (caustics ? INSTANCE_FLAG_CAUSTIC_RECEIVER : 0);
  const casterFlags = ALL_RAY_KINDS | (caustics ? INSTANCE_FLAG_CAUSTIC_CASTER : 0);
  return {
    camera,
    scene: {
      materials: [
        { color: [0.8, 0.8, 0.8], roughness: 0.9 },
        opaqueCaster ? OPAQUE_GREY : GLASS,
        { color: [1, 1, 1], emission: lightEmission },
      ],
      instances: [
        { geometry: floorGeometry(3), matrix: translationMatrix([0, 0, 0]), materialIndex: 0, visibilityFlags: floorFlags },
        { geometry: caster, matrix: casterMatrix, materialIndex: 1, visibilityFlags: casterFlags },
        { geometry: sphereGeometry(), matrix: translationMatrix(lightPosition, [lightRadius, lightRadius, lightRadius]), materialIndex: 2 },
      ],
      lights: {},
    },
  };
}

/**
 * The input of one scene. `name` is `ball` (crucible#1715's repro: a ball of radius 0.5, a light of radius 0.3 and emission 40 at 3.5 m)
 * or `prism` (a prism of side 0.3 and length 0.5 under a sphere of radius 0.09 at [-2.6, 1.15, 0]). `opaqueCaster` swaps the glass for
 * a grey material, the reference of the shadow.
 */
export function buildCausticInput(name, { width, height, samples, caustics = false, opaqueCaster = false, bounces = 12, seed = 1 }) {
  let description;
  if (name === 'ball') {
    description = describeScene({
      caster: sphereGeometry(),
      casterMatrix: translationMatrix([0, 0.5, 0], [0.5, 0.5, 0.5]),
      lightPosition: [0, 3.5, 0],
      lightRadius: 0.3,
      lightEmission: 40,
      camera: pinholeCamera({ eye: [0, 2.2, 3.2], target: [0, 0.2, 0], fieldOfViewDegrees: 40, width, height }),
      caustics,
      opaqueCaster,
    });
  } else if (name === 'prism') {
    const side = 0.3;
    description = describeScene({
      caster: prismGeometry(),
      casterMatrix: translationMatrix([0, (side * Math.sqrt(3)) / 6, 0], [side, side, 0.5]),
      lightPosition: [-2.6, 1.15, 0],
      lightRadius: 0.09,
      lightEmission: 900,
      camera: pinholeCamera({ eye: [1.6, 1.1, 1.5], target: [0.35, 0.05, 0], fieldOfViewDegrees: 40, width, height }),
      caustics,
      opaqueCaster,
    });
  } else {
    throw new RangeError(`buildCausticInput: name must be "ball" or "prism", got ${String(name)}.`);
  }
  return buildNativeInputV2(description.scene, description.camera, {
    width,
    height,
    samples,
    bounces,
    seed,
    backgroundColor: [0.02, 0.02, 0.02],
  });
}
