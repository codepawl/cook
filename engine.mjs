// What this build of Cook can do, as plain data, and the error code of a trace that ran out of time. Pure JavaScript: it
// never loads the native addon, so a caller can read it before deciding whether to build or load one.
import { readFileSync } from 'node:fs';

import { LIGHT_TREE_MAX_EMITTERS } from './light-tree-v2.mjs';
import {
  FORMAT_V2_VERSION,
  MAX_APERTURE_BLADES,
  MAX_PATH_SAMPLES_PER_DISPATCH,
  MAX_TRACE_PIXELS,
  PACK_REVISION,
  TEXTURE_POOL_MAX_BYTES,
} from './pack-input-v2.mjs';

/** The `code` of the error a trace throws when it passes `maxSeconds`. */
export const COOK_TIME_LIMIT_CODE = 'COOK_TIME_LIMIT';
/** The `code` of the error that reports a pack file or input whose revision this engine does not read. */
export const COOK_PACK_REVISION_CODE = 'COOK_PACK_REVISION';

/** The oldest pack revision the host still reads. The newest is `PACK_REVISION` (the host and the packer ship together). */
export const OLDEST_READABLE_PACK_REVISION = 2;

// Limits the packer checks with literals in `validatePackOptions`; tests/engine.test.mjs pins them to the real checks.
const MAX_IMAGE_SIDE = 16384;
const MAX_SAMPLES = 1048576;
const MAX_SAMPLES_PER_DISPATCH = 65536;

const TIME_LIMIT_MESSAGE_FRAGMENT = 'passed its time limit';

function readPackageVersion() {
  const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  return packageJson.version;
}

/**
 * Describes this engine: the pack format it reads, the kernels, denoisers, result passes and sessions it offers, and its
 * limits. A limit of `null` means Cook declares none (the card and its memory decide). Does not load the addon.
 */
export function describeEngine() {
  return {
    name: 'cook',
    version: readPackageVersion(),
    packFormat: {
      version: FORMAT_V2_VERSION,
      revision: PACK_REVISION,
      readsRevisions: [OLDEST_READABLE_PACK_REVISION, PACK_REVISION],
    },
    kernels: ['legacy', 'cycles'],
    defaultKernel: 'legacy',
    // "oidn" needs the Open Image Denoise library, loaded at run time from the path passed to createNativeOidnDenoiser.
    denoisers: ['none', 'atrous', 'oidn'],
    // What traceNative resolves with, besides timings: linear float planes, rows from the top.
    passes: [
      { name: 'rgba', channels: 4 },
      { name: 'denoisedRgba', channels: 4, when: 'denoise is "atrous"' },
      { name: 'albedo', channels: 3 },
      { name: 'normal', channels: 3 },
      { name: 'depth', channels: 1 },
      { name: 'variance', channels: 1 },
    ],
    sessions: { kernels: ['cycles'], progressive: true, update: true },
    limits: {
      triangles: null,
      instances: null,
      imageSide: MAX_IMAGE_SIDE,
      pixels: MAX_TRACE_PIXELS,
      samples: MAX_SAMPLES,
      samplesPerDispatch: MAX_SAMPLES_PER_DISPATCH,
      pathSamplesPerDispatch: MAX_PATH_SAMPLES_PER_DISPATCH,
      texturePoolBytes: TEXTURE_POOL_MAX_BYTES,
      lightTreeEmitters: LIGHT_TREE_MAX_EMITTERS,
      apertureBlades: MAX_APERTURE_BLADES,
    },
  };
}

/**
 * Refuses an input packed by a packer whose revision this engine does not read, before any table is decoded or the addon
 * is loaded. The error has `code` COOK_PACK_REVISION and names both revisions. The packers stamp `packRevision` on what
 * they return; an input without a stamp (built by hand, or by a packer from before the stamp existed) counts as revision 1.
 */
export function requireReadablePackRevision(input, callerName) {
  const stamp = input?.packRevision;
  if (stamp !== undefined && !(Number.isInteger(stamp) && stamp >= 1)) {
    throw new TypeError(`${callerName}: input.packRevision must be a whole number of at least 1 (the packers set it); got ${JSON.stringify(stamp)}.`);
  }
  const inputRevision = stamp ?? OLDEST_READABLE_PACK_REVISION;
  if (inputRevision < OLDEST_READABLE_PACK_REVISION || inputRevision > PACK_REVISION) {
    const advice = inputRevision > PACK_REVISION ? 'Update Cook' : 'Pack the scene again';
    const error = new Error(
      `${callerName}: the input has pack revision ${inputRevision}, but this Cook (${readPackageVersion()}) reads revisions ${OLDEST_READABLE_PACK_REVISION} to ${PACK_REVISION}. ${advice} (error ${COOK_PACK_REVISION_CODE}).`
    );
    error.code = COOK_PACK_REVISION_CODE;
    throw error;
  }
}

/** True for the error of a trace that passed its `maxSeconds` (`error.code` is `COOK_TIME_LIMIT`). */
export function isTimeLimitError(error) {
  return error?.code === COOK_TIME_LIMIT_CODE;
}

/** Sets `code` on an addon error whose message reports a passed time limit, then returns the error. */
export function markTimeLimitError(error) {
  const isTimeLimit = typeof error?.message === 'string' && error.message.includes(TIME_LIMIT_MESSAGE_FRAGMENT);
  if (isTimeLimit) {
    // napi gives its errors the code "GenericFailure", so the code is replaced, not only filled in.
    error.code = COOK_TIME_LIMIT_CODE;
  }
  return error;
}

/** Runs an addon call and gives a time limit error its code before it passes on. */
export function withTimeLimitCode(addonCall) {
  try {
    return addonCall();
  } catch (error) {
    throw markTimeLimitError(error);
  }
}
