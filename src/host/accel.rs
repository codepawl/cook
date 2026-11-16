use std::collections::BTreeMap;

use napi::Result;
use wgpu::util::DeviceExt;

use crate::host::device::failure;
use crate::host::textures::material_is_cutout;

pub(crate) const TRIANGLE_FLOATS: usize = 9 * 4;
pub(crate) const INSTANCE_RECORD_BYTES: usize = 160;
pub(crate) const TRIANGLE_RECORD_BYTES: usize = 224;
const VERTEX_STRIDE_BYTES: u64 = 12;
const IDENTITY_TRANSFORM_3X4: [f32; 12] = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0];
/// The fewest instances a TLAS holds on any adapter that supports ray queries.
const MINIMUM_TLAS_INSTANCES: usize = (1 << 24) - 1;
const INSTANCE_RAY_VISIBILITY_MASK: u32 = 0x3F;

pub(crate) struct UnpackedTriangles {
    pub(crate) vertices: Vec<f32>,
    pub(crate) slot_map: Vec<u32>,
    pub(crate) opaque_count: usize,
}

/// One mesh of the scene: a BLAS and what it was built from, so a geometry update can tell which meshes changed.
pub(crate) struct HeldMesh {
    /// The `InstanceRecord.blas_index` that names the mesh.
    blas_index: u32,
    opaque_triangle_count: u32,
    total_triangle_count: u32,
    /// The three corners of every triangle, as the BLAS was built from them (9 floats a triangle).
    vertices: Vec<f32>,
    blas: wgpu::Blas,
    _vertex_buffer: wgpu::Buffer,
}

pub(crate) struct CyclesAcceleration {
    pub(crate) tlas: wgpu::Tlas,
    pub(crate) meshes: Vec<HeldMesh>,
    /// For each instance, the index into `meshes` of the mesh it places; a transform update rebuilds the TLAS from it.
    pub(crate) instance_mesh_indices: Vec<usize>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct BlasSliceSpec {
    triangle_offset: u32,
    opaque_triangle_count: u32,
    total_triangle_count: u32,
}

struct BlasBuildPlan {
    blas: wgpu::Blas,
    geometry_sizes: Vec<wgpu::BlasTriangleGeometrySizeDescriptor>,
    geometry_vertex_starts: Vec<u32>,
}

/// The distinct meshes the instances of a scene place, in order of first use, and the mesh each instance places.
struct MeshPlan {
    meshes: Vec<(u32, BlasSliceSpec)>,
    instance_mesh_indices: Vec<usize>,
}

fn read_u32_le(bytes: &[u8], offset: usize) -> u32 {
    let word: [u8; 4] = bytes[offset..offset + 4].try_into().unwrap();
    u32::from_le_bytes(word)
}

fn read_f32_le(bytes: &[u8], offset: usize) -> f32 {
    let word: [u8; 4] = bytes[offset..offset + 4].try_into().unwrap();
    f32::from_le_bytes(word)
}

/// Unpacks corner-plus-two-edges triangle rows into three 3D corners per triangle, placing opaque triangles before
/// alpha-cutout triangles so each hardware BLAS geometry has a uniform opacity flag.
pub(crate) fn unpack_triangles(triangle_data: &[f32], materials: &[f32], triangle_count: usize) -> UnpackedTriangles {
    let mut opaque_vertices: Vec<f32> = Vec::with_capacity(triangle_count * 9);
    let mut cutout_vertices: Vec<f32> = Vec::new();
    let mut slot_map: Vec<u32> = Vec::with_capacity(triangle_count);
    let mut cutout_slots: Vec<u32> = Vec::new();
    for (slot, triangle) in triangle_data.chunks_exact(TRIANGLE_FLOATS).enumerate() {
        let corner = [triangle[0], triangle[1], triangle[2]];
        let edge_first = [triangle[4], triangle[5], triangle[6]];
        let edge_second = [triangle[8], triangle[9], triangle[10]];
        let is_cutout = material_is_cutout(materials, triangle[3] as usize);
        let vertices = if is_cutout { &mut cutout_vertices } else { &mut opaque_vertices };
        vertices.extend_from_slice(&corner);
        vertices.extend((0..3).map(|axis| corner[axis] + edge_first[axis]));
        vertices.extend((0..3).map(|axis| corner[axis] + edge_second[axis]));
        if is_cutout {
            cutout_slots.push(slot as u32);
        } else {
            slot_map.push(slot as u32);
        }
    }
    let opaque_count = slot_map.len();
    slot_map.extend(cutout_slots);
    let mut vertices = opaque_vertices;
    vertices.extend(cutout_vertices);
    UnpackedTriangles {
        vertices,
        slot_map,
        opaque_count,
    }
}

pub(crate) fn create_vertex_buffer(device: &wgpu::Device, vertices: &[f32]) -> wgpu::Buffer {
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("triangle corners"),
        contents: bytemuck::cast_slice(vertices),
        usage: wgpu::BufferUsages::BLAS_INPUT,
    })
}

