// Manifold next-event estimation (MNEE) for refractive caustics, written from the math of Hanika, Droske and Fascione,
// "Manifold Next Event Estimation" (2015) and Zeltner et al., "Specular Manifold Sampling" (2020). No code of another renderer.
//
// Problem. A diffuse receiver sees a small emitter only through smooth glass (a ball, a prism, a lens). A shadow ray is blocked by
// the glass and a BSDF path finds the emitter with a probability near zero, so the light converges as speckle.
//
// Method. The light sample the integrator already took gives a point y. The straight line from the receiver x0 to y crosses the
// caster twice: at a, entering, and at b, leaving. Those two points seed a chain x0 - a - b - y. Newton's method moves a and b over
// the glass surface until both obey Snell's law, which is the half-vector condition
//
//     tangential part of ( eta_in * wi + eta_out * wo ) = 0,   wi and wo pointing away from the vertex,
//
// at each vertex (2 numbers per vertex, 4 in all, for 4 unknowns: the two surface coordinates of a and b). The Jacobian is taken by
// finite differences of that residual, with every moved point projected back onto the mesh by a ray query, so a triangle mesh with
// smooth normals needs no analytic surface. The solution carries the light as
//
//     f(x0, w0) * L(y) * T_a * T_b / p(w0),    p(w0) = p_perp(y) * |dA_perp(y) / dw0|,
//
// where T is the Fresnel transmittance of the vertex and p_perp(y) = pdf / d^2 is the density the light sample has per area
// perpendicular to the ray at y (exact for a spherical emitter, a close approximation for a flat one). The map from the solid
// angle at x0 to that area is the change of variables of the manifold: dA_perp/dA_a = 1 / |det(da/dy)|, with da/dy from the implicit
// function theorem, and dA_a/dw0 = d_a^2 / cos(theta_a). Without glass the factor is exactly 1.
//
// Dispersion. The chain is traced for one wavelength through `eta_in` and `eta_out`. A material that disperses will pass the
// IOR of the hero wavelength of the path into `mnee_chain_etas`, and the path throughput carries the rest of the spectrum, so
// this file needs no other change.
//
// Limits (documented in FORMAT-v2.md): a chain of two interfaces, smooth solid glass, one solution per light sample, emitters that
// are not delta lights and not the environment. The integrator removes the BSDF-found light through a caster from a receiver
// (it would count twice), so a path the solver cannot solve loses that light, as in other renderers with this method.

const MNEE_MAX_ITERATIONS: u32 = 12u;
const MNEE_MAX_BACKTRACKS: u32 = 4u;
const MNEE_CONVERGED_RESIDUAL: f32 = 5.0e-5;
// Distance used for an emitter at infinity (the sun): far enough that its direction is constant, near enough for f32.
const MNEE_FAR_DISTANCE: f32 = 1.0e4;
const MNEE_DERIVATIVE_STEP: f32 = 1.0e-3;
const MNEE_MAX_STEP_FRACTION: f32 = 0.35;
const MNEE_SEGMENT_TOLERANCE: f32 = 2.0e-3;

struct MneeVertex {
  position: vec3<f32>,
  valid: u32,
  normal: vec3<f32>,
  instance_index: u32,
  triangle_index: u32,
  material_index: u32,
}

fn mnee_invalid_vertex() -> MneeVertex {
  var vertex: MneeVertex;
  vertex.position = vec3<f32>(0.0);
  vertex.valid = 0u;
  vertex.normal = vec3<f32>(0.0, 1.0, 0.0);
  vertex.instance_index = INVALID_INDEX;
  vertex.triangle_index = INVALID_INDEX;
  vertex.material_index = 0u;
  return vertex;
}

// Smooth solid glass: transmissive, not thin, not metallic, no roughness and no texture that could change either.
fn mnee_material_is_smooth_glass(material: MaterialRecord) -> bool {
  if ((material.flags & MATERIAL_FLAG_THIN_WALLED) != 0u) {
    return false;
  }
  if (material.transmission_weight <= 0.5 || material.transmission_tex >= 0 || material.metallic_roughness_tex >= 0) {
    return false;
  }
  if (material.metallic > 0.5 || material.ior <= 1.0001) {
    return false;
  }
  let alpha = material.roughness * material.roughness;
  return bsdf_mf_is_singular(alpha, alpha);
}

fn mnee_instance_is_receiver(instance_index: u32) -> bool {
  return (instances[instance_index].visibility_flags & INSTANCE_FLAG_RECEIVER) != 0u;
}

