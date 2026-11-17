// Loads a built addon and checks that addonBuildInfo() reports the version of package.json and the PACK_REVISION of
// pack-input-v2.mjs, which build.rs reads as text. The JavaScript handshake tests cannot reach this case.
//   node tools/check-addon-build-info.mjs [path to the built library, default build/render-native.node]
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PACK_REVISION, STRUCT_STRIDES_V2 } from '../pack-input-v2.mjs';

const repositoryDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
const addonPath = resolve(process.argv[2] ?? join(repositoryDirectory, 'build', 'render-native.node'));
const packageVersion = JSON.parse(readFileSync(join(repositoryDirectory, 'package.json'), 'utf8')).version;

const addonModule = { exports: {} };
process.dlopen(addonModule, addonPath);
assert.equal(
  typeof addonModule.exports.addonBuildInfo,
  'function',
  `${addonPath} does not export addonBuildInfo; build it from the current sources.`,
);
assert.deepEqual(addonModule.exports.addonBuildInfo(), { version: packageVersion, packRevision: PACK_REVISION, kernelParamsBytes: STRUCT_STRIDES_V2.kernelParams });
console.log(`addonBuildInfo matches package.json (${packageVersion}) and PACK_REVISION (${PACK_REVISION})`);