/// Builds the scene BLAS (split into opaque and candidate cutout geometries) and single-instance TLAS.
pub(crate) fn build_acceleration_structure(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    vertex_buffer: &wgpu::Buffer,
    triangle_count: usize,
    opaque_count: usize,
) -> wgpu::Tlas {
    let mut geometry_sizes: Vec<wgpu::BlasTriangleGeometrySizeDescriptor> = Vec::new();
    let mut geometry_vertex_starts: Vec<u32> = Vec::new();
    let cutout_count = triangle_count - opaque_count;
    for (first_triangle, triangles_in_geometry, flags) in [
        (0, opaque_count, wgpu::AccelerationStructureGeometryFlags::OPAQUE),
        (opaque_count, cutout_count, wgpu::AccelerationStructureGeometryFlags::empty()),
    ] {
        if triangles_in_geometry == 0 {
            continue;
        }
        geometry_vertex_starts.push((first_triangle * 3) as u32);
        geometry_sizes.push(wgpu::BlasTriangleGeometrySizeDescriptor {
            vertex_format: wgpu::VertexFormat::Float32x3,
            vertex_count: (triangles_in_geometry * 3) as u32,
            index_format: None,
            index_count: None,
            flags,
        });
    }
    let blas = device.create_blas(
        &wgpu::CreateBlasDescriptor {
            label: Some("scene"),
            flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
            update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        },
        wgpu::BlasGeometrySizeDescriptors::Triangles {
            descriptors: geometry_sizes.clone(),
        },
    );
    let mut tlas = device.create_tlas(&wgpu::CreateTlasDescriptor {
        label: Some("scene"),
        flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
        update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        max_instances: 1,
    });
    tlas[0] = Some(wgpu::TlasInstance::new(
        &blas,
        IDENTITY_TRANSFORM_3X4,
        0,
        0xFF,
    ));
    let triangle_geometries: Vec<wgpu::BlasTriangleGeometry> = geometry_sizes
        .iter()
        .zip(&geometry_vertex_starts)
        .map(|(size, first_vertex)| wgpu::BlasTriangleGeometry {
            size,
            vertex_buffer,
            first_vertex: *first_vertex,
            vertex_stride: VERTEX_STRIDE_BYTES,
            index_buffer: None,
            first_index: None,
            transform_buffer: None,
            transform_buffer_offset: None,
        })
        .collect();
    let mut build_encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("build"),
    });
    build_encoder.build_acceleration_structures(
        std::iter::once(&wgpu::BlasBuildEntry {
            blas: &blas,
            geometry: wgpu::BlasGeometries::TriangleGeometries(triangle_geometries),
        }),
        std::iter::once(&tlas),
    );
    queue.submit(Some(build_encoder.finish()));
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    tlas
}

fn unpack_v2_triangle_vertices(triangle_bytes: &[u8], triangle_count: usize) -> Vec<f32> {
    if triangle_count == 0 {
        return vec![0.0; 9];
    }
    let mut vertices = Vec::with_capacity(triangle_count * 9);
    for index in 0..triangle_count {
        let base = index * TRIANGLE_RECORD_BYTES;
        let p0 = [
            read_f32_le(triangle_bytes, base),
            read_f32_le(triangle_bytes, base + 4),
            read_f32_le(triangle_bytes, base + 8),
        ];
        let edge1 = [
            read_f32_le(triangle_bytes, base + 16),
            read_f32_le(triangle_bytes, base + 20),
            read_f32_le(triangle_bytes, base + 24),
        ];
        let edge2 = [
            read_f32_le(triangle_bytes, base + 32),
            read_f32_le(triangle_bytes, base + 36),
            read_f32_le(triangle_bytes, base + 40),
        ];
        vertices.extend_from_slice(&p0);
        vertices.extend((0..3).map(|axis| p0[axis] + edge1[axis]));
        vertices.extend((0..3).map(|axis| p0[axis] + edge2[axis]));
    }
    vertices
}

