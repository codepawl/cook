// Dense grid volumes (FORMAT-v2.md, "Grid volumes"): heterogeneous media from a 3D grid of density, temperature and flame, shaded
// with the terms of Cycles' Principled Volume (absorption, scattering with a Henyey-Greenstein phase, emission per unit length
// and physical blackbody). Written from the equations, not from Cycles' source.
//
// Distance sampling is delta tracking against one constant majorant per scene (the sum of the grid majorants), so every point of
// a grid is a possible collision and the grid's own extinction decides what kind: absorption ends the path, scattering turns it,
// and a null collision only reweights it. A shadow ray gets ratio tracking against the same majorant.
//
// The grids live in the texture texel pool (binding 9), after the textures: a table of `grid_volume_count` descriptors of
// VG_DESCRIPTOR_WORDS words from `kernel_params.grid_table_offset`, then the blackbody colour table, and each grid's half float
// voxels at the word offset its descriptor names.

const VG_DESCRIPTOR_WORDS: u32 = 32u;
const VG_MAX_TRACK_STEPS: u32 = 4096u;
const VG_EVENT_NONE: u32 = 0u;
const VG_EVENT_SCATTER: u32 = 1u;
const VG_EVENT_ABSORB: u32 = 2u;
const VG_FLAG_HAS_TEMPERATURE: u32 = 1u;

// Blackbody colour table: 57 entries of three f32 words, luminance 1, every 200 K from 800 K. A body hotter than the table reads its last
// entry, a cooler one its first, as Cycles holds the colour constant below 800 K.
const VG_BLACKBODY_FIRST_KELVIN: f32 = 800.0;
const VG_BLACKBODY_STEP_KELVIN: f32 = 200.0;
const VG_BLACKBODY_COUNT: u32 = 57u;
// Stefan-Boltzmann constant times 1e-6 (W/m^2 to the scene's radiance unit, as Cycles does) over pi.
const VG_BLACKBODY_RADIANCE_SCALE: f32 = 5.670373e-8 * 1.0e-6 / 3.14159265358979;

struct VgPoint {
  sigma_a: vec3<f32>,
  sigma_s: vec3<f32>,
  emission: vec3<f32>,
  // Mean of the grids' phase anisotropy weighted by their scattering at the point.
  anisotropy: f32,
}

struct VgTrack {
  event: u32,
  t: f32,
  anisotropy: f32,
}

var<private> vg_path_key: vec4<u32> = vec4<u32>(0u);
var<private> vg_stream_counter: u32 = 0u;

// Starts the random stream of a path: the draws of tracking depend on the pixel, sample and seed, never on how the frame is split.
fn vg_begin_path(state: SmpState) {
  vg_path_key = vec4<u32>(state.pixel_x, state.pixel_y, state.sample_index, state.seed);
  vg_stream_counter = 0u;
}

fn vg_next_stream() -> u32 {
  let stream = vg_stream_counter;
  vg_stream_counter = stream + 1u;
  return stream;
}

fn vg_uniform(stream: u32, index: u32) -> f32 {
  let words = smp_pcg4d(vec4<u32>(
    vg_path_key.x ^ (vg_path_key.w * 0x9E3779B9u),
    vg_path_key.y ^ (vg_path_key.w * 0x85EBCA6Bu + 0x3C6EF372u),
    vg_path_key.z ^ (vg_path_key.w * 0xC2B2AE35u + 0x1B873593u),
    stream * 0x27D4EB2Fu + index,
  ));
  return smp_word_to_unit_float(words.x);
}

// The one place the grids read the texel pool. It is not a texture sampler: grid words are tables and half float voxels, never texels.
fn vg_word(index: u32) -> u32 {
  return texture_texels[index];
}

fn vg_float(index: u32) -> f32 {
  return bitcast<f32>(vg_word(index));
}

fn vg_descriptor_base(grid: u32) -> u32 {
  return kernel_params.grid_table_offset + grid * VG_DESCRIPTOR_WORDS;
}

