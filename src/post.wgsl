// The optional post stage of a resolved film: exposure, bloom, a view transform, the display encode, white balance,
// lift/gamma/gain, vignette and grain, written as 8-bit RGBA. The maths follows Crucible's view-transform.js and post.js;
// `tests/helpers/post-reference.mjs` is the JavaScript twin that the GPU tests compare against.
//
// Bloom works on an eighth-resolution copy: bloom_down averages 8x8 pixels of the thresholded colour, bloom_blur_horizontal
// and bloom_blur_vertical blur it with a gaussian, and finish upsamples it bilinearly and adds it before the view transform.

struct Parameters {
    // width, height, bloom width, bloom height
    sizes: vec4<u32>,
    // exposure, white balance, bloom strength, bloom threshold
    tone: vec4<f32>,
    lift: vec4<f32>,
    gamma: vec4<f32>,
    gain: vec4<f32>,
    // vignette strength, grain amount, bloom sigma in bloom pixels, unused
    finish: vec4<f32>,
    // view transform (0 standard, 1 aces, 2 agx, 3 neutral), grain seed, bloom blur taps each side, bloom on (0 or 1)
    switches: vec4<u32>,
}

@group(0) @binding(0) var<uniform> parameters: Parameters;
@group(0) @binding(1) var<storage, read> film: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> bloom_a: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> bloom_b: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> display: array<u32>;

const BLOOM_CELL: u32 = 8u;
const AGX_INSET = mat3x3<f32>(
    vec3<f32>(0.57215, 0.12368, 0.09814),
    vec3<f32>(0.33216, 0.74091, 0.19729),
    vec3<f32>(0.09569, 0.13541, 0.70457),
);
const AGX_OUTSET = mat3x3<f32>(
    vec3<f32>(1.84762, -0.2341, -0.19713),
    vec3<f32>(-0.70741, 1.3225, -0.30062),
    vec3<f32>(-0.14021, -0.0884, 1.49775),
);
const AGX_MINIMUM_EV: f32 = -12.47393;
const AGX_MAXIMUM_EV: f32 = 4.026069;
const AGX_PIVOT: vec2<f32> = vec2<f32>(0.60608, 0.48834);
const AGX_SLOPE: f32 = 2.39013;
const AGX_ENCODING_POWER: f32 = 2.4;
const NEUTRAL_START_COMPRESSION: f32 = 0.76;
const NEUTRAL_DESATURATION: f32 = 0.15;