// True for a surface hit that a receiver's light must not be counted through by the BSDF: a caster made of smooth glass.
fn mnee_hit_is_smooth_caster(instance_index: u32, material_index: u32) -> bool {
  if ((instances[instance_index].visibility_flags & INSTANCE_FLAG_CASTER) == 0u) {
    return false;
  }
  return mnee_material_is_smooth_glass(materials[material_index]);
}

// The vertex of a hit on a smooth glass caster, with the normal pointing out of the glass (the winding side). Invalid for any other hit.
fn mnee_vertex_from_hit(surface_hit: IntSurfaceHit) -> MneeVertex {
  var vertex = mnee_invalid_vertex();
  if (surface_hit.hit == 0u) {
    return vertex;
  }
  let instance = instances[surface_hit.instance_index];
  if ((instance.visibility_flags & INSTANCE_FLAG_CASTER) == 0u) {
    return vertex;
  }
  let triangle = triangles[surface_hit.triangle_index];
  let material_index = int_resolve_material_index(instance, triangle);
  if (!mnee_material_is_smooth_glass(materials[material_index])) {
    return vertex;
  }
  let bary_u = surface_hit.barycentrics.x;
  let bary_v = surface_hit.barycentrics.y;
  let bary_w = 1.0 - bary_u - bary_v;
  let position_object = triangle.p0 + triangle.edge1 * bary_u + triangle.edge2 * bary_v;
  var raw_normal = cross(int_transform_vector(instance, triangle.edge1), int_transform_vector(instance, triangle.edge2));
  if ((instance.visibility_flags & INSTANCE_FLAG_NEGATIVE_SCALE) != 0u) {
    raw_normal = -raw_normal;
  }
  let raw_length = length(raw_normal);
  if (raw_length <= 1.0e-16) {
    return vertex;
  }
  let outward_geometric = raw_normal / raw_length;
  var normal = outward_geometric;
  if ((triangle.flags & TRIANGLE_FLAG_SMOOTH_NORMALS) != 0u) {
    let interpolated = bary_w * triangle.n0 + bary_u * triangle.n1 + bary_v * triangle.n2;
    let outward_smooth = int_transform_normal(instance, interpolated, outward_geometric);
    if (dot(outward_smooth, outward_geometric) > 0.0) {
      normal = outward_smooth;
    }
  }
  vertex.position = int_transform_point(instance, position_object);
  vertex.valid = 1u;
  vertex.normal = normal;
  vertex.instance_index = surface_hit.instance_index;
  vertex.triangle_index = surface_hit.triangle_index;
  vertex.material_index = material_index;
  return vertex;
}

// Puts a point that left the surface back on the mesh: a ray from just outside along the inward normal, and when that finds no
// caster, one from just inside along the outward normal.
fn mnee_project(target_point: vec3<f32>, outward: vec3<f32>, lift: f32) -> MneeVertex {
  let reach = 3.0 * lift;
  var surface_hit = int_trace_closest_surface(
    target_point + outward * lift,
    -outward,
    0.0,
    reach,
    INSTANCE_VISIBILITY_SHADOW,
    INVALID_INDEX,
    INVALID_INDEX,
  );
  var vertex = mnee_vertex_from_hit(surface_hit);
  if (vertex.valid == 0u) {
    surface_hit = int_trace_closest_surface(
      target_point - outward * lift,
      outward,
      0.0,
      reach,
      INSTANCE_VISIBILITY_SHADOW,
      INVALID_INDEX,
      INVALID_INDEX,
    );
    vertex = mnee_vertex_from_hit(surface_hit);
  }
  return vertex;
}

// The two tangent coordinates of one vertex's tangent plane.
fn mnee_tangent_frame(normal: vec3<f32>) -> array<vec3<f32>, 2> {
  var tangent = vec3<f32>(0.0);
  var bitangent = vec3<f32>(0.0);
  lgt_make_orthonormal_basis(normal, &tangent, &bitangent);
  return array<vec3<f32>, 2>(tangent, bitangent);
}