fn create_blas_plan_for_slice(device: &wgpu::Device, spec: BlasSliceSpec) -> BlasBuildPlan {
    let opaque_count = spec.opaque_triangle_count as usize;
    let total_count = spec.total_triangle_count as usize;
    let cutout_count = total_count - opaque_count;
    let base_triangle = spec.triangle_offset as usize;
    let mut geometry_sizes = Vec::new();
    let mut geometry_vertex_starts = Vec::new();
    for (local_start, count_in_geometry, flags) in [
        (0usize, opaque_count, wgpu::AccelerationStructureGeometryFlags::OPAQUE),
        (opaque_count, cutout_count, wgpu::AccelerationStructureGeometryFlags::empty()),
    ] {
        if count_in_geometry == 0 {
            continue;
        }
        geometry_vertex_starts.push(((base_triangle + local_start) * 3) as u32);
        geometry_sizes.push(wgpu::BlasTriangleGeometrySizeDescriptor {
            vertex_format: wgpu::VertexFormat::Float32x3,
            vertex_count: (count_in_geometry * 3) as u32,
            index_format: None,
            index_count: None,
            flags,
        });
    }
    let blas = device.create_blas(
        &wgpu::CreateBlasDescriptor {
            label: Some("cycles mesh blas"),
            flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
            update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        },
        wgpu::BlasGeometrySizeDescriptors::Triangles {
            descriptors: geometry_sizes.clone(),
        },
    );
    BlasBuildPlan {
        blas,
        geometry_sizes,
        geometry_vertex_starts,
    }
}

/// The object-to-world rows of the instance record that starts at byte `base`, as a hardware TLAS transform.
fn read_instance_transform(instance_bytes: &[u8], base: usize) -> [f32; 12] {
    let mut transform_row_major_3x4 = [0.0f32; 12];
    for float_index in 0..12 {
        transform_row_major_3x4[float_index] = read_f32_le(instance_bytes, base + float_index * 4);
    }
    transform_row_major_3x4
}

/// The ray-kind bits of `visibility_flags` the hardware culls on (the negative-scale bit is not one of them).
pub(crate) fn instance_cull_mask(visibility_flags: u32) -> u8 {
    (visibility_flags & INSTANCE_RAY_VISIBILITY_MASK) as u8
}

/// Puts every instance of `instance_bytes` into the TLAS, over the mesh it places. The meshes must be built (or part of
/// the build that follows) before the TLAS is.
fn place_tlas_instances(acceleration: &mut CyclesAcceleration, instance_bytes: &[u8]) {
    for instance_index in 0..acceleration.instance_mesh_indices.len() {
        let base = instance_index * INSTANCE_RECORD_BYTES;
        let visibility_flags = read_u32_le(instance_bytes, base + 116);
        let mesh = &acceleration.meshes[acceleration.instance_mesh_indices[instance_index]];
        let placed = wgpu::TlasInstance::new(
            &mesh.blas,
            read_instance_transform(instance_bytes, base),
            instance_index as u32,
            instance_cull_mask(visibility_flags),
        );
        acceleration.tlas[instance_index] = Some(placed);
    }
}

fn check_instance_table_holds_session_instances(acceleration: &CyclesAcceleration, instance_bytes: &[u8]) -> Result<()> {
    let instance_count = acceleration.instance_mesh_indices.len();
    if instance_count == 0 || instance_bytes.len() != instance_count * INSTANCE_RECORD_BYTES {
        return Err(failure(format!(
            "The instance table must hold the session's {instance_count} instances of {INSTANCE_RECORD_BYTES} bytes to rebuild the TLAS; got {} bytes.",
            instance_bytes.len()
        )));
    }
    Ok(())
}

