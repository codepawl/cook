import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  COOK_TIME_LIMIT_CODE,
  describeEngine,
  isTimeLimitError,
  markTimeLimitError,
  withTimeLimitCode,
} from '../engine.mjs';
import { PACK_REVISION, findNativeAddon, resolveNativeKernel, traceNative } from '../index.mjs';
import { validatePackOptions } from '../pack-input-v2.mjs';

const PACKAGE_DIRECTORY = fileURLToPath(new URL('..', import.meta.url));
const TIME_LIMIT_MESSAGE = 'The native trace passed its time limit of 1 s after 3 of 8 samples.';

function withEnvironment(changes, callback) {
  const saved = {};
  for (const [name, value] of Object.entries(changes)) {
    saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return callback();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('describeEngine reports the package version, pack format, kernels, passes and limits', () => {
  const engine = describeEngine();
  const packageJson = JSON.parse(readFileSync(join(PACKAGE_DIRECTORY, 'package.json'), 'utf8'));
  assert.equal(engine.name, 'cook');
  assert.equal(engine.version, packageJson.version);
  assert.deepEqual(engine.packFormat, { version: 2, revision: PACK_REVISION, readsRevisions: [1, PACK_REVISION] });
  assert.deepEqual(engine.kernels, ['legacy', 'cycles']);
  assert.equal(engine.defaultKernel, 'legacy');
  assert.deepEqual(engine.denoisers, ['none', 'atrous', 'oidn']);
  assert.deepEqual(engine.passes.map((pass) => pass.name), ['rgba', 'denoisedRgba', 'albedo', 'normal', 'depth', 'variance']);
  assert.deepEqual(engine.sessions, { kernels: ['cycles'], progressive: true, update: true });
  assert.equal(engine.limits.pixels, 2 ** 24);
  assert.equal(engine.limits.texturePoolBytes, 2 ** 30);
  assert.equal(engine.limits.lightTreeEmitters, 4194304);
  assert.equal(engine.limits.triangles, null);
  assert.equal(engine.limits.instances, null);
});

test('every kernel the engine lists is accepted by resolveNativeKernel and an unknown one is refused', () => {
  for (const kernel of describeEngine().kernels) {
    assert.equal(resolveNativeKernel(kernel), kernel);
  }
  assert.equal(resolveNativeKernel(undefined), describeEngine().defaultKernel);
  assert.throws(() => resolveNativeKernel('nope'), /COOK_KERNEL/);
  assert.throws(() => resolveNativeKernel(null), /Invalid native kernel null/);
});

test('the limits of the engine description match what the packer checks', () => {
  const { limits } = describeEngine();
  const accepts = (options) => validatePackOptions({ width: 1, height: 1, samples: 1, ...options }, 'test');
  accepts({ width: limits.imageSide });
  assert.throws(() => accepts({ width: limits.imageSide + 1 }), /width/);
  accepts({ height: limits.imageSide });
  assert.throws(() => accepts({ height: limits.imageSide + 1 }), /height/);
  accepts({ samples: limits.samples });
  assert.throws(() => accepts({ samples: limits.samples + 1 }), /samples/);
  accepts({ samplesPerDispatch: limits.samplesPerDispatch });
  assert.throws(() => accepts({ samplesPerDispatch: limits.samplesPerDispatch + 1 }), /samplesPerDispatch/);
  assert.throws(() => accepts({ width: 4097, height: 4096 }), /pixels/);
});

test('describeEngine does not look for or load the addon', () => {
  const script = `
    import { describeEngine } from ${JSON.stringify(new URL('../index.mjs', import.meta.url).href)};
    describeEngine();
    console.log('described');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, COOK_ADDON_PATH: join(tmpdir(), 'cook-addon-that-does-not-exist.node') },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /described/);
  const engineSource = readFileSync(join(PACKAGE_DIRECTORY, 'engine.mjs'), 'utf8');
  assert.doesNotMatch(engineSource, /from '\.\/index\.mjs'|createRequire|findNativeAddon/);
});

test('COOK_ADDON_PATH: unset keeps the default, a real file is used, a missing file is an error naming the variable', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cook-addon-path-'));
  try {
    const existingFile = join(directory, 'addon.node');
    writeFileSync(existingFile, '');
    withEnvironment({ COOK_ADDON_PATH: undefined }, () => {
      const found = findNativeAddon();
      assert.ok(found === null || found.endsWith('render-native.node'));
    });
    withEnvironment({ COOK_ADDON_PATH: '' }, () => {
      const found = findNativeAddon();
      assert.ok(found === null || found.endsWith('render-native.node'));
    });
    withEnvironment({ COOK_ADDON_PATH: existingFile }, () => {
      assert.equal(findNativeAddon(), existingFile);
    });
    withEnvironment({ COOK_ADDON_PATH: join(directory, 'missing.node') }, () => {
      assert.throws(() => findNativeAddon(), /COOK_ADDON_PATH.*does not exist/);
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('COOK_KERNEL wins over JS67_NATIVE_KERNEL, which still works alone', () => {
  withEnvironment({ COOK_KERNEL: 'cycles', JS67_NATIVE_KERNEL: 'legacy' }, () => {
    assert.equal(resolveNativeKernel(undefined), 'cycles');
  });
  withEnvironment({ COOK_KERNEL: undefined, JS67_NATIVE_KERNEL: 'cycles' }, () => {
    assert.equal(resolveNativeKernel(undefined), 'cycles');
  });
  withEnvironment({ COOK_KERNEL: '', JS67_NATIVE_KERNEL: 'cycles' }, () => {
    assert.equal(resolveNativeKernel(undefined), 'cycles');
  });
  withEnvironment({ COOK_KERNEL: undefined, JS67_NATIVE_KERNEL: undefined }, () => {
    assert.equal(resolveNativeKernel(undefined), 'legacy');
    assert.equal(resolveNativeKernel('cycles'), 'cycles');
  });
});

test('a time limit error gets the code COOK_TIME_LIMIT, other errors keep theirs', () => {
  const napiError = Object.assign(new Error(TIME_LIMIT_MESSAGE), { code: 'GenericFailure' });
  assert.equal(isTimeLimitError(napiError), false);
  assert.equal(markTimeLimitError(napiError), napiError);
  assert.equal(napiError.code, COOK_TIME_LIMIT_CODE);
  assert.equal(isTimeLimitError(napiError), true);

  const otherError = Object.assign(new Error('Invalid denoise option'), { code: 'GenericFailure' });
  markTimeLimitError(otherError);
  assert.equal(otherError.code, 'GenericFailure');
  assert.equal(isTimeLimitError(otherError), false);
  assert.equal(isTimeLimitError(undefined), false);

  assert.throws(
    () => withTimeLimitCode(() => { throw new Error('probeCyclesLobe passed its time limit of 2 s.'); }),
    (error) => error.code === 'COOK_TIME_LIMIT',
  );
  assert.equal(withTimeLimitCode(() => 7), 7);
});

test('traceNative passes an addon time limit error on with its code', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cook-fake-addon-'));
  try {
    const fakeAddon = join(directory, 'fake-addon.cjs');
    writeFileSync(fakeAddon, `
      module.exports = {
        traceSceneCycles() {
          const error = new Error(${JSON.stringify(TIME_LIMIT_MESSAGE)});
          error.code = 'GenericFailure';
          throw error;
        },
      };
    `);
    const input = { schemaVersion: 2, kernelParams: new Uint8Array(320) };
    withEnvironment({ COOK_ADDON_PATH: fakeAddon }, () => {
      assert.throws(
        () => traceNative(input, { kernel: 'cycles', width: 4, height: 4, samples: 8, maxSeconds: 1 }),
        (error) => isTimeLimitError(error) && error.message === TIME_LIMIT_MESSAGE,
      );
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