// The half-vector condition of one refracting vertex, as the two components of the tangential part of the generalized half
// vector on a fixed tangent frame. Zero when the vertex obeys Snell's law.
fn mnee_vertex_constraint(
  position: vec3<f32>,
  normal: vec3<f32>,
  previous_point: vec3<f32>,
  next_point: vec3<f32>,
  eta_in: f32,
  eta_out: f32,
  tangent: vec3<f32>,
  bitangent: vec3<f32>,
) -> vec2<f32> {
  let toward_previous = normalize(previous_point - position);
  let toward_next = normalize(next_point - position);
  var half_vector = eta_in * toward_previous + eta_out * toward_next;
  half_vector = half_vector / max(length(half_vector), 1.0e-12);
  half_vector = half_vector - normal * dot(half_vector, normal);
  return vec2<f32>(dot(half_vector, tangent), dot(half_vector, bitangent));
}

struct MneeChain {
  receiver: vec3<f32>,
  target_point: vec3<f32>,
  // eta_in and eta_out of the first vertex, then of the second.
  etas: vec4<f32>,
  frame_a: array<vec3<f32>, 2>,
  frame_b: array<vec3<f32>, 2>,
}

fn mnee_residual(chain: MneeChain, vertex_a: MneeVertex, vertex_b: MneeVertex) -> vec4<f32> {
  let constraint_a = mnee_vertex_constraint(
    vertex_a.position, vertex_a.normal, chain.receiver, vertex_b.position,
    chain.etas.x, chain.etas.y, chain.frame_a[0], chain.frame_a[1],
  );
  let constraint_b = mnee_vertex_constraint(
    vertex_b.position, vertex_b.normal, vertex_a.position, chain.target_point,
    chain.etas.z, chain.etas.w, chain.frame_b[0], chain.frame_b[1],
  );
  return vec4<f32>(constraint_a, constraint_b);
}

// Solves a (4x4, row-major) x = rhs (4 rows, `columns` right-hand sides of 2) by Gauss-Jordan elimination with partial pivoting.
// The solution replaces rhs. False when the matrix is singular.
fn mnee_solve(matrix: ptr<function, array<f32, 16>>, rhs: ptr<function, array<f32, 8>>, columns: u32) -> bool {
  for (var pivot = 0u; pivot < 4u; pivot += 1u) {
    var best_row = pivot;
    var best_value = abs((*matrix)[pivot * 4u + pivot]);
    for (var row = pivot + 1u; row < 4u; row += 1u) {
      let candidate = abs((*matrix)[row * 4u + pivot]);
      if (candidate > best_value) {
        best_value = candidate;
        best_row = row;
      }
    }
    if (!(best_value > 1.0e-12)) {
      return false;
    }
    if (best_row != pivot) {
      for (var column = 0u; column < 4u; column += 1u) {
        let held = (*matrix)[pivot * 4u + column];
        (*matrix)[pivot * 4u + column] = (*matrix)[best_row * 4u + column];
        (*matrix)[best_row * 4u + column] = held;
      }
      for (var column = 0u; column < columns; column += 1u) {
        let held = (*rhs)[pivot * 2u + column];
        (*rhs)[pivot * 2u + column] = (*rhs)[best_row * 2u + column];
        (*rhs)[best_row * 2u + column] = held;
      }
    }
    let inverse_pivot = 1.0 / (*matrix)[pivot * 4u + pivot];
    for (var row = 0u; row < 4u; row += 1u) {
      if (row == pivot) {
        continue;
      }
      let factor = (*matrix)[row * 4u + pivot] * inverse_pivot;
      for (var column = 0u; column < 4u; column += 1u) {
        (*matrix)[row * 4u + column] -= factor * (*matrix)[pivot * 4u + column];
      }
      for (var column = 0u; column < columns; column += 1u) {
        (*rhs)[row * 2u + column] -= factor * (*rhs)[pivot * 2u + column];
      }
    }
  }
  for (var row = 0u; row < 4u; row += 1u) {
    let inverse_diagonal = 1.0 / (*matrix)[row * 4u + row];
    for (var column = 0u; column < columns; column += 1u) {
      (*rhs)[row * 2u + column] *= inverse_diagonal;
    }
  }
  return true;
}