fn vg_blackbody_table_base() -> u32 {
  return kernel_params.grid_table_offset + kernel_params.grid_volume_count * VG_DESCRIPTOR_WORDS;
}

fn vg_unit_position(base: u32, point: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    dot(vec3<f32>(vg_float(base + 4u), vg_float(base + 5u), vg_float(base + 6u)), point) + vg_float(base + 7u),
    dot(vec3<f32>(vg_float(base + 8u), vg_float(base + 9u), vg_float(base + 10u)), point) + vg_float(base + 11u),
    dot(vec3<f32>(vg_float(base + 12u), vg_float(base + 13u), vg_float(base + 14u)), point) + vg_float(base + 15u),
  );
}

fn vg_unit_direction(base: u32, direction: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    dot(vec3<f32>(vg_float(base + 4u), vg_float(base + 5u), vg_float(base + 6u)), direction),
    dot(vec3<f32>(vg_float(base + 8u), vg_float(base + 9u), vg_float(base + 10u)), direction),
    dot(vec3<f32>(vg_float(base + 12u), vg_float(base + 13u), vg_float(base + 14u)), direction),
  );
}

// The blackbody radiance of `kelvin` per unit length: sigma T^4 / pi times the colour of luminance 1, times `intensity`.
fn vg_blackbody_radiance(kelvin: f32, intensity: f32) -> vec3<f32> {
  if (kelvin <= 0.0 || intensity <= 0.0) {
    return vec3<f32>(0.0);
  }
  let position = clamp((kelvin - VG_BLACKBODY_FIRST_KELVIN) / VG_BLACKBODY_STEP_KELVIN, 0.0, f32(VG_BLACKBODY_COUNT - 1u));
  let lower = min(u32(position), VG_BLACKBODY_COUNT - 2u);
  let blend = position - f32(lower);
  let table = vg_blackbody_table_base();
  let low_base = table + lower * 3u;
  let low = vec3<f32>(vg_float(low_base), vg_float(low_base + 1u), vg_float(low_base + 2u));
  let high = vec3<f32>(vg_float(low_base + 3u), vg_float(low_base + 4u), vg_float(low_base + 5u));
  let squared = kelvin * kelvin;
  return mix(low, high, blend) * (VG_BLACKBODY_RADIANCE_SCALE * squared * squared * intensity);
}

