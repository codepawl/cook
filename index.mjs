// Cook: loads the native addon built by `npm run build` and traces a packed scene on the GPU with Vulkan ray queries.
// The addon is not in the npm package; without it `findNativeAddon()` returns null.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { requireReadablePackRevision, withTimeLimitCode } from './engine.mjs';
import { resolvePostOption } from './post-options.mjs';

import {
  FORMAT_V2_MAGIC,
  FORMAT_V2_VERSION,
  PACK_REVISION,
  STRUCT_STRIDES_V2,
  KERNEL_FLAG_USE_LIGHT_TREE,
  KERNEL_FLAG_WHITE_NOISE_SAMPLER,
  KERNEL_FLAG_PATH_REGENERATION,
  validatePathRegenerationOption,
  resolveSamplingOptions,
  resolveUseLightTree,
  KERNEL_PARAMS_V2_FILTER_GLOSSY_BYTE_OFFSET,
  KERNEL_PARAMS_V2_FILTER_TYPE_BYTE_OFFSET,
  KERNEL_PARAMS_V2_FILTER_WIDTH_BYTE_OFFSET,
  KERNEL_PARAMS_V2_KERNEL_FLAGS_BYTE_OFFSET,
  filterTypeCode,
  resolveFilterParameters,
  buildNativeInputV2,
  packMaterialRecordV2,
  upgradeNativeInputV1ToV2,
  validateImagePixelCount,
  validateMaxSeconds,
  validatePackOptions,
  validateDenoiseOption,
  validateSeedOption,
  packCameraParams,
  requireHeldCameraMatchesImageSize,
} from './pack-input-v2.mjs';

export { buildNativeInput, buildNativeTexelInput } from './pack-input.mjs';
export {
  describeEngine,
  isTimeLimitError,
  COOK_TIME_LIMIT_CODE,
  COOK_PACK_REVISION_CODE,
} from './engine.mjs';
export {
  FORMAT_V2_MAGIC,
  FORMAT_V2_VERSION,
  PACK_REVISION,
  STRUCT_STRIDES_V2,
  KERNEL_PARAMS_V2_FILTER_GLOSSY_BYTE_OFFSET,
  buildNativeInputV2,
  packCameraParams,
  packMaterialRecordV2,
  upgradeNativeInputV1ToV2,
};

const PACKAGE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const ADDON_PATH = join(PACKAGE_DIRECTORY, 'build', 'render-native.node');
const VALID_KERNELS = new Set(['legacy', 'cycles']);

/**
 * The path of the built addon, or null when `npm run build` has not run. `COOK_ADDON_PATH` names an addon built elsewhere
 * (another checkout, the Blender add-on); a path set there that does not exist is an error, not a silent fallback.
 */
export function findNativeAddon() {
  const overridePath = process.env.COOK_ADDON_PATH;
  if (overridePath !== undefined && overridePath !== '') {
    if (!existsSync(overridePath)) {
      throw new Error(
        `COOK_ADDON_PATH is set to ${JSON.stringify(overridePath)}, which does not exist. Point it at a built render-native.node (npx cook fetch-addon or npm run build writes build/render-native.node) or unset the variable.`
      );
    }
    return resolve(overridePath);
  }
  return existsSync(ADDON_PATH) ? ADDON_PATH : null;
}