// Finite-difference Jacobian of the residual with respect to the four surface coordinates (row-major, row = residual component).
// False when a moved point leaves the caster.
fn mnee_jacobian(
  chain: MneeChain,
  vertex_a: MneeVertex,
  vertex_b: MneeVertex,
  residual: vec4<f32>,
  step: f32,
  jacobian: ptr<function, array<f32, 16>>,
) -> bool {
  for (var unknown = 0u; unknown < 4u; unknown += 1u) {
    var moved_a = vertex_a;
    var moved_b = vertex_b;
    let axis = unknown % 2u;
    if (unknown < 2u) {
      moved_a = mnee_project(vertex_a.position + chain.frame_a[axis] * step, vertex_a.normal, 4.0 * step);
    } else {
      moved_b = mnee_project(vertex_b.position + chain.frame_b[axis] * step, vertex_b.normal, 4.0 * step);
    }
    if (moved_a.valid == 0u || moved_b.valid == 0u) {
      return false;
    }
    let shifted = mnee_residual(chain, moved_a, moved_b);
    let derivative = (shifted - residual) / step;
    for (var row = 0u; row < 4u; row += 1u) {
      (*jacobian)[row * 4u + unknown] = derivative[row];
    }
  }
  return true;
}

fn mnee_fresnel_transmittance(cos_in: f32, cos_out: f32, eta_in: f32, eta_out: f32) -> f32 {
  let perpendicular = (eta_in * cos_in - eta_out * cos_out) / (eta_in * cos_in + eta_out * cos_out);
  let parallel = (eta_out * cos_in - eta_in * cos_out) / (eta_out * cos_in + eta_in * cos_out);
  return clamp(1.0 - 0.5 * (perpendicular * perpendicular + parallel * parallel), 0.0, 1.0);
}

// Transmittance of one refracting vertex: Fresnel, the glass tint (the glass lobe tints once per interface with the square root
// of the base colour) and the transmission weight.
fn mnee_vertex_transmittance(material: MaterialRecord, cos_in: f32, cos_out: f32, eta_in: f32, eta_out: f32) -> vec3<f32> {
  let tint = sqrt(clamp(material.base_color, vec3<f32>(0.0), vec3<f32>(1.0)));
  let weight = clamp(material.transmission_weight, 0.0, 1.0) * (1.0 - clamp(material.metallic, 0.0, 1.0));
  return tint * (weight * mnee_fresnel_transmittance(cos_in, cos_out, eta_in, eta_out));
}

// True when a ray from `start` along the line to `end` reaches a surface of `end_instance` at the distance of `end`, with
// nothing in front of it.
fn mnee_segment_reaches(start: vec3<f32>, end: vec3<f32>, start_instance: u32, start_triangle: u32, end_instance: u32) -> bool {
  let offset = end - start;
  let distance_to_end = length(offset);
  if (distance_to_end <= 1.0e-6) {
    return false;
  }
  let direction = offset / distance_to_end;
  let surface_hit = int_trace_closest_surface(
    start,
    direction,
    0.0,
    distance_to_end * 1.01 + 1.0e-4,
    INSTANCE_VISIBILITY_SHADOW,
    start_instance,
    start_triangle,
  );
  if (surface_hit.hit == 0u || surface_hit.instance_index != end_instance) {
    return false;
  }
  return abs(surface_hit.t - distance_to_end) <= MNEE_SEGMENT_TOLERANCE * distance_to_end + 1.0e-4;
}