// Adds the grid's contribution at a world point. Voxel centres sit at (i + 0.5) / n and every voxel beyond the grid reads 0, so the
// field ramps to 0 across the outer half voxel, as an OpenVDB grid does. The blackbody is taken per voxel and then interpolated, which
// is what Cycles' one stochastic linear tap averages to.
fn vg_add_grid(base: u32, world_point: vec3<f32>, with_emission: bool, point: ptr<function, VgPoint>) {
  let unit = vg_unit_position(base, world_point);
  if (any(unit < vec3<f32>(0.0)) || any(unit > vec3<f32>(1.0))) {
    return;
  }
  let resolution = vec3<u32>(vg_word(base), vg_word(base + 1u), vg_word(base + 2u));
  let data_offset = vg_word(base + 3u);
  let grid_position = unit * vec3<f32>(resolution) - vec3<f32>(0.5);
  let floor_position = floor(grid_position);
  let fraction = grid_position - floor_position;
  let first_voxel = vec3<i32>(floor_position);
  let has_temperature = (vg_word(base + 29u) & VG_FLAG_HAS_TEMPERATURE) != 0u;
  let temperature_scale = vg_float(base + 27u);
  let blackbody_intensity = vg_float(base + 28u);
  var density = 0.0;
  var flame = 0.0;
  var blackbody = vec3<f32>(0.0);
  for (var corner = 0u; corner < 8u; corner += 1u) {
    let offset = vec3<i32>(i32(corner & 1u), i32((corner >> 1u) & 1u), i32((corner >> 2u) & 1u));
    let voxel = first_voxel + offset;
    if (any(voxel < vec3<i32>(0)) || any(voxel >= vec3<i32>(resolution))) {
      continue;
    }
    let weight_x = select(1.0 - fraction.x, fraction.x, offset.x == 1);
    let weight_y = select(1.0 - fraction.y, fraction.y, offset.y == 1);
    let weight_z = select(1.0 - fraction.z, fraction.z, offset.z == 1);
    let weight = weight_x * weight_y * weight_z;
    let voxel_index = (u32(voxel.z) * resolution.y + u32(voxel.y)) * resolution.x + u32(voxel.x);
    let low_words = unpack2x16float(vg_word(data_offset + voxel_index * 2u));
    let high_words = unpack2x16float(vg_word(data_offset + voxel_index * 2u + 1u));
    density += weight * low_words.x;
    flame += weight * high_words.x;
    if (with_emission && has_temperature && blackbody_intensity > 0.0) {
      blackbody += weight * vg_blackbody_radiance(low_words.y * temperature_scale, blackbody_intensity);
    }
  }
  let sigma_a_coefficient = vec3<f32>(vg_float(base + 16u), vg_float(base + 17u), vg_float(base + 18u));
  let sigma_s_coefficient = vec3<f32>(vg_float(base + 20u), vg_float(base + 21u), vg_float(base + 22u));
  let emission_color = vec3<f32>(vg_float(base + 24u), vg_float(base + 25u), vg_float(base + 26u));
  let scatter = density * sigma_s_coefficient;
  (*point).sigma_a += density * sigma_a_coefficient;
  (*point).sigma_s += scatter;
  (*point).emission += emission_color * flame + blackbody;
  (*point).anisotropy += (scatter.x + scatter.y + scatter.z) * vg_float(base + 19u);
}

fn vg_sample_point(world_point: vec3<f32>, with_emission: bool) -> VgPoint {
  var point: VgPoint;
  point.sigma_a = vec3<f32>(0.0);
  point.sigma_s = vec3<f32>(0.0);
  point.emission = vec3<f32>(0.0);
  point.anisotropy = 0.0;
  for (var grid = 0u; grid < kernel_params.grid_volume_count; grid += 1u) {
    vg_add_grid(vg_descriptor_base(grid), world_point, with_emission, &point);
  }
  let scatter_total = point.sigma_s.x + point.sigma_s.y + point.sigma_s.z;
  point.anisotropy = select(0.0, point.anisotropy / scatter_total, scatter_total > 0.0);
  return point;
}

// The part of [t_min, t_max] where the ray is inside some grid's box (x: entry, y: exit), and the summed majorant of every grid (z).
fn vg_ray_span(origin: vec3<f32>, direction: vec3<f32>, t_min: f32, t_max: f32) -> vec3<f32> {
  var enter = 1.0e30;
  var leave = -1.0e30;
  var majorant = 0.0;
  for (var grid = 0u; grid < kernel_params.grid_volume_count; grid += 1u) {
    let base = vg_descriptor_base(grid);
    let unit_origin = vg_unit_position(base, origin);
    let unit_direction = vg_unit_direction(base, direction);
    let inverse = vec3<f32>(
      select(1.0 / unit_direction.x, 1.0e30, abs(unit_direction.x) < 1.0e-20),
      select(1.0 / unit_direction.y, 1.0e30, abs(unit_direction.y) < 1.0e-20),
      select(1.0 / unit_direction.z, 1.0e30, abs(unit_direction.z) < 1.0e-20),
    );
    let to_low = (vec3<f32>(0.0) - unit_origin) * inverse;
    let to_high = (vec3<f32>(1.0) - unit_origin) * inverse;
    let near = min(to_low, to_high);
    let far = max(to_low, to_high);
    let grid_enter = max(t_min, max(near.x, max(near.y, near.z)));
    let grid_leave = min(t_max, min(far.x, min(far.y, far.z)));
    if (grid_leave > grid_enter) {
      enter = min(enter, grid_enter);
      leave = max(leave, grid_leave);
      majorant += vg_float(base + 23u);
    }
  }
  return vec3<f32>(enter, leave, majorant);
}