/// Rebuilds the TLAS of a session from a new instance table with the same instances in the same order: new transforms
/// and ray visibility, the same meshes. The BLAS are not touched. The pinned wgpu has no TLAS refit (`PreferUpdate` is
/// accepted and rebuilds), so a rebuild is the whole cost of moving an instance.
pub(crate) fn rebuild_cycles_tlas(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    acceleration: &mut CyclesAcceleration,
    instance_bytes: &[u8],
) -> Result<()> {
    check_instance_table_holds_session_instances(acceleration, instance_bytes)?;
    place_tlas_instances(acceleration, instance_bytes);
    let mut build_encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("cycles tlas rebuild"),
    });
    build_encoder.build_acceleration_structures(
        std::iter::empty::<&wgpu::BlasBuildEntry>(),
        std::iter::once(&acceleration.tlas),
    );
    queue.submit(Some(build_encoder.finish()));
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    Ok(())
}

/// What a geometry update decided: which meshes of the new input need a new BLAS.
pub(crate) struct GeometryUpdatePlan {
    mesh_plan: MeshPlan,
    /// For each mesh of `mesh_plan`, the index of the held mesh with the same `blas_index`.
    held_mesh_indices: Vec<usize>,
    /// For each mesh of `mesh_plan`, whether its triangles differ from the held mesh, so it needs a new BLAS.
    changed: Vec<bool>,
    vertices: Vec<f32>,
}

impl GeometryUpdatePlan {
    pub(crate) fn changed_mesh_count(&self) -> u32 {
        self.changed.iter().filter(|changed| **changed).count() as u32
    }
}

/// Compares a new triangle and instance table with the meshes a session holds, without touching the session. The same
/// meshes (by `blas_index`) must stay; a mesh may have any other number of triangles. Refuses with the way out otherwise.
pub(crate) fn plan_geometry_update(
    acceleration: &CyclesAcceleration,
    instance_bytes: &[u8],
    triangle_bytes: &[u8],
) -> Result<GeometryUpdatePlan> {
    check_instance_table_holds_session_instances(acceleration, instance_bytes)?;
    if triangle_bytes.is_empty() || triangle_bytes.len() % TRIANGLE_RECORD_BYTES != 0 {
        return Err(failure(format!(
            "The new triangle table holds {} bytes, which is not a whole number of {TRIANGLE_RECORD_BYTES} byte triangle records. Pack the scene again with buildNativeInputV2.",
            triangle_bytes.len()
        )));
    }
    let triangle_count = triangle_bytes.len() / TRIANGLE_RECORD_BYTES;
    let mesh_plan = plan_meshes(instance_bytes, acceleration.instance_mesh_indices.len(), triangle_count)?;
    if mesh_plan.meshes.len() != acceleration.meshes.len() {
        return Err(failure(format!(
            "The new input places {} meshes but the session holds {}. A geometry update keeps the set of meshes; create a new session to add or remove one.",
            mesh_plan.meshes.len(),
            acceleration.meshes.len()
        )));
    }
    let vertices = unpack_v2_triangle_vertices(triangle_bytes, triangle_count);
    let mut held_mesh_indices = Vec::with_capacity(mesh_plan.meshes.len());
    let mut changed = Vec::with_capacity(mesh_plan.meshes.len());
    for (blas_index, spec) in &mesh_plan.meshes {
        let Some(held_index) = acceleration.meshes.iter().position(|held| held.blas_index == *blas_index) else {
            return Err(failure(format!(
                "The new input places a mesh with blas_index {blas_index} that the session does not hold. A geometry update keeps the set of meshes; create a new session for this input."
            )));
        };
        let held = &acceleration.meshes[held_index];
        let new_vertices = &vertices[mesh_vertex_range(*spec)];
        let same_shape =
            held.opaque_triangle_count == spec.opaque_triangle_count && held.total_triangle_count == spec.total_triangle_count;
        held_mesh_indices.push(held_index);
        changed.push(!same_shape || held.vertices != new_vertices);
    }
    Ok(GeometryUpdatePlan { mesh_plan, held_mesh_indices, changed, vertices })
}

