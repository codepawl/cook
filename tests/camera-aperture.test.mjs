import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const cameraSource = readFileSync(new URL('../src/cycles/camera.wgsl', import.meta.url), 'utf8');

// Evaluates the `angle_0` expression of cam_sample_regular_polygon from the WGSL source itself, so the test follows the kernel.
function firstCornerAngleOfKernel(corners, rotation, cornerIndex) {
  const match = cameraSource.match(/let angle_0 = ([^;]+);/);
  assert.ok(match, 'camera.wgsl must define angle_0 in cam_sample_regular_polygon');
  const stepAngle = (2 * Math.PI) / corners;
  const evaluate = new Function('rotation', 'step_angle', 'corner_index', `return ${match[1]};`);
  return evaluate(rotation, stepAngle, cornerIndex);
}

// Cycles regular_polygon_sample (kernel/sample/mapping.h): triangle (centre, (cos t, sin t), (cos t, -sin t)) with t = pi / n,
// turned by rotation + corner * 2t. Its two outer vertices are at angles turned + t and turned - t.
function cyclesVertexAngles(corners, rotation) {
  const halfStep = Math.PI / corners;
  const angles = [];
  for (let cornerIndex = 0; cornerIndex < corners; cornerIndex += 1) {
    const turned = rotation + cornerIndex * 2 * halfStep;
    angles.push(turned + halfStep, turned - halfStep);
  }
  return angles;
}

function normalizedAngle(angle) {
  const turn = 2 * Math.PI;
  return ((angle % turn) + turn) % turn;
}

function sameAngleSet(first, second) {
  const round = angle => Math.round(normalizedAngle(angle) * 1e6) % Math.round(2 * Math.PI * 1e6);
  const firstSet = new Set(first.map(round));
  const secondSet = new Set(second.map(round));
  return firstSet.size === secondSet.size && [...firstSet].every(value => secondSet.has(value));
}

for (const corners of [3, 4, 5, 6, 8]) {
  for (const rotation of [0, 0.3]) {
    test(`the ${corners}-blade aperture has the Cycles polygon corners at rotation ${rotation}`, () => {
      const kernelAngles = [];
      for (let cornerIndex = 0; cornerIndex < corners; cornerIndex += 1) {
        const first = firstCornerAngleOfKernel(corners, rotation, cornerIndex);
        kernelAngles.push(first, first + (2 * Math.PI) / corners);
      }
      assert.ok(sameAngleSet(kernelAngles, cyclesVertexAngles(corners, rotation)));
    });
  }
}

test('four blades at rotation 0 give an axis-aligned square (corners at 45, 135, 225 and 315 degrees)', () => {
  const firstAngle = firstCornerAngleOfKernel(4, 0, 0);
  assert.ok(Math.abs(firstAngle - Math.PI / 4) < 1e-12);
});

test('six blades at rotation 0 give a flat-sided hexagon (first corner at 30 degrees)', () => {
  const firstAngle = firstCornerAngleOfKernel(6, 0, 0);
  assert.ok(Math.abs(firstAngle - Math.PI / 6) < 1e-12);
});
