import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { describeAddonOverrideWarning, download, writeAddonAtomically } from '../fetch-addon.mjs';
import { createNativeSession, resolveSessionFrame, traceNative } from '../index.mjs';
import { decodePackFile, encodePackFile } from '../pack-file.mjs';
import { buildNativeInputV2, createTextureCollector, packMaterialRecordV2, validatePackOptions } from '../pack-input-v2.mjs';
import { buildRoomInput } from '../tools/make-fixture-pack.mjs';

const PACKAGE_DIRECTORY = fileURLToPath(new URL('..', import.meta.url));
const CLI_PATH = join(PACKAGE_DIRECTORY, 'bin', 'cook.mjs');
const FIXTURE_PATH = join(PACKAGE_DIRECTORY, 'fixtures', 'room.cookpack');
const WORK_DIRECTORY = mkdtempSync(join(tmpdir(), 'cook-surface-test-'));

after(() => rmSync(WORK_DIRECTORY, { recursive: true, force: true }));

function pathInWork(name) {
  return join(WORK_DIRECTORY, name);
}

function runCook(args, environment = {}) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, COOK_ADDON_PATH: pathInWork('no-such-addon.node'), ...environment },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const TRIANGLE_CAMERA = {
  eye: [0, 0, 3],
  forward: [0, 0, -1],
  right: [1, 0, 0],
  above: [0, 1, 0],
  halfHeight: 0.5,
  halfWidth: 0.5,
};

function triangleScene(geometryOverrides = {}, instanceOverrides = {}, environment = undefined) {
  const geometry = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
    ...geometryOverrides,
  };
  return {
    materials: [{ color: [1, 1, 1] }],
    instances: [{ geometry, materialIndex: 0, ...instanceOverrides }],
    lights: {},
    environment,
  };
}

function pack(scene, options = {}) {
  return buildNativeInputV2(scene, TRIANGLE_CAMERA, { width: 8, height: 8, samples: 1, ...options });
}

// Item 1: environment data.

function environmentMap(overrides = {}) {
  return { width: 4, height: 2, channels: 3, data: new Float32Array(4 * 2 * 3).fill(1), ...overrides };
}

test('an environment map with too little data is refused with the size to pass', () => {
  assert.throws(
    () => pack(triangleScene({}, {}, environmentMap({ data: new Float32Array(5) }))),
    (error) => error instanceof RangeError && /environment\.data has 5 values, but a 4 x 2 map with 3 channels needs 24/.test(error.message),
  );
});

test('NaN and Infinity texels give a finite sampling table', () => {
  const data = new Float32Array(4 * 2 * 3).fill(1);
  data[0] = Number.NaN;
  data[4] = Number.POSITIVE_INFINITY;
  const input = pack(triangleScene({}, {}, environmentMap({ data })));
  const texelValues = new Float32Array(input.environmentTexels.buffer, input.environmentTexels.byteOffset, input.environmentTexels.byteLength / 4);
  assert.ok(texelValues.every((value) => Number.isFinite(value)), 'every packed texel and CDF entry is finite');
  const cumulativeEnd = texelValues[(4 * 2 + 1) * 4];
  assert.equal(cumulativeEnd, 1);
});

// Item 2: geometry.

test('an index past the vertices is refused with the triangle and value', () => {
  assert.throws(
    () => pack(triangleScene({ indices: new Uint32Array([0, 1, 7]) })),
    (error) => error instanceof RangeError && /Instance\[0\] geometry, triangle 0: vertex index 2 must be a whole number from 0 to 2, got 7/.test(error.message),
  );
});

test('NaN positions, a short normals array and an indices length that is not a multiple of 3 are refused', () => {
  assert.throws(() => pack(triangleScene({ positions: new Float32Array([0, 0, 0, 1, 0, Number.NaN, 0, 1, 0]) })), /`positions` value 5 \(vertex 1\) is NaN/);
  assert.throws(() => pack(triangleScene({ normals: new Float32Array([0, 0, 1]) })), /`normals` has 3 values, but 3 vertices need 9/);
  assert.throws(() => pack(triangleScene({ indices: new Uint32Array([0, 1, 2, 0]) })), /`indices` has 4 values, which is not a multiple of 3/);
});