/// Applies a geometry update: builds a new BLAS for each changed mesh from a vertex buffer that holds only those meshes,
/// keeps the BLAS of the others, and rebuilds the TLAS over all of them with the new instance table, in one submission.
pub(crate) fn update_cycles_geometry(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    acceleration: &mut CyclesAcceleration,
    plan: GeometryUpdatePlan,
    instance_bytes: &[u8],
) -> Result<()> {
    let GeometryUpdatePlan { mesh_plan, held_mesh_indices, changed, vertices } = plan;

    let mut changed_vertices: Vec<f32> = Vec::new();
    let mut rebuilt_specs: Vec<(usize, BlasSliceSpec)> = Vec::new();
    for (mesh_index, (_, spec)) in mesh_plan.meshes.iter().enumerate() {
        if !changed[mesh_index] {
            continue;
        }
        let local_offset = (changed_vertices.len() / 9) as u32;
        changed_vertices.extend_from_slice(&vertices[mesh_vertex_range(*spec)]);
        rebuilt_specs.push((mesh_index, BlasSliceSpec { triangle_offset: local_offset, ..*spec }));
    }

    let mut previous_meshes: Vec<Option<HeldMesh>> = std::mem::take(&mut acceleration.meshes).into_iter().map(Some).collect();
    let rebuilt_buffer = (!rebuilt_specs.is_empty()).then(|| create_vertex_buffer(device, &changed_vertices));
    let rebuilt_plans: Vec<BlasBuildPlan> =
        rebuilt_specs.iter().map(|(_, spec)| create_blas_plan_for_slice(device, *spec)).collect();

    let mut next_meshes: Vec<HeldMesh> = Vec::with_capacity(mesh_plan.meshes.len());
    let mut rebuilt_position = 0;
    let mut plan_to_build: Vec<usize> = Vec::new();
    for (mesh_index, (blas_index, spec)) in mesh_plan.meshes.iter().enumerate() {
        if changed[mesh_index] {
            let rebuilt_plan = &rebuilt_plans[rebuilt_position];
            plan_to_build.push(rebuilt_position);
            rebuilt_position += 1;
            next_meshes.push(HeldMesh {
                blas_index: *blas_index,
                opaque_triangle_count: spec.opaque_triangle_count,
                total_triangle_count: spec.total_triangle_count,
                vertices: vertices[mesh_vertex_range(*spec)].to_vec(),
                blas: rebuilt_plan.blas.clone(),
                _vertex_buffer: rebuilt_buffer.clone().expect("a changed mesh has a vertex buffer"),
            });
        } else {
            let kept = previous_meshes[held_mesh_indices[mesh_index]].take().expect("each held mesh is kept once");
            next_meshes.push(kept);
        }
    }
    acceleration.meshes = next_meshes;
    acceleration.instance_mesh_indices = mesh_plan.instance_mesh_indices;
    place_tlas_instances(acceleration, instance_bytes);

    let build_entries: Vec<wgpu::BlasBuildEntry> = match &rebuilt_buffer {
        Some(buffer) => rebuilt_plans.iter().map(|plan| blas_build_entry(plan, buffer)).collect(),
        None => Vec::new(),
    };
    let mut build_encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("cycles geometry update build"),
    });
    build_encoder.build_acceleration_structures(build_entries.iter(), std::iter::once(&acceleration.tlas));
    queue.submit(Some(build_encoder.finish()));
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    drop(build_entries);
    Ok(())
}

fn blas_build_entry<'a>(plan: &'a BlasBuildPlan, vertex_buffer: &'a wgpu::Buffer) -> wgpu::BlasBuildEntry<'a> {
    let triangle_geometries: Vec<wgpu::BlasTriangleGeometry> = plan
        .geometry_sizes
        .iter()
        .zip(&plan.geometry_vertex_starts)
        .map(|(size, first_vertex)| wgpu::BlasTriangleGeometry {
            size,
            vertex_buffer,
            first_vertex: *first_vertex,
            vertex_stride: VERTEX_STRIDE_BYTES,
            index_buffer: None,
            first_index: None,
            transform_buffer: None,
            transform_buffer_offset: None,
        })
        .collect();
    wgpu::BlasBuildEntry {
        blas: &plan.blas,
        geometry: wgpu::BlasGeometries::TriangleGeometries(triangle_geometries),
    }
}

