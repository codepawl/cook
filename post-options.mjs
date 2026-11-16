// Validation of the `post` option of `session.render` and `session.resolve`: the optional GPU stage that turns the resolved
// film into 8-bit sRGB RGBA. Every field is optional; the result carries every field, defaulted, in the shape the addon takes.

export const POST_VIEW_TRANSFORMS = Object.freeze(['agx', 'aces', 'neutral', 'standard']);

const POST_FIELDS = ['exposure', 'viewTransform', 'whiteBalance', 'lift', 'gamma', 'gain', 'bloom', 'grain', 'vignette'];
const BLOOM_FIELDS = ['strength', 'radius', 'threshold'];
const GRAIN_FIELDS = ['amount', 'seed'];
const VIGNETTE_FIELDS = ['strength'];

function describe(value) {
  return typeof value === 'number' ? String(value) : JSON.stringify(value) ?? String(value);
}

function requireObject(value, path, example) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object such as ${example}, got ${describe(value)}.`);
  }
}

function rejectUnknownFields(object, allowedFields, path) {
  for (const name of Object.keys(object)) {
    if (!allowedFields.includes(name)) {
      throw new RangeError(`${path}.${name} is not a post option; use one of ${allowedFields.join(', ')}.`);
    }
  }
}

function numberInRange(value, fallback, minimum, maximum, path) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${path} must be a number from ${minimum} to ${maximum}, got ${describe(value)}.`);
  }
  return value;
}

/** A number for all three channels, or [red, green, blue]. */
function channelTriple(value, fallback, minimum, maximum, path) {
  if (value === undefined) return [fallback, fallback, fallback];
  if (Array.isArray(value)) {
    if (value.length !== 3) {
      throw new RangeError(`${path} must be a number or three numbers [red, green, blue] from ${minimum} to ${maximum}, got ${describe(value)}.`);
    }
    return value.map((channel, index) => numberInRange(channel, fallback, minimum, maximum, `${path}[${index}]`));
  }
  const single = numberInRange(value, fallback, minimum, maximum, path);
  return [single, single, single];
}

function resolveBloom(bloom, path) {
  if (bloom === undefined) return { strength: 0, radius: 1, threshold: 1 };
  requireObject(bloom, path, '{ strength: 0.2, radius: 1, threshold: 1 }');
  rejectUnknownFields(bloom, BLOOM_FIELDS, path);
  return {
    strength: numberInRange(bloom.strength, 0, 0, 4, `${path}.strength`),
    radius: numberInRange(bloom.radius, 1, 0, 8, `${path}.radius`),
    threshold: numberInRange(bloom.threshold, 1, 0, 64, `${path}.threshold`),
  };
}

function resolveGrain(grain, path) {
  if (grain === undefined) return { amount: 0, seed: 0 };
  requireObject(grain, path, '{ amount: 0.02, seed: 7 }');
  rejectUnknownFields(grain, GRAIN_FIELDS, path);
  const seed = grain.seed ?? 0;
  if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) {
    throw new RangeError(`${path}.seed must be a whole number from 0 to 4294967295, got ${describe(grain.seed)}.`);
  }
  return { amount: numberInRange(grain.amount, 0, 0, 0.1, `${path}.amount`), seed };
}

function resolveVignette(vignette, path) {
  if (vignette === undefined) return { strength: 0 };
  requireObject(vignette, path, '{ strength: 0.2 }');
  rejectUnknownFields(vignette, VIGNETTE_FIELDS, path);
  return { strength: numberInRange(vignette.strength, 0, 0, 1, `${path}.strength`) };
}

/**
 * Checks a `post` option and returns the complete look the addon takes, or undefined when `post` is left out.
 * `label` names the call in errors, such as `NativeSession.render`.
 */
export function resolvePostOption(post, label) {
  if (post === undefined) return undefined;
  const path = `${label}: post`;
  requireObject(post, path, '{ viewTransform: "agx", exposure: 1 }');
  rejectUnknownFields(post, POST_FIELDS, path);
  const viewTransform = post.viewTransform ?? 'agx';
  if (!POST_VIEW_TRANSFORMS.includes(viewTransform)) {
    throw new RangeError(`${path}.viewTransform must be one of ${POST_VIEW_TRANSFORMS.join(', ')}, got ${describe(post.viewTransform)}.`);
  }
  const bloom = resolveBloom(post.bloom, `${path}.bloom`);
  const grain = resolveGrain(post.grain, `${path}.grain`);
  const vignette = resolveVignette(post.vignette, `${path}.vignette`);
  return {
    exposure: numberInRange(post.exposure, 1, 0.01, 16, `${path}.exposure`),
    viewTransform,
    whiteBalance: numberInRange(post.whiteBalance, 0, -1, 1, `${path}.whiteBalance`),
    lift: channelTriple(post.lift, 0, -0.5, 0.5, `${path}.lift`),
    gamma: channelTriple(post.gamma, 1, 0.2, 5, `${path}.gamma`),
    gain: channelTriple(post.gain, 1, 0, 4, `${path}.gain`),
    bloomStrength: bloom.strength,
    bloomRadius: bloom.radius,
    bloomThreshold: bloom.threshold,
    grainAmount: grain.amount,
    grainSeed: grain.seed,
    vignetteStrength: vignette.strength,
  };
}