test('a material index past the material table is refused for an instance, an override and a triangle', () => {
  assert.throws(() => pack(triangleScene({}, { materialIndex: 9 })), /Instance\[0\]: `materialIndex` must be a whole number from 0 to 0, got 9/);
  assert.throws(() => pack(triangleScene({}, { materialOverride: 3 })), /Instance\[0\]: `materialOverride` must be a whole number from 0 to 0, got 3/);
  assert.throws(() => pack(triangleScene({ triangleMaterial: new Uint32Array([4]) })), /triangle 0: material index must be a whole number from 0 to 0, got 4/);
  assert.throws(() => pack(triangleScene({ triangleMaterial: new Uint32Array([]) })), /`triangleMaterial` has 0 entries for 1 triangles/);
});

test('a valid geometry still packs', () => {
  assert.equal(pack(triangleScene()).schemaVersion, 2);
});

// Item 8: packing options.

test('seed, exposure, rayEpsilon and the thresholds are checked when packing', () => {
  const scene = triangleScene();
  assert.throws(() => pack(scene, { seed: 2 ** 32 }), /`seed` must be a whole number from 0 to 4294967295/);
  assert.throws(() => pack(scene, { seed: -1 }), /`seed` must be a whole number/);
  assert.throws(() => pack(scene, { seed: 'abc' }), /`seed` must be a whole number/);
  assert.throws(() => pack(scene, { exposure: Number.NaN }), /`exposure` must be a finite number greater than 0/);
  assert.throws(() => pack(scene, { rayEpsilon: Number.POSITIVE_INFINITY }), /`rayEpsilon` must be a finite number greater than 0/);
  assert.throws(() => pack(scene, { noiseThreshold: Number.NaN }), /`noiseThreshold` must be a finite number 0 or more/);
  assert.throws(() => pack(scene, { filterGlossy: '2' }), /`filterGlossy` must be a finite number 0 or more/);
  assert.throws(() => pack({ ...scene, surfaceOffset: Number.NaN }), /`scene.surfaceOffset` must be a finite number greater than 0/);
  pack(scene, { seed: 4294967295, exposure: 2, rayEpsilon: 1e-3, noiseThreshold: 0, filterGlossy: 0 });
  assert.doesNotThrow(() => validatePackOptions({ seed: 7 }, 'test'));
});

// Item 5: image size against the packed camera.

test('traceNative refuses a size that squashes the packed camera and accepts the packed one', () => {
  const input = decodePackFile(readFileSync(FIXTURE_PATH));
  const fakeAddonPath = writeFakeAddon('fake-trace.cjs', 'return { rgba: new Float32Array(4) };');
  const previousAddonPath = process.env.COOK_ADDON_PATH;
  process.env.COOK_ADDON_PATH = fakeAddonPath;
  try {
    assert.throws(
      () => traceNative(input, { kernel: 'cycles', width: 100, height: 100, samples: 8 }),
      (error) => error instanceof RangeError && /the camera has a width to height ratio of .* but the image is 100x100/.test(error.message),
    );
    assert.doesNotThrow(() => traceNative(input, { kernel: 'cycles', width: 160, height: 120, samples: 8 }));
    assert.doesNotThrow(() => traceNative(input, { kernel: 'cycles', width: 4, height: 3, samples: 8 }));
    assert.throws(
      () => traceNative(input, { kernel: 'cycles', width: 4, height: 4, samples: 8 }),
      (error) => error instanceof RangeError && /but the image is 4x4/.test(error.message),
    );
    assert.doesNotThrow(() => traceNative(input, { kernel: 'cycles', width: 10, height: 8, samples: 8 }));
  } finally {
    if (previousAddonPath === undefined) delete process.env.COOK_ADDON_PATH;
    else process.env.COOK_ADDON_PATH = previousAddonPath;
  }
});