/// The floats of a mesh inside a table of three corners per triangle.
fn mesh_vertex_range(spec: BlasSliceSpec) -> std::ops::Range<usize> {
    let first = spec.triangle_offset as usize * 9;
    first..first + spec.total_triangle_count as usize * 9
}

/// Builds an empty masked-out 1-triangle BLAS + TLAS when a scene has zero instances or runs a lobe-only probe.
pub(crate) fn build_empty_cycles_acceleration(device: &wgpu::Device, queue: &wgpu::Queue) -> CyclesAcceleration {
    let vertex_buffer = create_vertex_buffer(device, &[0.0f32; 9]);
    let dummy_plan = create_blas_plan_for_slice(
        device,
        BlasSliceSpec {
            triangle_offset: 0,
            opaque_triangle_count: 1,
            total_triangle_count: 1,
        },
    );
    let mut tlas = device.create_tlas(&wgpu::CreateTlasDescriptor {
        label: Some("cycles empty tlas"),
        flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
        update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        max_instances: 1,
    });
    tlas[0] = Some(wgpu::TlasInstance::new(&dummy_plan.blas, IDENTITY_TRANSFORM_3X4, 0, 0x00));
    let mut build_encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("cycles empty accel build"),
    });
    build_encoder.build_acceleration_structures(
        std::iter::once(&blas_build_entry(&dummy_plan, &vertex_buffer)),
        std::iter::once(&tlas),
    );
    queue.submit(Some(build_encoder.finish()));
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    CyclesAcceleration {
        tlas,
        meshes: vec![HeldMesh {
            blas_index: 0,
            opaque_triangle_count: 1,
            total_triangle_count: 1,
            vertices: vec![0.0; 9],
            blas: dummy_plan.blas,
            _vertex_buffer: vertex_buffer,
        }],
        instance_mesh_indices: Vec::new(),
    }
}

/// The most instances one TLAS holds on this device: what the device reports, never below the supported minimum.
pub(crate) fn tlas_instance_limit(limits: &wgpu::Limits) -> usize {
    (limits.max_tlas_instance_count as usize).max(MINIMUM_TLAS_INSTANCES)
}

/// Reads every instance record: the distinct meshes in order of first use (by `blas_index`) and the mesh each instance
/// places. Refuses an empty mesh, a slice outside the triangle table and one `blas_index` with two different slices.
fn plan_meshes(instance_bytes: &[u8], instance_count: usize, triangle_count: usize) -> Result<MeshPlan> {
    let mut mesh_positions: BTreeMap<u32, (usize, BlasSliceSpec)> = BTreeMap::new();
    let mut meshes: Vec<(u32, BlasSliceSpec)> = Vec::new();
    let mut instance_mesh_indices: Vec<usize> = Vec::with_capacity(instance_count);
    for instance_index in 0..instance_count {
        let base = instance_index * INSTANCE_RECORD_BYTES;
        let blas_index = read_u32_le(instance_bytes, base + 96);
        let triangle_offset = read_u32_le(instance_bytes, base + 100);
        let opaque_triangle_count = read_u32_le(instance_bytes, base + 104);
        let total_triangle_count = read_u32_le(instance_bytes, base + 108);

        if total_triangle_count == 0 {
            return Err(failure(format!(
                "InstanceRecord[{instance_index}] has total_triangle_count == 0; pass at least 1 triangle per instance."
            )));
        }
        if opaque_triangle_count > total_triangle_count {
            return Err(failure(format!(
                "InstanceRecord[{instance_index}] has opaque_triangle_count ({opaque_triangle_count}) > total_triangle_count ({total_triangle_count})."
            )));
        }
        let end_triangle = (triangle_offset as u64) + (total_triangle_count as u64);
        if end_triangle > triangle_count as u64 {
            return Err(failure(format!(
                "InstanceRecord[{instance_index}] triangle range {triangle_offset}..{end_triangle} exceeds triangle_count ({triangle_count})."
            )));
        }

        let spec = BlasSliceSpec {
            triangle_offset,
            opaque_triangle_count,
            total_triangle_count,
        };
        let mesh_index = if let Some(&(existing_index, existing_spec)) = mesh_positions.get(&blas_index) {
            if existing_spec != spec {
                return Err(failure(format!(
                    "InstanceRecord[{instance_index}] reuses blas_index {blas_index} with mismatched triangle slice bounds."
                )));
            }
            existing_index
        } else {
            let next_index = meshes.len();
            meshes.push((blas_index, spec));
            mesh_positions.insert(blas_index, (next_index, spec));
            next_index
        };
        instance_mesh_indices.push(mesh_index);
    }
    Ok(MeshPlan { meshes, instance_mesh_indices })
}

