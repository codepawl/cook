import { readFileSync } from 'node:fs';

import { PACK_REVISION, STRUCT_STRIDES_V2 } from '../../pack-input-v2.mjs';

const packageVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

/** CommonJS source of an `addonBuildInfo` export that matches this package, for a fake addon file in a test. */
export const MATCHING_ADDON_BUILD_INFO_SOURCE = `addonBuildInfo() { return ${JSON.stringify({
  version: packageVersion,
  packRevision: PACK_REVISION,
  kernelParamsBytes: STRUCT_STRIDES_V2.kernelParams,
})}; }`;