test('a session frame and a session creation refuse a size at another aspect', () => {
  const input = decodePackFile(readFileSync(FIXTURE_PATH));
  assert.throws(
    () => resolveSessionFrame(input, { kernel: 'cycles' }, { width: 100, height: 100, samples: 8 }),
    /but the image is 100x100/,
  );
  assert.throws(() => createNativeSession(input, { kernel: 'cycles', width: 100, height: 100 }), /but the image is 100x100/);
  const frame = resolveSessionFrame(input, { kernel: 'cycles' }, { width: 320, height: 240, samples: 8 });
  assert.equal(frame.width, 320);
});

// Hosts that wrap a session and compare the options they pass on must see the shape they saw before the post stage.
test('a session frame without post leaves the post key out, and one with post carries it', () => {
  const input = decodePackFile(readFileSync(FIXTURE_PATH));
  const plain = resolveSessionFrame(input, { kernel: 'cycles' }, { width: 320, height: 240, samples: 8 });
  assert.equal(Object.hasOwn(plain, 'post'), false);
  const withPost = resolveSessionFrame(input, { kernel: 'cycles' }, { width: 320, height: 240, samples: 8, post: { exposure: 2 } });
  assert.equal(withPost.post.exposure, 2);
});

// Item 3, 6: the command line.

test('an output path that is a folder is refused before any work', () => {
  const folderPath = pathInWork('output-is-a-folder.png');
  mkdirSync(folderPath, { recursive: true });
  const result = runCook(['render', FIXTURE_PATH, '--output', folderPath]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /is a folder\. Give a file name ending in \.png or \.npy/);
});

function partialFilesOf(outputName) {
  return readdirSync(WORK_DIRECTORY).filter((name) => name.startsWith(outputName) && name.endsWith('.partial'));
}

function writeFakeAddon(name, traceBody) {
  const addonPath = pathInWork(name);
  writeFileSync(addonPath, `module.exports = { traceSceneCycles(input, options) { ${traceBody} } };`);
  return addonPath;
}

test('the picture is written through a partial file that is gone afterwards', () => {
  const addonPath = writeFakeAddon('fake-good.cjs', 'return { rgba: new Float32Array(options.width * options.height * 4).fill(0.5), tracedSeconds: 0.1, adapter: "fake" };');
  const outputPath = pathInWork('atomic.png');
  const result = runCook(['render', FIXTURE_PATH, '--output', outputPath], { COOK_ADDON_PATH: addonPath });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(outputPath));
  assert.deepEqual(partialFilesOf('atomic.png'), []);
});

test('a failed trace leaves neither the output nor a partial file', () => {
  const addonPath = writeFakeAddon('fake-bad.cjs', 'throw new Error("device lost");');
  const outputPath = pathInWork('failed.png');
  const result = runCook(['render', FIXTURE_PATH, '--output', outputPath], { COOK_ADDON_PATH: addonPath });
  assert.equal(result.status, 1);
  assert.equal(existsSync(outputPath), false);
  assert.deepEqual(partialFilesOf('failed.png'), []);
});

test('a user file named like the old partial path is not overwritten or deleted', () => {
  const addonPath = writeFakeAddon('fake-reserved.cjs', 'return { rgba: new Float32Array(options.width * options.height * 4), tracedSeconds: 0.1, adapter: "fake" };');
  const outputPath = pathInWork('reserved.png');
  writeFileSync(`${outputPath}.partial`, 'keep me');
  const result = runCook(['render', FIXTURE_PATH, '--output', outputPath], { COOK_ADDON_PATH: addonPath });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(`${outputPath}.partial`, 'utf8'), 'keep me');
  assert.ok(existsSync(outputPath));
});

test('the CLI renders every size it derives from one side of the packed ratio', () => {
  const addonPath = writeFakeAddon('fake-derived.cjs', 'return { rgba: new Float32Array(options.width * options.height * 4), tracedSeconds: 0.1, adapter: "fake" };');
  const expectedSizes = [['10', '10 x 8'], ['333', '333 x 250']];
  for (const [width, expectedSize] of expectedSizes) {
    const outputPath = pathInWork(`derived-${width}.npy`);
    const result = runCook(['render', FIXTURE_PATH, '--width', width, '--output', outputPath], { COOK_ADDON_PATH: addonPath });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`rendered ${expectedSize},`));
  }
});