fn clamp_unit(color: vec3<f32>) -> vec3<f32> {
    return clamp(color, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn aces(color: vec3<f32>) -> vec3<f32> {
    let positive = max(color, vec3<f32>(0.0));
    return clamp_unit((positive * (2.51 * positive + 0.03)) / (positive * (2.43 * positive + 0.59) + 0.14));
}

fn agx_sigmoid_side(distance: f32, scale: f32, power: f32) -> f32 {
    let scaled = distance / scale;
    return scale * scaled / pow(1.0 + pow(scaled, power), 1.0 / power);
}

fn agx_curve(value: f32) -> f32 {
    let distance = AGX_SLOPE * (value - AGX_PIVOT.x);
    if distance >= 0.0 {
        return AGX_PIVOT.y + agx_sigmoid_side(distance, 0.70613, 1.53357);
    }
    return AGX_PIVOT.y - agx_sigmoid_side(-distance, 0.56474, 1.50159);
}

fn agx_channel(value: f32) -> f32 {
    let logged = (log2(max(value, 1e-10)) - AGX_MINIMUM_EV) / (AGX_MAXIMUM_EV - AGX_MINIMUM_EV);
    return pow(max(0.0, agx_curve(clamp(logged, 0.0, 1.0))), AGX_ENCODING_POWER);
}

fn agx(color: vec3<f32>) -> vec3<f32> {
    let inset = AGX_INSET * color;
    let linear = vec3<f32>(agx_channel(inset.x), agx_channel(inset.y), agx_channel(inset.z));
    return clamp_unit(AGX_OUTSET * linear);
}

fn neutral(color: vec3<f32>) -> vec3<f32> {
    let lowest = min(color.x, min(color.y, color.z));
    var offset = 0.04;
    if lowest < 0.08 {
        offset = lowest - 6.25 * lowest * lowest;
    }
    let shifted = color - vec3<f32>(offset);
    let peak = max(shifted.x, max(shifted.y, shifted.z));
    if peak < NEUTRAL_START_COMPRESSION {
        return clamp_unit(shifted);
    }
    let distance = 1.0 - NEUTRAL_START_COMPRESSION;
    let new_peak = 1.0 - distance * distance / (peak + distance - NEUTRAL_START_COMPRESSION);
    let mixing = 1.0 - 1.0 / (NEUTRAL_DESATURATION * (peak - new_peak) + 1.0);
    return clamp_unit(shifted * new_peak / peak * (1.0 - mixing) + vec3<f32>(new_peak * mixing));
}

fn view_transform(color: vec3<f32>) -> vec3<f32> {
    switch parameters.switches.x {
        case 1u: {
            return aces(color);
        }
        case 2u: {
            return agx(color);
        }
        case 3u: {
            return neutral(color);
        }
        default: {
            return clamp_unit(color);
        }
    }
}

fn pcg(value: u32) -> u32 {
    let state = value * 747796405u + 2891336453u;
    let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

/// Grain in -0.5 to 0.5 for one pixel and seed.
fn grain_noise(x: u32, y: u32) -> f32 {
    let hashed = pcg(x ^ pcg(y ^ pcg(parameters.switches.y)));
    return f32(hashed >> 8u) / 16777216.0 - 0.5;
}

fn film_color(x: u32, y: u32) -> vec3<f32> {
    return film[y * parameters.sizes.x + x].xyz * parameters.tone.x;
}

fn bloom_dimensions() -> vec2<u32> {
    return vec2<u32>(parameters.sizes.z, parameters.sizes.w);
}

@compute @workgroup_size(8, 8, 1)
fn bloom_down(@builtin(global_invocation_id) id: vec3<u32>) {
    let bloom_size = bloom_dimensions();
    if id.x >= bloom_size.x || id.y >= bloom_size.y {
        return;
    }
    var sum = vec3<f32>(0.0);
    var count = 0.0;
    for (var row = 0u; row < BLOOM_CELL; row = row + 1u) {
        let y = id.y * BLOOM_CELL + row;
        if y >= parameters.sizes.y {
            continue;
        }
        for (var column = 0u; column < BLOOM_CELL; column = column + 1u) {
            let x = id.x * BLOOM_CELL + column;
            if x >= parameters.sizes.x {
                continue;
            }
            sum += max(film_color(x, y) - vec3<f32>(parameters.tone.w), vec3<f32>(0.0));
            count += 1.0;
        }
    }
    bloom_a[id.y * bloom_size.x + id.x] = vec4<f32>(sum / max(count, 1.0), 0.0);
}

fn blur(id: vec3<u32>, horizontal: bool) -> vec3<f32> {
    let bloom_size = bloom_dimensions();
    let sigma = parameters.finish.z;
    let taps = i32(parameters.switches.z);
    var sum = vec3<f32>(0.0);
    var weight_sum = 0.0;
    for (var tap = -taps; tap <= taps; tap = tap + 1) {
        let weight = exp(-0.5 * f32(tap * tap) / (sigma * sigma));
        var x = i32(id.x);
        var y = i32(id.y);
        if horizontal {
            x = clamp(x + tap, 0, i32(bloom_size.x) - 1);
            sum += weight * bloom_a[u32(y) * bloom_size.x + u32(x)].xyz;
        } else {
            y = clamp(y + tap, 0, i32(bloom_size.y) - 1);
            sum += weight * bloom_b[u32(y) * bloom_size.x + u32(x)].xyz;
        }
        weight_sum += weight;
    }
    return sum / weight_sum;
}

@compute @workgroup_size(8, 8, 1)
fn bloom_blur_horizontal(@builtin(global_invocation_id) id: vec3<u32>) {
    let bloom_size = bloom_dimensions();
    if id.x >= bloom_size.x || id.y >= bloom_size.y {
        return;
    }
    bloom_b[id.y * bloom_size.x + id.x] = vec4<f32>(blur(id, true), 0.0);
}

@compute @workgroup_size(8, 8, 1)
fn bloom_blur_vertical(@builtin(global_invocation_id) id: vec3<u32>) {
    let bloom_size = bloom_dimensions();
    if id.x >= bloom_size.x || id.y >= bloom_size.y {
        return;
    }
    bloom_a[id.y * bloom_size.x + id.x] = vec4<f32>(blur(id, false), 0.0);
}

/// The blurred bloom at one full-resolution pixel, bilinear between the centres of the bloom pixels.
fn bloom_at(x: u32, y: u32) -> vec3<f32> {
    let bloom_size = bloom_dimensions();
    let position = (vec2<f32>(f32(x), f32(y)) + vec2<f32>(0.5)) / f32(BLOOM_CELL) - vec2<f32>(0.5);
    let base = floor(position);
    let fraction = position - base;
    let last = vec2<i32>(i32(bloom_size.x) - 1, i32(bloom_size.y) - 1);
    let low = clamp(vec2<i32>(base), vec2<i32>(0), last);
    let high = clamp(vec2<i32>(base) + vec2<i32>(1), vec2<i32>(0), last);
    let width = bloom_size.x;
    let top = mix(bloom_a[u32(low.y) * width + u32(low.x)].xyz, bloom_a[u32(low.y) * width + u32(high.x)].xyz, fraction.x);
    let bottom = mix(bloom_a[u32(high.y) * width + u32(low.x)].xyz, bloom_a[u32(high.y) * width + u32(high.x)].xyz, fraction.x);
    return mix(top, bottom, fraction.y);
}

fn to_byte(value: f32) -> u32 {
    return u32(round(clamp(value, 0.0, 1.0) * 255.0));
}

@compute @workgroup_size(8, 8, 1)
fn finish(@builtin(global_invocation_id) id: vec3<u32>) {
    let width = parameters.sizes.x;
    let height = parameters.sizes.y;
    if id.x >= width || id.y >= height {
        return;
    }
    var color = film_color(id.x, id.y);
    if parameters.switches.w == 1u {
        color += bloom_at(id.x, id.y) * parameters.tone.z;
    }
    color = pow(view_transform(color), vec3<f32>(1.0 / 2.2));
    let balance = parameters.tone.y;
    color = color * vec3<f32>(1.0 + balance * 0.1, 1.0, 1.0 - balance * 0.1);
    color = pow(max(color * parameters.gain.xyz + parameters.lift.xyz, vec3<f32>(0.0)), vec3<f32>(1.0) / parameters.gamma.xyz);
    let centered = (vec2<f32>(f32(id.x), f32(id.y)) + vec2<f32>(0.5)) / vec2<f32>(f32(width), f32(height)) * 2.0 - vec2<f32>(1.0);
    color = color * max(0.0, 1.0 - parameters.finish.x * dot(centered, centered));
    color = color + vec3<f32>(grain_noise(id.x, id.y) * parameters.finish.y);
    let alpha = film[id.y * width + id.x].w;
    let packed = to_byte(color.x) | (to_byte(color.y) << 8u) | (to_byte(color.z) << 16u) | (to_byte(alpha) << 24u);
    display[id.y * width + id.x] = packed;
}
