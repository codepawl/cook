import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildNativeInputV2, packMaterialRecordV2 } from '../pack-input-v2.mjs';
import { pinholeCamera } from '../tools/make-fixture-pack.mjs';

const MATERIAL_FLAG_EMISSIVE_MIS = 16;
const MATERIAL_FLAGS_WORD = 48;

function materialFlags(material) {
  const packed = packMaterialRecordV2(material);
  const words = new Uint32Array(packed.bytes.buffer, packed.bytes.byteOffset, packed.bytes.byteLength / 4);
  return { flags: words[MATERIAL_FLAGS_WORD], isEmissive: packed.isEmissive };
}

function packSingleTriangle(instanceFields) {
  const geometry = {
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2],
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const scene = {
    materials: [{ color: [0.5, 0.5, 0.5] }],
    instances: [{ geometry, matrix: identity, materialIndex: 0, ...instanceFields }],
    lights: {},
  };
  const camera = pinholeCamera({ eye: [0, 0, 3], target: [0, 0, 0], fieldOfViewDegrees: 40, width: 8, height: 8 });
  return () => buildNativeInputV2(scene, camera, { width: 8, height: 8, samples: 1, backgroundColor: [0, 0, 0] });
}

test('a nonzero shadowTerminatorOffset is refused because the kernel does not read it', () => {
  assert.throws(
    packSingleTriangle({ shadowTerminatorOffset: 0.3 }),
    /Instance 0: shadowTerminatorOffset 0\.3 is not supported yet.*Leave it out or pass 0/,
  );
});

test('an instance without a shadowTerminatorOffset, or with 0, still packs', () => {
  packSingleTriangle({})();
  packSingleTriangle({ shadowTerminatorOffset: 0 })();
});

test('an emissive material is an MIS emitter until a coat or sheen layer sits on it', () => {
  const emissive = materialFlags({ emission: 5 });
  assert.notEqual(emissive.flags & MATERIAL_FLAG_EMISSIVE_MIS, 0);
  assert.equal(emissive.isEmissive, true);

  for (const layer of [{ coatWeight: 0.5 }, { sheenWeight: 0.5 }]) {
    const layered = materialFlags({ emission: 5, ...layer });
    assert.equal(layered.flags & MATERIAL_FLAG_EMISSIVE_MIS, 0, JSON.stringify(layer));
    assert.equal(layered.isEmissive, false, JSON.stringify(layer));
  }
});

test('a coat or sheen weight under the closure cutoff keeps the emitter in light sampling', () => {
  const faintCoat = materialFlags({ emission: 5, coatWeight: 1e-6 });
  assert.notEqual(faintCoat.flags & MATERIAL_FLAG_EMISSIVE_MIS, 0);
  assert.equal(faintCoat.isEmissive, true);
});