/// Builds one hardware BLAS per unique `InstanceRecord.blas_index` and one hardware TLAS over all `instance_count` instances.
pub(crate) fn build_cycles_acceleration_structure(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    instance_bytes: &[u8],
    instance_count: usize,
    triangle_bytes: &[u8],
    triangle_count: usize,
    max_instances: usize,
) -> Result<CyclesAcceleration> {
    if instance_count > max_instances {
        return Err(failure(format!(
            "Instance count {instance_count} exceeds the limit of {max_instances} instances the device builds in one TLAS. Merge instances or render fewer."
        )));
    }
    if instance_count == 0 || triangle_count == 0 {
        return Ok(build_empty_cycles_acceleration(device, queue));
    }

    let mesh_plan = plan_meshes(instance_bytes, instance_count, triangle_count)?;
    let vertices = unpack_v2_triangle_vertices(triangle_bytes, triangle_count);
    let vertex_buffer = create_vertex_buffer(device, &vertices);
    let plans: Vec<BlasBuildPlan> = mesh_plan
        .meshes
        .iter()
        .map(|(_, spec)| create_blas_plan_for_slice(device, *spec))
        .collect();

    let mut tlas = device.create_tlas(&wgpu::CreateTlasDescriptor {
        label: Some("cycles scene tlas"),
        flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
        update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        max_instances: instance_count as u32,
    });
    for (instance_index, mesh_index) in mesh_plan.instance_mesh_indices.iter().enumerate() {
        let base = instance_index * INSTANCE_RECORD_BYTES;
        tlas[instance_index] = Some(wgpu::TlasInstance::new(
            &plans[*mesh_index].blas,
            read_instance_transform(instance_bytes, base),
            instance_index as u32,
            instance_cull_mask(read_u32_le(instance_bytes, base + 116)),
        ));
    }

    let blas_entries: Vec<wgpu::BlasBuildEntry> = plans.iter().map(|plan| blas_build_entry(plan, &vertex_buffer)).collect();
    let mut build_encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("cycles accel build"),
    });
    build_encoder.build_acceleration_structures(blas_entries.iter(), std::iter::once(&tlas));
    queue.submit(Some(build_encoder.finish()));
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    drop(blas_entries);

    let meshes = mesh_plan
        .meshes
        .iter()
        .zip(plans)
        .map(|((blas_index, spec), plan)| HeldMesh {
            blas_index: *blas_index,
            opaque_triangle_count: spec.opaque_triangle_count,
            total_triangle_count: spec.total_triangle_count,
            vertices: vertices[mesh_vertex_range(*spec)].to_vec(),
            blas: plan.blas,
            _vertex_buffer: vertex_buffer.clone(),
        })
        .collect();
    Ok(CyclesAcceleration {
        tlas,
        meshes,
        instance_mesh_indices: mesh_plan.instance_mesh_indices,
    })
}

#[cfg(test)]
mod tests {
    use super::{tlas_instance_limit, MINIMUM_TLAS_INSTANCES};

    #[test]
    fn the_tlas_limit_follows_the_device_with_a_floor() {
        let mut limits = wgpu::Limits::default();
        limits.max_tlas_instance_count = 0;
        assert_eq!(tlas_instance_limit(&limits), MINIMUM_TLAS_INSTANCES);
        limits.max_tlas_instance_count = (MINIMUM_TLAS_INSTANCES + 10) as u32;
        assert_eq!(tlas_instance_limit(&limits), MINIMUM_TLAS_INSTANCES + 10);
    }
}