fn vg_mean(value: vec3<f32>) -> f32 {
  return (value.x + value.y + value.z) * (1.0 / 3.0);
}

// Delta tracking from `t_min` to `t_max`. A null collision multiplies `throughput` by its weight, every collision adds the emission of
// its point (already weighted by the throughput) to `emitted`, and the first real collision ends the walk: an absorption (the path ends
// there) or a scatter (the walk's `t` is the new vertex, and `throughput` carries the scattering weight).
fn vg_track_segment(
  origin: vec3<f32>,
  direction: vec3<f32>,
  t_min: f32,
  t_max: f32,
  throughput: ptr<function, vec3<f32>>,
  emitted: ptr<function, vec3<f32>>,
) -> VgTrack {
  var result: VgTrack;
  result.event = VG_EVENT_NONE;
  result.t = t_max;
  result.anisotropy = 0.0;
  let span = vg_ray_span(origin, direction, t_min, t_max);
  let majorant = span.z;
  if (span.y <= span.x || majorant <= 0.0) {
    return result;
  }
  let stream = vg_next_stream();
  var t = span.x;
  for (var step_index = 0u; step_index < VG_MAX_TRACK_STEPS; step_index += 1u) {
    t += -log(max(1.0 - vg_uniform(stream, step_index * 2u), 1.0e-12)) / majorant;
    if (t >= span.y) {
      break;
    }
    let point = vg_sample_point(origin + direction * t, true);
    *emitted += *throughput * point.emission / majorant;
    let sigma_t = point.sigma_a + point.sigma_s;
    let absorb_probability = vg_mean(point.sigma_a) / majorant;
    let scatter_probability = vg_mean(point.sigma_s) / majorant;
    let choice = vg_uniform(stream, step_index * 2u + 1u);
    if (choice < absorb_probability) {
      result.event = VG_EVENT_ABSORB;
      result.t = t;
      return result;
    }
    if (choice < absorb_probability + scatter_probability) {
      *throughput *= point.sigma_s / vg_mean(point.sigma_s);
      result.event = VG_EVENT_SCATTER;
      result.t = t;
      result.anisotropy = point.anisotropy;
      return result;
    }
    let null_coefficient = max(vec3<f32>(majorant) - sigma_t, vec3<f32>(0.0));
    let null_mean = vg_mean(null_coefficient);
    if (null_mean > 1.0e-12) {
      *throughput *= null_coefficient / null_mean;
    }
  }
  return result;
}

// Ratio tracking: the transmittance of the grids along a shadow ray, an estimate with the expected value of exp(-optical depth).
fn vg_shadow_transmittance(origin: vec3<f32>, direction: vec3<f32>, t_max: f32) -> vec3<f32> {
  let span = vg_ray_span(origin, direction, 0.0, t_max);
  let majorant = span.z;
  if (span.y <= span.x || majorant <= 0.0) {
    return vec3<f32>(1.0);
  }
  let stream = vg_next_stream();
  var transmittance = vec3<f32>(1.0);
  var t = span.x;
  for (var step_index = 0u; step_index < VG_MAX_TRACK_STEPS; step_index += 1u) {
    t += -log(max(1.0 - vg_uniform(stream, step_index), 1.0e-12)) / majorant;
    if (t >= span.y) {
      break;
    }
    let point = vg_sample_point(origin + direction * t, false);
    transmittance *= max(vec3<f32>(1.0) - (point.sigma_a + point.sigma_s) / majorant, vec3<f32>(0.0));
    if (max(transmittance.x, max(transmittance.y, transmittance.z)) < 1.0e-4) {
      return vec3<f32>(0.0);
    }
  }
  return transmittance;
}