function packWithStoredValue(name, mutate) {
  const input = buildRoomInput();
  const kernelParams = new Uint8Array(input.kernelParams);
  mutate(new DataView(kernelParams.buffer));
  const path = pathInWork(name);
  writeFileSync(path, encodePackFile({ ...input, kernelParams }));
  return path;
}

test('a stored sample count or width out of range is a bad pack (exit 3), unless a flag supplied it', () => {
  const zeroSamples = packWithStoredValue('zero-samples.cookpack', (view) => view.setUint32(24, 0, true));
  const storedSamples = runCook(['render', zeroSamples, '--output', pathInWork('a.png')]);
  assert.equal(storedSamples.status, 3, storedSamples.stderr);
  assert.match(storedSamples.stderr, /the pack stores samples 0.*Pass --samples to override, or pack the scene again/);

  const flagSamples = runCook(['render', FIXTURE_PATH, '--output', pathInWork('b.png'), '--samples', '2000000']);
  assert.equal(flagSamples.status, 2, flagSamples.stderr);

  const hugeWidth = packWithStoredValue('huge-width.cookpack', (view) => view.setUint32(8, 20000, true));
  const storedWidth = runCook(['render', hugeWidth, '--output', pathInWork('c.png')]);
  assert.equal(storedWidth.status, 3, storedWidth.stderr);
  assert.match(storedWidth.stderr, /the pack stores width 20000/);
});

test('--help lists the short flags', () => {
  const help = runCook(['--help']);
  assert.match(help.stdout, /-h \| --version \| -v/);
  assert.match(help.stdout, /--output, -o <file>/);
});

// Item 7: build.mjs.