// The light a direct sample brings to the vertex through the glass that blocks the straight shadow ray, with the BSDF, the
// throughput and the Fresnel and absorption losses applied and no MIS weight (the integrator drops the BSDF-found light through
// a caster, so there is no second estimator). Zero when no valid chain is found.
fn mnee_direct_contribution(
  sample: LgtDirectSample,
  closure: ptr<function, Closure>,
  point: ptr<function, ShadingPoint>,
  wo: vec3<f32>,
  throughput: vec3<f32>,
  transparent_bounces: u32,
) -> vec3<f32> {
  let none = vec3<f32>(0.0);
  let receiver = (*point).position;
  let is_far = sample.distance >= 1.0e29;
  let light_distance = select(sample.distance, MNEE_FAR_DISTANCE, is_far);
  let target_point = receiver + sample.wi * light_distance;

  // The seed: the two places where the straight line crosses the caster, entering and then leaving.
  let straight_origin = int_ray_offset_origin(point, sample.wi);
  let first_hit = int_trace_closest_surface(
    straight_origin, sample.wi, 0.0, light_distance, INSTANCE_VISIBILITY_SHADOW,
    (*point).instance_index, (*point).triangle_index,
  );
  var vertex_a = mnee_vertex_from_hit(first_hit);
  if (vertex_a.valid == 0u || dot(sample.wi, vertex_a.normal) >= 0.0) {
    return none;
  }
  let second_hit = int_trace_closest_surface(
    vertex_a.position, sample.wi, 0.0, light_distance, INSTANCE_VISIBILITY_SHADOW,
    vertex_a.instance_index, vertex_a.triangle_index,
  );
  var vertex_b = mnee_vertex_from_hit(second_hit);
  if (vertex_b.valid == 0u || dot(sample.wi, vertex_b.normal) <= 0.0) {
    return none;
  }

  var chain: MneeChain;
  chain.receiver = receiver;
  chain.target_point = target_point;
  chain.etas = vec4<f32>(1.0, materials[vertex_a.material_index].ior, materials[vertex_b.material_index].ior, 1.0);

  let seed_span = max(length(vertex_b.position - vertex_a.position), 0.02);
  let derivative_step = MNEE_DERIVATIVE_STEP * seed_span;
  let max_move = MNEE_MAX_STEP_FRACTION * seed_span;

  chain.frame_a = mnee_tangent_frame(vertex_a.normal);
  chain.frame_b = mnee_tangent_frame(vertex_b.normal);
  var residual = mnee_residual(chain, vertex_a, vertex_b);
  var residual_size = length(residual);
  var converged = residual_size <= MNEE_CONVERGED_RESIDUAL;

  for (var iteration = 0u; iteration < MNEE_MAX_ITERATIONS && !converged; iteration += 1u) {
    chain.frame_a = mnee_tangent_frame(vertex_a.normal);
    chain.frame_b = mnee_tangent_frame(vertex_b.normal);
    residual = mnee_residual(chain, vertex_a, vertex_b);
    residual_size = length(residual);
    var jacobian: array<f32, 16>;
    if (!mnee_jacobian(chain, vertex_a, vertex_b, residual, derivative_step, &jacobian)) {
      return none;
    }
    var newton_step: array<f32, 8>;
    for (var row = 0u; row < 4u; row += 1u) {
      newton_step[row * 2u] = -residual[row];
      newton_step[row * 2u + 1u] = 0.0;
    }
    if (!mnee_solve(&jacobian, &newton_step, 1u)) {
      return none;
    }
    var move_a = chain.frame_a[0] * newton_step[0] + chain.frame_a[1] * newton_step[2];
    var move_b = chain.frame_b[0] * newton_step[4] + chain.frame_b[1] * newton_step[6];
    let length_a = length(move_a);
    let length_b = length(move_b);
    if (length_a > max_move) {
      move_a *= max_move / length_a;
    }
    if (length_b > max_move) {
      move_b *= max_move / length_b;
    }

    var accepted = false;
    var damping = 1.0;
    for (var backtrack = 0u; backtrack <= MNEE_MAX_BACKTRACKS; backtrack += 1u) {
      let lift_a = 0.5 * damping * length(move_a) + 4.0 * derivative_step;
      let lift_b = 0.5 * damping * length(move_b) + 4.0 * derivative_step;
      let trial_a = mnee_project(vertex_a.position + move_a * damping, vertex_a.normal, lift_a);
      let trial_b = mnee_project(vertex_b.position + move_b * damping, vertex_b.normal, lift_b);
      if (trial_a.valid != 0u && trial_b.valid != 0u) {
        let trial_residual = mnee_residual(chain, trial_a, trial_b);
        let trial_size = length(trial_residual);
        if (trial_size < residual_size) {
          vertex_a = trial_a;
          vertex_b = trial_b;
          residual_size = trial_size;
          accepted = true;
          break;
        }
      }
      damping *= 0.5;
    }
    if (!accepted) {
      return none;
    }
    converged = residual_size <= MNEE_CONVERGED_RESIDUAL;
  }
  if (!converged) {
    return none;
  }

  // The solution must still enter at a and leave at b, with a ray refracting at each (opposite sides of the surface).
  let toward_receiver = normalize(receiver - vertex_a.position);
  let a_to_b = normalize(vertex_b.position - vertex_a.position);
  let toward_target = normalize(target_point - vertex_b.position);
  let cos_in_a = dot(toward_receiver, vertex_a.normal);
  let cos_out_a = -dot(a_to_b, vertex_a.normal);
  let cos_in_b = dot(a_to_b, vertex_b.normal);
  let cos_out_b = dot(toward_target, vertex_b.normal);
  if (cos_in_a <= 1.0e-4 || cos_out_a <= 1.0e-4 || cos_in_b <= 1.0e-4 || cos_out_b <= 1.0e-4) {
    return none;
  }

  // Jacobian at the solution and the derivative of the surface coordinates of a with the position of the light.
  chain.frame_a = mnee_tangent_frame(vertex_a.normal);
  chain.frame_b = mnee_tangent_frame(vertex_b.normal);
  residual = mnee_residual(chain, vertex_a, vertex_b);
  var final_jacobian: array<f32, 16>;
  if (!mnee_jacobian(chain, vertex_a, vertex_b, residual, derivative_step, &final_jacobian)) {
    return none;
  }
  var light_axis_x = vec3<f32>(0.0);
  var light_axis_y = vec3<f32>(0.0);
  lgt_make_orthonormal_basis(toward_target, &light_axis_x, &light_axis_y);
  let light_step = MNEE_DERIVATIVE_STEP * length(target_point - vertex_b.position);
  let base_constraint_b = vec2<f32>(residual.z, residual.w);
  var light_derivative: array<f32, 8>;
  for (var row = 0u; row < 8u; row += 1u) {
    light_derivative[row] = 0.0;
  }
  for (var axis = 0u; axis < 2u; axis += 1u) {
    let shifted_target = target_point + select(light_axis_x, light_axis_y, axis == 1u) * light_step;
    let shifted_constraint = mnee_vertex_constraint(
      vertex_b.position, vertex_b.normal, vertex_a.position, shifted_target,
      chain.etas.z, chain.etas.w, chain.frame_b[0], chain.frame_b[1],
    );
    let derivative = (shifted_constraint - base_constraint_b) / light_step;
    light_derivative[4u + axis] = derivative.x;
    light_derivative[6u + axis] = derivative.y;
  }
  // The solve returns -da/dy times the right-hand side's sign: only the determinant of its first two rows is used.
  if (!mnee_solve(&final_jacobian, &light_derivative, 2u)) {
    return none;
  }
  let surface_per_light_area = abs(light_derivative[0] * light_derivative[3] - light_derivative[1] * light_derivative[2]);
  if (!(surface_per_light_area > 0.0)) {
    return none;
  }

  // The path must be free: receiver to a, inside the glass from a to b, and from b to the light.
  let direction_to_a = normalize(vertex_a.position - receiver);
  let distance_to_a = length(vertex_a.position - receiver);
  let origin_to_a = int_ray_offset_origin(point, direction_to_a);
  if (!mnee_segment_reaches(origin_to_a, vertex_a.position, (*point).instance_index, (*point).triangle_index, vertex_a.instance_index)) {
    return none;
  }
  if (!mnee_segment_reaches(vertex_a.position, vertex_b.position, vertex_a.instance_index, vertex_a.triangle_index, vertex_b.instance_index)) {
    return none;
  }
  let light_leg = target_point - vertex_b.position;
  let light_leg_length = select(length(light_leg), sample.distance, is_far);
  let leg_visibility = int_trace_shadow(
    vertex_b.position, toward_target, light_leg_length,
    vertex_b.instance_index, vertex_b.triangle_index,
    sample.target_instance, sample.target_triangle, transparent_bounces,
  );
  if (!any(leg_visibility > vec3<f32>(0.0))) {
    return none;
  }

  let bsdf = closure_eval(closure, direction_to_a, wo);
  if (bsdf.value.x <= 0.0 && bsdf.value.y <= 0.0 && bsdf.value.z <= 0.0) {
    return none;
  }
  let material_a = materials[vertex_a.material_index];
  let material_b = materials[vertex_b.material_index];
  var transmittance = mnee_vertex_transmittance(material_a, cos_in_a, cos_out_a, chain.etas.x, chain.etas.y)
    * mnee_vertex_transmittance(material_b, cos_in_b, cos_out_b, chain.etas.z, chain.etas.w);
  if (material_a.absorption_distance > 0.0) {
    let absorption_color = clamp(material_a.absorption_color, vec3<f32>(1.0e-6), vec3<f32>(1.0));
    let sigma = max(-log(absorption_color) / material_a.absorption_distance, vec3<f32>(0.0));
    transmittance *= exp(-sigma * length(vertex_b.position - vertex_a.position));
  }
  let cos_receiver_side = abs(dot(direction_to_a, vertex_a.normal));
  let measure_factor = light_distance * light_distance * cos_receiver_side * surface_per_light_area
    / max(distance_to_a * distance_to_a, 1.0e-12);
  return throughput * bsdf.value * sample.radiance * transmittance * leg_visibility * (measure_factor / sample.pdf);
}