function kernelFromEnvironment() {
  for (const variableName of ['COOK_KERNEL', 'JS67_NATIVE_KERNEL']) {
    const value = process.env[variableName];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

/**
 * Resolves and validates the native kernel name from `kernel`, falling back to `COOK_KERNEL`, then `JS67_NATIVE_KERNEL`,
 * then `'legacy'`.
 */
export function resolveNativeKernel(kernel) {
  // Only a left-out kernel falls back: `null` is refused like any other wrong name.
  const selectedKernel = kernel !== undefined ? kernel : (kernelFromEnvironment() ?? 'legacy');
  if (typeof selectedKernel !== 'string' || !VALID_KERNELS.has(selectedKernel)) {
    throw new Error(
      `Invalid native kernel ${JSON.stringify(selectedKernel)}: pass "legacy" or "cycles" in options.kernel, COOK_KERNEL or JS67_NATIVE_KERNEL.`
    );
  }
  return selectedKernel;
}

// The `cycles` kernel starts a pixel's next sample as soon as a path ends unless the caller passes `pathRegeneration: false`.
const DEFAULT_PATH_REGENERATION = true;

/**
 * Traces the input on the GPU and resolves linear RGBA float data (`rgba`, width * height * 4, rows from the top, the
 * average of `samples` paths) with the adapter name and timings in seconds. `maxSeconds` makes the trace fail once it has
 * run that long. `kernel` selects `"legacy"` (default) or `"cycles"` (falling back to `JS67_NATIVE_KERNEL` when omitted).
 */
export function traceNative(input, options = {}) {
  requireReadablePackRevision(input, 'traceNative');
  validatePackOptions(options, 'traceNative', true);
  resolveSamplingOptions(options, 'traceNative');
  validatePathRegenerationOption(options.pathRegeneration, 'traceNative');
  const { width, height, samples, maxSeconds, kernel, samplesPerDispatch, dispatchBudgetMs, bootstrapKernel, denoise } = options;
  const selectedKernel = resolveNativeKernel(kernel);
  const addon = loadAddon();
  if (selectedKernel === 'legacy') {
    if (dispatchBudgetMs !== undefined) {
      throw new TypeError('traceNative: `dispatchBudgetMs` tiles the Cycles kernel dispatches; pass kernel "cycles", or leave it out for the legacy kernel.');
    }
    if (denoise === 'atrous') {
      throw new TypeError('traceNative: `denoise: "atrous"` filters the Cycles kernel result; pass kernel "cycles", or call denoiseAtrous with the traced guide buffers.');
    }
    if (input?.schemaVersion === FORMAT_V2_VERSION) {
      throw new TypeError(
        'Cannot pass a FORMAT-v2 scene input to kernel "legacy": pass kernel "cycles" or build a v1 input with buildNativeInput (an instanced scene needs kernel "cycles"; build it without { instancing: true } for kernel "legacy").'
      );
    }
    return withTimeLimitCode(() => addon.traceScene(input, { width, height, samples, maxSeconds, kernel: selectedKernel }));
  }
  const v2Input = prepareCyclesInput(input, options);
  requireHeldCameraMatchesImageSize(v2Input.kernelParams, width, height, 'traceNative');
  return withTimeLimitCode(() => addon.traceSceneCycles(v2Input, {
    width,
    height,
    samples,
    samplesPerDispatch,
    dispatchBudgetMs,
    maxSeconds,
    bootstrapKernel,
    denoise,
  }));
}

/**
 * Filters a traced image with the edge-avoiding a-trous wavelet filter on the GPU (Dammertz 2010 with SVGF's variance
 * guidance, spatial only). `rgba` holds four floats per pixel; `albedo`, `normal` (any length, zero where nothing was
 * hit), `depth` and `variance` are the guide buffers `traceNative` returns. The result is smoothed and biased: it is not
 * a converged image. Returns `{ rgba, compileSeconds, uploadSeconds, gpuSeconds, readbackSeconds }`.
 */
export function denoiseAtrous({ width, height, rgba, albedo, normal, depth, variance }) {
  const pixelCount = width * height;
  validateImagePixelCount(width, height, 'denoiseAtrous');
  const planes = { rgba: [rgba, 4], albedo: [albedo, 3], normal: [normal, 3], depth: [depth, 1], variance: [variance, 1] };
  for (const [name, [plane, floatsPerPixel]] of Object.entries(planes)) {
    if (!(plane instanceof Float32Array) || plane.length !== pixelCount * floatsPerPixel) {
      throw new TypeError(`denoiseAtrous: \`${name}\` must be a Float32Array of ${pixelCount * floatsPerPixel} floats for a ${width}x${height} image.`);
    }
  }
  return loadAddon().denoiseAtrous({ width, height, rgba, albedo, normal, depth, variance });
}

/**
 * Opens a persistent OIDN device and filter inside the addon. The OIDN shared library is loaded at run time from
 * `libraryPath` (`findOidnLibrary()` of the denoise package), so the addon works without it. Returns the native object
 * with `denoise({ width, height, color, albedo, normal })`, `close()` and `deviceSeconds`. Use
 * `createOidnDenoiser` of the denoise package for the wrapper that jobs call.
 */
export function createNativeOidnDenoiser({ libraryPath, device = 'cpu', quality = 'high', cleanAux = false, threads = 0 }) {
  if (typeof libraryPath !== 'string' || libraryPath === '') {
    throw new TypeError('createNativeOidnDenoiser: pass `libraryPath`, the OIDN shared library (findOidnLibrary() in the denoise package).');
  }
  const addon = loadAddon();
  if (typeof addon.OidnDenoiser !== 'function') {
    throw new Error('The built native tracer has no OIDN support: run `npm run build` in the Cook package again.');
  }
  return new addon.OidnDenoiser({ libraryPath, device, quality, cleanAux, threads });
}

const KERNEL_PARAMS_V2_SEED_BYTE_OFFSET = 28;

function withSeed(kernelParams, seed) {
  const patchedParams = new Uint8Array(kernelParams);
  new DataView(patchedParams.buffer, patchedParams.byteOffset, patchedParams.byteLength).setUint32(KERNEL_PARAMS_V2_SEED_BYTE_OFFSET, seed, true);
  return patchedParams;
}

// The frame's block with the camera and seed that the caller gave to `render` itself: the camera replaces the camera words of the
// block the frame would use, and the seed replaces the seed word. A seed in the session options is not applied: it is usually the
// pack options' seed, which the input already carries, and writing it would override the seed of a block passed per frame.
function withFrameCameraAndSeed(baseKernelParams, camera, seed, frameSize) {
  if (camera !== undefined) {
    return packCameraParams(baseKernelParams, camera, { width: frameSize.width, height: frameSize.height, seed });
  }
  return seed === undefined ? baseKernelParams : withSeed(baseKernelParams, seed);
}

function hasFilterOptions(options) {
  return options.filterType !== undefined || options.pixelFilter !== undefined || options.filterWidth !== undefined;
}

// A packed input already carries its filter; explicit options replace it. A new type without a width gets that type's
// default width, as the packer does; a width alone keeps the packed type.
// Exported for tests; not part of the public API.
export function withFilterOptions(kernelParams, options) {
  const patchedParams = new Uint8Array(kernelParams);
  const view = new DataView(patchedParams.buffer, patchedParams.byteOffset, patchedParams.byteLength);
  const requestedType = options.filterType ?? options.pixelFilter;
  const filterType = requestedType !== undefined
    ? filterTypeCode(requestedType)
    : view.getUint32(KERNEL_PARAMS_V2_FILTER_TYPE_BYTE_OFFSET, true);
  const filterWidth = options.filterWidth !== undefined || requestedType !== undefined
    ? resolveFilterParameters({ filterType, filterWidth: options.filterWidth }).filterWidth
    : view.getFloat32(KERNEL_PARAMS_V2_FILTER_WIDTH_BYTE_OFFSET, true);
  view.setUint32(KERNEL_PARAMS_V2_FILTER_TYPE_BYTE_OFFSET, filterType, true);
  view.setFloat32(KERNEL_PARAMS_V2_FILTER_WIDTH_BYTE_OFFSET, filterWidth, true);
  return patchedParams;
}

function hasLightTreeEmitterTables(v2Input) {
  return Boolean(v2Input.lightTreeEmitters && v2Input.lightToTree && v2Input.lightTreeEmitterCount !== undefined);
}

// Exported for tests; not part of the public API.
export function withLightSamplingFlag(v2Input, lightSampling) {
  const patchedParams = new Uint8Array(v2Input.kernelParams);
  const view = new DataView(patchedParams.buffer, patchedParams.byteOffset, patchedParams.byteLength);
  const flags = view.getUint32(KERNEL_PARAMS_V2_KERNEL_FLAGS_BYTE_OFFSET, true);
  const emitterCount = (v2Input.lightCount ?? 0) + (v2Input.emissiveTriangleCount ?? 0);
  let lightTreeNodeCount = v2Input.lightTreeNodeCount ?? 0;
  if (lightTreeNodeCount > 0 && !hasLightTreeEmitterTables(v2Input)) {
    if (lightSampling === 'tree') {
      throw new TypeError(
        'traceNative: lightSampling "tree" needs the emitter tables (lightTreeEmitters, lightTreeEmitterCount, lightToTree), which this packed FORMAT-v2 input lacks. Repack the scene with buildNativeInputV2.'
      );
    }
    lightTreeNodeCount = 0;
  }
  const useTree = resolveUseLightTree(lightSampling, emitterCount, lightTreeNodeCount);
  const patchedFlags = useTree
    ? (flags | KERNEL_FLAG_USE_LIGHT_TREE) >>> 0
    : (flags & ~KERNEL_FLAG_USE_LIGHT_TREE) >>> 0;
  view.setUint32(KERNEL_PARAMS_V2_KERNEL_FLAGS_BYTE_OFFSET, patchedFlags, true);
  return patchedParams;
}

function withSamplerFlag(kernelParams, sampler) {
  const patchedParams = new Uint8Array(kernelParams);
  const view = new DataView(patchedParams.buffer, patchedParams.byteOffset, patchedParams.byteLength);
  const flags = view.getUint32(KERNEL_PARAMS_V2_KERNEL_FLAGS_BYTE_OFFSET, true);
  const patchedFlags = sampler === 'white'
    ? (flags | KERNEL_FLAG_WHITE_NOISE_SAMPLER) >>> 0
    : (flags & ~KERNEL_FLAG_WHITE_NOISE_SAMPLER) >>> 0;
  view.setUint32(KERNEL_PARAMS_V2_KERNEL_FLAGS_BYTE_OFFSET, patchedFlags, true);
  return patchedParams;
}

/**
 * Builds the FORMAT-v2 input of the `cycles` kernel from a v1 or v2 input and the trace options, patching the kernel flags
 * the options set. Exported for tests; not part of the public API.
 */
export function prepareCyclesInput(input, options = {}) {
  if (input?.schemaVersion === FORMAT_V2_VERSION) {
    return { ...input, kernelParams: patchedCyclesKernelParams(input, input.kernelParams, options, 'traceNative') };
  }
  resolveSamplingOptions(options, 'traceNative');
  const upgradedInput = upgradeNativeInputV1ToV2(input, options);
  const pathRegeneration = options.pathRegeneration ?? DEFAULT_PATH_REGENERATION;
  return { ...upgradedInput, kernelParams: withPathRegenerationFlag(upgradedInput.kernelParams, pathRegeneration) };
}

// Exported for tests; not part of the public API.
export function withPathRegenerationFlag(kernelParams, pathRegeneration) {
  const patchedParams = new Uint8Array(kernelParams);
  const view = new DataView(patchedParams.buffer, patchedParams.byteOffset, patchedParams.byteLength);
  const flags = view.getUint32(KERNEL_PARAMS_V2_KERNEL_FLAGS_BYTE_OFFSET, true);
  const patchedFlags = pathRegeneration
    ? (flags | KERNEL_FLAG_PATH_REGENERATION) >>> 0
    : (flags & ~KERNEL_FLAG_PATH_REGENERATION) >>> 0;
  view.setUint32(KERNEL_PARAMS_V2_KERNEL_FLAGS_BYTE_OFFSET, patchedFlags, true);
  return patchedParams;
}

function buildProbeKernelParams({ width, height, mode, seed, sampleOffset, wo, frontFace, materialCount, textureCount }) {
  const buffer = new ArrayBuffer(STRUCT_STRIDES_V2.kernelParams);
  const f32 = new Float32Array(buffer);
  const u32 = new Uint32Array(buffer);
  const length = Math.hypot(wo[0], wo[1], wo[2]);
  if (!(length > 1e-12) || !wo.every(Number.isFinite)) {
    throw new RangeError('probeCyclesLobe option `wo` must be a non-zero finite 3D vector.');
  }
  u32[0] = FORMAT_V2_MAGIC;
  u32[1] = FORMAT_V2_VERSION;
  u32[2] = width >>> 0;
  u32[3] = height >>> 0;
  u32[4] = (sampleOffset ?? 0) >>> 0;
  u32[5] = 1;
  u32[6] = 1;
  u32[7] = (seed ?? 1) >>> 0;
  u32[8] = (mode ?? 0) >>> 0;
  u32[23] = materialCount >>> 0;
  u32[27] = textureCount >>> 0;
  f32[31] = frontFace === false ? -1.0 : 1.0;
  f32[32] = wo[0] / length;
  f32[33] = wo[1] / length;
  f32[34] = wo[2] / length;
  f32[35] = 1e30;
  f32[72] = 1.0;
  return new Uint8Array(buffer);
}

/**
 * Dispatches entry point `"test_lobe_samples"` on the assembled Cycles shader and returns the raw un-divided
 * `Float32Array` of all 4 `film_accumulation` planes (`4 * width * height * 4` floats).
 */
export function probeCyclesLobe(options = {}) {
  const width = options.width ?? 512;
  const height = options.height ?? 512;
  if (!Number.isInteger(width) || width < 1 || width > 16384 || !Number.isInteger(height) || height < 1 || height > 16384) {
    throw new RangeError(`probeCyclesLobe requires integer \`width\` and \`height\` in [1, 16384]; got width=${width}, height=${height}.`);
  }
  validateImagePixelCount(width, height, 'probeCyclesLobe');
  validateMaxSeconds(options.maxSeconds, 'probeCyclesLobe');
  const wo = options.wo ?? [0, 0, 1];
  if (!Array.isArray(wo) && !ArrayBuffer.isView(wo) || wo.length !== 3) {
    throw new TypeError('probeCyclesLobe option `wo` must hold 3 numbers.');
  }

  let materials;
  if (options.materialBytes !== undefined) {
    if (!(options.materialBytes instanceof Uint8Array) || options.materialBytes.byteLength < STRUCT_STRIDES_V2.material || options.materialBytes.byteLength % STRUCT_STRIDES_V2.material !== 0) {
      throw new TypeError(`probeCyclesLobe option \`materialBytes\` must be a Uint8Array of a positive multiple of ${STRUCT_STRIDES_V2.material} bytes.`);
    }
    materials = options.materialBytes;
  } else {
    materials = packMaterialRecordV2(options.material ?? {}, null).bytes;
  }

  const materialCount = materials.byteLength / STRUCT_STRIDES_V2.material;
  const textureDescriptors = options.textureDescriptors;
  const textureCount = textureDescriptors ? Math.floor(textureDescriptors.byteLength / STRUCT_STRIDES_V2.textureDescriptor) : 0;
  const kernelParams = options.kernelParams instanceof Uint8Array
    ? options.kernelParams
    : buildProbeKernelParams({
      width,
      height,
      mode: options.mode ?? 0,
      seed: options.seed ?? 1,
      sampleOffset: options.sampleOffset,
      wo,
      frontFace: options.frontFace ?? true,
      materialCount,
      textureCount,
    });

  const addon = loadAddon();
  return withTimeLimitCode(() => addon.probeCyclesLobe({
    width,
    height,
    kernelParams,
    materials,
    textureDescriptors,
    textureTexels: options.textureTexels,
    maxSeconds: options.maxSeconds,
    bootstrapKernel: options.bootstrapKernel,
  }));
}

/**
 * The light bake: traces `samples` cosine weighted paths from every texel of `texels` (`count`, `points`, `normals`) and
 * returns the mean `radiance` (three floats per texel) and the share of first rays that `escaped`. The input comes from
 * `buildNativeTexelInput`.
 */
export function traceNativeTexels(input, texels, { samples, maxSeconds }) {
  requireReadablePackRevision(input, 'traceNativeTexels');
  validateMaxSeconds(maxSeconds, 'traceNativeTexels');
  const addon = loadAddon();
  return withTimeLimitCode(() => addon.traceTexels(input, texels, { samples, maxSeconds }));
}

/**
 * Loads the native addon and returns it. Throws when it is not built, or when the file cannot be loaded (built for another
 * platform, a shared library missing, or `COOK_ADDON_PATH` naming a file that is not an addon); the message says which.
 */
export function loadNativeAddon() {
  const addonPath = findNativeAddon();
  if (!addonPath) throw new Error('The native tracer is not built. Run `npx cook fetch-addon` to download the prebuilt one (Windows x64, Linux x64), or `npm run build` in the Cook package to compile it with Rust, or set COOK_ADDON_PATH to a built render-native.node.');
  let addon;
  try {
    addon = createRequire(import.meta.url)(addonPath);
  } catch (loadError) {
    throw new Error(
      `The native addon at ${JSON.stringify(addonPath)} cannot be loaded: ${loadError.message}. Build it again with \`npm run build\` on this machine, or point COOK_ADDON_PATH at a matching render-native.node.`,
      { cause: loadError }
    );
  }
  verifyAddonBuildInfo(addon, addonPath);
  return addon;
}

/**
 * What the adapter can hold, read before a scene is exported: `deviceLocalMemoryBytes` (undefined when the driver reports no
 * device-local heap, with the reason in `deviceLocalMemorySource`), `largestTableBytes` (the most one table of the packed scene
 * may take), the bytes one unique triangle (`triangleTableBytes` + `triangleVertexBytes`), instance (`instanceTableBytes`) and
 * texture texel (`texelBytes`) cost, and the counts those allow (`maxUniqueTriangles`, `maxInstances`, `maxTextureTexels`).
 * The costs are the packed tables only; the acceleration structure is sized by the driver (`includesAccelerationStructure` is false).
 * A scene over a limit fails in `traceNative` with one error that names the table, its size, the limit and the overshoot.
 */
export function readAdapterCapacity() {
  const addon = loadNativeAddon();
  if (typeof addon.adapterCapacity !== 'function') {
    throw new Error('This native addon was built before adapterCapacity existed. Build it again with `npm run build` or fetch a newer one with `npx cook fetch-addon`.');
  }
  return addon.adapterCapacity();
}

const warnedAddonPaths = new Set();

/** The version the package.json next to this file declares: the addon built from this checkout reports the same one. */
function readPackageVersion() {
  const packageJsonPath = join(PACKAGE_DIRECTORY, 'package.json');
  return JSON.parse(readFileSync(packageJsonPath, 'utf8')).version;
}

/**
 * Compares what an addon reports about its build (`addonBuildInfo()`) with this package. Returns
 * `{ status: 'match' }`, `{ status: 'unknown' }` for an addon that lacks the export (prebuilt v0.1.0 and v0.1.1), or
 * `{ status: 'mismatch', differences: [...] }` where each difference says what differs.
 */
export function compareAddonBuildInfo(addonBuildInfo, expected = { version: readPackageVersion(), packRevision: PACK_REVISION }) {
  if (typeof addonBuildInfo !== 'function') return { status: 'unknown' };
  const reported = addonBuildInfo();
  const differences = [];
  if (reported.version !== expected.version) {
    differences.push(`the addon was built from version ${reported.version} and the package is version ${expected.version}`);
  }
  if (reported.packRevision !== expected.packRevision) {
    differences.push(`the addon reads pack revision ${reported.packRevision} and the package writes pack revision ${expected.packRevision}`);
  }
  return differences.length === 0 ? { status: 'match' } : { status: 'mismatch', differences };
}

/** Throws when the addon was built from other sources than this package; warns once when it cannot tell. */
export function verifyAddonBuildInfo(addon, addonPath, expected) {
  const result = compareAddonBuildInfo(addon.addonBuildInfo, expected);
  if (result.status === 'mismatch') {
    throw new Error(
      `The native addon at ${JSON.stringify(addonPath)} does not match this package: ${result.differences.join('; ')}. Run \`npx cook fetch-addon\` to download the addon of this version, or \`npm run build\` to compile it from these sources.`
    );
  }
  if (result.status === 'unknown' && !warnedAddonPaths.has(addonPath)) {
    warnedAddonPaths.add(addonPath);
    process.emitWarning(
      `The native addon at ${JSON.stringify(addonPath)} predates the version check, so Cook cannot tell whether it matches this package. If renders fail oddly, run \`npx cook fetch-addon\` or \`npm run build\`.`,
      'CookAddonWarning'
    );
  }
}

function loadAddon() {
  return loadNativeAddon();
}

// ---- Persistent session (issue 896) ----

function requireSessionKernelParams(kernelParams, callerName) {
  if (!(kernelParams instanceof Uint8Array) || kernelParams.byteLength !== STRUCT_STRIDES_V2.kernelParams) {
    throw new TypeError(
      `${callerName}: \`kernelParams\` must be a Uint8Array of ${STRUCT_STRIDES_V2.kernelParams} bytes (the KernelParamsV2 block of buildNativeInputV2).`
    );
  }
}

function requireCyclesKernelOption(kernel, callerName) {
  if (kernel !== undefined && resolveNativeKernel(kernel) !== 'cycles') {
    throw new TypeError(`${callerName}: a native session runs the "cycles" kernel only; got kernel "${kernel}". Use traceNative for the legacy kernel.`);
  }
}

function mergeDefinedOptions(sessionOptions, renderOptions) {
  const merged = { ...sessionOptions };
  for (const [name, value] of Object.entries(renderOptions)) {
    if (value !== undefined) merged[name] = value;
  }
  return merged;
}

// The kernel parameters of a FORMAT-v2 input after the sampling, filter and light options of `options`, the one place the patches live (traceNative and sessions share it), in a fixed
// order.
function patchedCyclesKernelParams(v2Input, kernelParams, options, callerName) {
  const { sampler, lightSampling } = resolveSamplingOptions(options, callerName);
  validatePathRegenerationOption(options.pathRegeneration, callerName);
  let patchedParams = new Uint8Array(kernelParams);
  const explicitFilterGlossy = options.filterGlossy ?? options.blurGlossy;
  if (explicitFilterGlossy !== undefined) {
    const rawFilterGlossy = Number(explicitFilterGlossy);
    const resolvedFilterGlossy = Number.isFinite(rawFilterGlossy) && rawFilterGlossy > 0 ? rawFilterGlossy : 0.0;
    new DataView(patchedParams.buffer, patchedParams.byteOffset, patchedParams.byteLength).setFloat32(KERNEL_PARAMS_V2_FILTER_GLOSSY_BYTE_OFFSET, resolvedFilterGlossy, true);
  }
  if (hasFilterOptions(options)) patchedParams = withFilterOptions(patchedParams, options);
  if (sampler !== undefined) patchedParams = withSamplerFlag(patchedParams, sampler);
  patchedParams = withPathRegenerationFlag(patchedParams, options.pathRegeneration ?? DEFAULT_PATH_REGENERATION);
  if (lightSampling !== undefined) patchedParams = withLightSamplingFlag({ ...v2Input, kernelParams: patchedParams }, lightSampling);
  return patchedParams;
}

// Exported for tests; not part of the public API.
export function resolveSessionCreation(input, options, callerName = 'createNativeSession') {
  if (input === null || typeof input !== 'object') {
    throw new TypeError(`${callerName}: \`input\` must be a FORMAT-v2 input object from buildNativeInputV2.`);
  }
  if (input.schemaVersion !== FORMAT_V2_VERSION) {
    throw new TypeError(
      `${callerName}: \`input.schemaVersion\` must be ${FORMAT_V2_VERSION} (a FORMAT-v2 input from buildNativeInputV2); got ${JSON.stringify(input.schemaVersion)}. Convert a v1 input with upgradeNativeInputV1ToV2.`
    );
  }
  requireReadablePackRevision(input, callerName);
  requireSessionKernelParams(input.kernelParams, callerName);
  if (options === null || typeof options !== 'object') {
    throw new TypeError(`${callerName}: \`options\` must be an object.`);
  }
  requireCyclesKernelOption(options.kernel, callerName);
  validatePackOptions(options, callerName);
  const kernelParams = patchedCyclesKernelParams(input, input.kernelParams, options, callerName);
  if (options.width !== undefined && options.height !== undefined) {
    requireHeldCameraMatchesImageSize(kernelParams, options.width, options.height, callerName);
  }
  return { ...input, kernelParams };
}

// Exported for tests; not part of the public API.
export function resolveSessionFrame(sessionInput, sessionOptions, renderOptions) {
  if (renderOptions === null || typeof renderOptions !== 'object') {
    throw new TypeError('NativeSession.render: `renderOptions` must be an object.');
  }
  const options = mergeDefinedOptions(sessionOptions, renderOptions);
  requireCyclesKernelOption(options.kernel, 'NativeSession.render');
  validatePackOptions(options, 'NativeSession.render', true);
  validateSeedOption(renderOptions.seed, 'NativeSession.render');
  let baseKernelParams = sessionInput.kernelParams;
  if (renderOptions.kernelParams !== undefined) {
    requireSessionKernelParams(renderOptions.kernelParams, 'NativeSession.render');
    baseKernelParams = renderOptions.kernelParams;
  }
  baseKernelParams = withFrameCameraAndSeed(baseKernelParams, renderOptions.camera, renderOptions.seed, options);
  const kernelParams = patchedCyclesKernelParams(sessionInput, baseKernelParams, options, 'NativeSession.render');
  const { width, height, samples, samplesPerDispatch, dispatchBudgetMs, maxSeconds, bootstrapKernel, denoise, accumulate, targetSamples } = options;
  requireHeldCameraMatchesImageSize(kernelParams, width, height, 'NativeSession.render');
  validateProgressiveOptions({ accumulate, targetSamples, samples });
  const post = resolvePostOption(options.post, 'NativeSession.render');
  return { width, height, samples, samplesPerDispatch, dispatchBudgetMs, maxSeconds, bootstrapKernel, denoise, kernelParams, accumulate, targetSamples, post };
}

const MAX_TARGET_SAMPLES = 16777216;

function validateProgressiveOptions({ accumulate, targetSamples, samples }) {
  if (accumulate !== undefined && typeof accumulate !== 'boolean') {
    throw new TypeError(`NativeSession.render: \`accumulate\` must be true, false or left out, got ${JSON.stringify(accumulate)}.`);
  }
  if (targetSamples === undefined) return;
  if (accumulate !== true) {
    throw new TypeError('NativeSession.render: `targetSamples` only applies with `accumulate: true`. Pass accumulate: true to build one image over several render calls.');
  }
  if (!Number.isInteger(targetSamples) || targetSamples < 1 || targetSamples > MAX_TARGET_SAMPLES) {
    throw new RangeError(`NativeSession.render: \`targetSamples\` must be an integer in [1, ${MAX_TARGET_SAMPLES}]; got ${JSON.stringify(targetSamples)}.`);
  }
  if (samples > targetSamples) {
    throw new RangeError(`NativeSession.render: \`samples\` (${samples}) is more than \`targetSamples\` (${targetSamples}). Pass targetSamples as the total for the whole image.`);
  }
}

// ---- Scene updates ----

const UPDATE_COUNT_NAMES = [
  'instanceCount', 'triangleCount', 'materialCount', 'emissiveTriangleCount', 'lightCount', 'portalCount', 'lightTreeNodeCount', 'lightTreeEmitterCount', 'textureCount',
];
// Tables a session update cannot change, with what each holds, for the error.
const UPDATE_FIXED_TABLES = [
  ['triangles', 'the geometry'],
  ['textureDescriptors', 'the textures'],
  ['textureTexels', 'the textures'],
  ['environmentTexels', 'the environment map'],
];
// Tables a session update can replace: same size, new values.
const UPDATE_VALUE_TABLES = ['instances', 'materials', 'emissiveTriangles', 'lights', 'lightTreeNodes', 'lightTreeEmitters', 'lightToTree'];
const INSTANCE_RECORD_BYTE_LENGTH = 160;
const INSTANCE_TOPOLOGY_FIELDS = [['blasIndex', 96], ['triangleOffset', 100], ['opaqueTriangleCount', 104], ['totalTriangleCount', 108]];

function bytesOfTable(table) {
  return table === undefined || table === null ? Buffer.alloc(0) : Buffer.from(table.buffer, table.byteOffset, table.byteLength);
}

function sameTableBytes(first, second) {
  return bytesOfTable(first).equals(bytesOfTable(second));
}

function refuseUpdate(detail) {
  return new Error(`NativeSession.update: ${detail} Create a new session with createNativeSession(input) for this input.`);
}

function checkUpdateKeepsRecordCounts(current, next) {
  for (const name of UPDATE_COUNT_NAMES) {
    const heldCount = current[name] ?? 0;
    const newCount = next[name] ?? 0;
    if (heldCount !== newCount) {
      throw refuseUpdate(`\`${name}\` changes from ${heldCount} to ${newCount}; a session keeps the tables at the size it was created with.`);
    }
  }
}

function checkUpdateKeepsFixedTables(current, next) {
  for (const [name, holds] of UPDATE_FIXED_TABLES) {
    if (!sameTableBytes(current[name], next[name])) {
      throw refuseUpdate(`\`${name}\` differs, and it holds ${holds}; a session update changes values of materials, lights and instance transforms only.`);
    }
  }
}

function checkUpdateKeepsInstanceMeshes(currentInstances, nextInstances) {
  const heldBytes = bytesOfTable(currentInstances);
  const newBytes = bytesOfTable(nextInstances);
  for (let offset = 0; offset < newBytes.length; offset += INSTANCE_RECORD_BYTE_LENGTH) {
    for (const [fieldName, fieldOffset] of INSTANCE_TOPOLOGY_FIELDS) {
      const heldWord = heldBytes.readUInt32LE(offset + fieldOffset);
      const newWord = newBytes.readUInt32LE(offset + fieldOffset);
      if (heldWord !== newWord) {
        throw refuseUpdate(`instance ${offset / INSTANCE_RECORD_BYTE_LENGTH} changes \`${fieldName}\` from ${heldWord} to ${newWord}; an update may move or restyle an instance but not change the mesh it places.`);
      }
    }
  }
}

/**
 * Compares a new FORMAT-v2 input with the one a session holds and returns the tables to send: those whose bytes changed.
 * Refuses, naming what changed, an input with other record counts, other geometry, textures or environment, or instances
 * that place other meshes. Exported for tests; not part of the public API.
 */
export function planNativeSessionUpdate(currentInput, nextInput) {
  checkUpdateKeepsRecordCounts(currentInput, nextInput);
  checkUpdateKeepsFixedTables(currentInput, nextInput);
  const changedTables = {};
  for (const name of UPDATE_VALUE_TABLES) {
    if (!sameTableBytes(currentInput[name], nextInput[name])) changedTables[name] = nextInput[name];
  }
  if (changedTables.instances !== undefined) {
    checkUpdateKeepsInstanceMeshes(currentInput.instances, nextInput.instances);
  }
  return changedTables;
}

// Exported for tests, which pass a stand-in for the addon's session class; not part of the public API.
export function wrapNativeSession(nativeSession, sessionInput, sessionOptions) {
  let closed = false;
  let heldInput = sessionInput;
  function requireOpen(methodName) {
    if (closed) {
      throw new Error(`NativeSession.${methodName}: this session is closed. Create a new one with createNativeSession(input).`);
    }
  }
  return {
    get closed() {
      return closed;
    },
    render(renderOptions = {}) {
      requireOpen('render');
      const frame = resolveSessionFrame(heldInput, sessionOptions, renderOptions);
      const { trace, session } = withTimeLimitCode(() => nativeSession.render(frame));
      return { ...trace, ...session };
    },
    reset() {
      requireOpen('reset');
      nativeSession.reset();
    },
    resolve(resolveOptions = {}) {
      requireOpen('resolve');
      if (resolveOptions === null || typeof resolveOptions !== 'object') {
        throw new TypeError('NativeSession.resolve: `resolveOptions` must be an object.');
      }
      const denoise = resolveOptions.denoise ?? sessionOptions.denoise;
      validateDenoiseOption(denoise, 'NativeSession.resolve');
      const post = resolvePostOption(resolveOptions.post ?? sessionOptions.post, 'NativeSession.resolve');
      const { trace, session } = nativeSession.resolve({ denoise, post });
      return { ...trace, ...session };
    },
    update(newInput) {
      requireOpen('update');
      const nextInput = resolveSessionCreation(newInput, sessionOptions, 'NativeSession.update');
      const changedTables = planNativeSessionUpdate(heldInput, nextInput);
      const report = nativeSession.update({ kernelParams: nextInput.kernelParams, ...changedTables });
      heldInput = nextInput;
      return report;
    },
    close() {
      if (closed) return;
      closed = true;
      nativeSession.close();
    },
  };
}

/**
 * Keeps a FORMAT-v2 scene on the GPU between frames (the `cycles` kernel only). `render(renderOptions)` takes what
 * `traceNative` takes (`width`, `height`, `samples`, `samplesPerDispatch`, `maxSeconds`, `denoise`, the sampling and filter
 * options) and returns what it returns plus `pipelineReused`, `accelerationReused`, `filmReused` and `frameIndex`. A later frame
 * with the same scene compiles no shader (while the specialized kernel text is unchanged) and builds no acceleration structure; a
 * frame at the same size also keeps the film. `renderOptions.camera` brings another camera of the same scene (the object
 * `buildNativeInputV2` takes, built for the frame's size) and `seed` another sampling seed, both without packing the scene
 * again: the frame's block is the session's block with those words replaced (see `packCameraParams`). `renderOptions.kernelParams`
 * brings the block of a second `buildNativeInputV2` call instead, and `camera` and `seed` then apply on top of it. A `seed` given
 * to `render` is written (a whole number from 0 to 4294967295); without one the block's seed stays, and a `seed` in the session
 * `options` is not applied. `options` are defaults for every frame. `close()` frees the card.
 * A frame equals the `traceNative` render of the same input and options byte for byte.
 *
 * Progressive film: `render({ samples, accumulate: true, targetSamples })` adds `samples` to the image instead of starting a new
 * one, so an image can grow over several calls (the first call of an image sets `targetSamples`, the total it will hold; later
 * calls leave it out). The calls continue one sample sequence, so the film after all of them equals one render of `targetSamples`
 * samples byte for byte. The reports carry `firstSample`, `filmSamples` and `targetSamples`. `reset()` starts the image over.
 * `resolve({ denoise, post })` returns the film as it stands without tracing. A later call must keep the size and the render settings
 * (camera, seed, sampler) of the first; a plain frame (no `accumulate`) discards the progressive image.
 *
 * Post stage: `render({ post })` and `resolve({ post })` also return `display`, a Uint8Array of 8-bit sRGB RGBA (width * height * 4, row by
 * row from the top) made on the GPU from the film after the denoise, with `postSeconds`. `post` is { exposure, viewTransform: 'agx' |
 * 'aces' | 'neutral' | 'standard', whiteBalance, lift, gamma, gain, bloom: { strength, radius, threshold }, grain: { amount, seed },
 * vignette: { strength } }, every field optional and bounded; docs/post-stage.md has the ranges, the order and the tolerance against
 * Crucible's JavaScript. Without `post` the result is unchanged.
 *
 * `update(newInput)` takes a FORMAT-v2 input packed from the same scene with other material values, lights, emission or instance
 * transforms and applies it without a new pipeline or BLAS build (the TLAS is rebuilt when a transform changed). It returns
 * `uploadedTables`, `accelerationRebuilt`, `changedInstances`, `kernelRespecialized` and the seconds. It clears the film, and a
 * following frame equals the `traceNative` render of `newInput`. A change of record counts, geometry, textures, the environment
 * map or of the mesh an instance places is refused with an error that says to create a new session.
 */
export function createNativeSession(input, options = {}) {
  const sessionInput = resolveSessionCreation(input, options);
  const addon = loadAddon();
  if (typeof addon.NativeCyclesSession !== 'function') {
    throw new Error('The built native addon has no session support. Run `npm run build` in the Cook package.');
  }
  return wrapNativeSession(new addon.NativeCyclesSession(sessionInput), sessionInput, options);
}