test('build.mjs says what to do when cargo cannot start', () => {
  const result = spawnSync(process.execPath, [join(PACKAGE_DIRECTORY, 'build.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: pathInWork('empty-path'), Path: pathInWork('empty-path') },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Could not run cargo \(.*\)\. Install Rust from https:\/\/rustup\.rs, or run cook fetch-addon for a prebuilt addon\./);
});

// Item 9: fetch-addon.

test('a body that fails while it is read gets the same advice as a failed request', async () => {
  const brokenBodyFetch = async () => ({
    status: 200,
    ok: true,
    arrayBuffer: async () => {
      throw new Error('terminated');
    },
  });
  await assert.rejects(
    download('https://example.invalid/addon', brokenBodyFetch),
    /Could not download https:\/\/example\.invalid\/addon: terminated\. Check the network, or build from source with npm run build\./,
  );
});

test('a write that fails removes the partial file and names the fix', () => {
  const blockedTarget = pathInWork('blocked-target');
  mkdirSync(blockedTarget, { recursive: true });
  writeFileSync(join(blockedTarget, 'keep.txt'), 'x');
  const partialPath = pathInWork('blocked-target.partial');
  assert.throws(
    () => writeAddonAtomically(partialPath, blockedTarget, Buffer.from('addon')),
    /Could not write .*blocked-target: .*Close other cook processes using build\/render-native\.node, or make build\/ writable\./,
  );
  assert.equal(existsSync(partialPath), false);
  assert.ok(readdirSync(blockedTarget).includes('keep.txt'));
});

test('fetch-addon warns only when COOK_ADDON_PATH names another addon than the download', () => {
  const downloadedPath = pathInWork('downloaded.node');
  assert.match(describeAddonOverrideWarning(pathInWork('other.node'), downloadedPath), /COOK_ADDON_PATH is set to .*other\.node, so cook keeps using that addon/);
  assert.equal(describeAddonOverrideWarning(undefined, downloadedPath), null);
  assert.equal(describeAddonOverrideWarning('', downloadedPath), null);
  assert.equal(describeAddonOverrideWarning(downloadedPath, downloadedPath), null);
});

test('an instanced scene with reduced materials accepts indices up to the record count', () => {
  const textureCollector = createTextureCollector();
  const materialRecords = [{}, {}, {}].map((material) => packMaterialRecordV2(material, textureCollector));
  const scene = triangleScene({}, { materialIndex: 2 });
  assert.doesNotThrow(() => pack(scene, { reducedMaterials: { materialRecords, textureCollector } }));
  const overridden = triangleScene({}, { materialIndex: 1, materialOverride: 2 });
  assert.doesNotThrow(() => pack(overridden, { reducedMaterials: { materialRecords, textureCollector } }));
  assert.throws(
    () => pack(triangleScene({}, { materialIndex: 3 }), { reducedMaterials: { materialRecords, textureCollector } }),
    /`materialIndex` must be a whole number from 0 to 2, got 3/,
  );
});

test('materialOverride 0xffffffff means no override', () => {
  assert.doesNotThrow(() => pack(triangleScene({}, { materialOverride: 0xffffffff })));
  assert.throws(() => pack(triangleScene({}, { materialOverride: 7 })), /`materialOverride` must be a whole number from 0 to 0, got 7/);
});

// Sun, 16-bit texture and normal map inputs (#24).

function sunScene(sun) {
  const scene = triangleScene();
  scene.lights = { sun: { direction: [0, 1, 0], color: [1, 1, 1], ...sun } };
  return scene;
}

test('a sun angularRadius that is not finite or sits in the delta-light blow-up range is refused with the range to pass', () => {
  for (const badRadius of [Number.NaN, Infinity, -0.01, 1e-4, 2, '0.5x']) {
    assert.throws(
      () => pack(sunScene({ angularRadius: badRadius })),
      (error) => error instanceof RangeError && /lights\.sun\.angularRadius must be 0 \(a delta sun\) or a finite angle/.test(error.message),
      `angularRadius ${String(badRadius)} is refused`,
    );
  }
});

test('a sun angularRadius of 0, the minimum, a real sun and a left-out value pack', () => {
  for (const goodSun of [{ angularRadius: 0 }, { angularRadius: 5e-4 }, { angularRadius: 0.00465 }, {}]) {
    assert.doesNotThrow(() => pack(sunScene(goodSun)), JSON.stringify(goodSun));
  }
});

function textureCollectorWith(data, width, height) {
  const collector = createTextureCollector();
  collector.addTexture({ image: { width, height, data } });
  return collector;
}

test('a Uint16Array texture must hold exactly two half-float words per texel', () => {
  assert.throws(
    () => textureCollectorWith(new Uint16Array(4 * 3), 1, 1),
    (error) => error instanceof RangeError && /needs 2 16-bit values .* but `data` has 12/.test(error.message) && /Float32Array/.test(error.message),
  );
  assert.throws(() => textureCollectorWith(new Uint16Array(3), 2, 1), /needs 4 16-bit values/);
  assert.doesNotThrow(() => textureCollectorWith(new Uint16Array(4), 2, 1));
});

test('normalScale is one strength: equal pairs pass, different pairs are refused', () => {
  const textureCollector = createTextureCollector();
  const NORMAL_SCALE_BYTE_OFFSET = 184;
  const packedStrength = (normalScale) => {
    const record = packMaterialRecordV2({ normalScale }, textureCollector);
    return new DataView(record.bytes.buffer, record.bytes.byteOffset).getFloat32(NORMAL_SCALE_BYTE_OFFSET, true);
  };
  assert.equal(packedStrength([0.5, 0.5]), 0.5);
  assert.equal(packedStrength([-0.5, 0.5]), 0.5);
  assert.equal(packedStrength(0.25), 0.25);
  assert.equal(packedStrength(undefined), 1);
  assert.throws(
    () => packMaterialRecordV2({ normalScale: [1, 0] }, textureCollector),
    (error) => error instanceof RangeError && /two different strengths/.test(error.message),
  );
});
