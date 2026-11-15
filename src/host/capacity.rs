//! What the adapter can hold, so a host can bound a scene before it exports one: the device memory, the largest table the
//! device accepts and what each unique triangle, instance and texture texel costs in the packed tables.

use napi::Result;
use napi_derive::napi;

use super::accel::{INSTANCE_RECORD_BYTES, TRIANGLE_RECORD_BYTES};
use super::device::{largest_storage_buffer_bytes, request_adapter, required_device_limits};

/// One triangle of the scene: three vertices of three f32, read by the acceleration structure build.
pub(crate) const VERTEX_BYTES_PER_TRIANGLE: u64 = 3 * 12;
/// A texture texel is one packed u32 (RGBA8) in the texture pool.
pub(crate) const TEXEL_BYTES: u64 = 4;
/// `VK_MEMORY_HEAP_DEVICE_LOCAL_BIT` of `VkMemoryHeapFlags`.
const VULKAN_HEAP_DEVICE_LOCAL_BIT: u32 = 1;

#[napi(object)]
pub struct AdapterCapacity {
    /// Name of the adapter Cook renders on.
    pub adapter: String,
    /// `DiscreteGpu`, `IntegratedGpu`, `VirtualGpu`, `Cpu` or `Other`.
    pub device_type: String,
    /// Bytes of device-local memory (the sum of the Vulkan device-local heaps), or undefined when the driver reports none.
    /// On an integrated GPU the heap can be shared system memory.
    pub device_local_memory_bytes: Option<f64>,
    /// Where `deviceLocalMemoryBytes` came from, or why it is missing. Cook never estimates it.
    pub device_local_memory_source: String,
    /// The storage binding limit Cook asks the device for (the adapter's, at most 1 GiB).
    pub max_storage_buffer_binding_bytes: f64,
    /// The buffer size limit Cook asks the device for (the adapter's, at most 1 GiB).
    pub max_buffer_bytes: f64,
    /// The largest single table of the packed scene: the smaller of the two limits above.
    pub largest_table_bytes: f64,
    /// Bytes of one unique triangle in the triangle table.
    pub triangle_table_bytes: f64,
    /// Bytes of one unique triangle in the vertex buffer the acceleration structure is built from.
    pub triangle_vertex_bytes: f64,
    /// Bytes of one instance in the instance table.
    pub instance_table_bytes: f64,
    /// Bytes of one texel in the texture pool.
    pub texel_bytes: f64,
    /// Unique triangles whose tables fit the buffer limits of this device.
    pub max_unique_triangles: f64,
    /// Instances whose table fits one buffer of this device.
    pub max_instances: f64,
    /// Texels one texture pool holds.
    pub max_texture_texels: f64,
    /// The costs above count the packed tables only. The acceleration structure is sized by the driver and is not included.
    pub includes_acceleration_structure: bool,
}

/// The sum of the device-local heaps, or None when there are none. Each pair is a heap's flags and its size in bytes.
pub(crate) fn device_local_bytes(heaps: &[(u32, u64)]) -> Option<u64> {
    let total: u64 = heaps
        .iter()
        .filter(|(flags, _)| flags & VULKAN_HEAP_DEVICE_LOCAL_BIT != 0)
        .map(|(_, size)| *size)
        .sum();
    (total > 0).then_some(total)
}

fn vulkan_heaps(adapter: &wgpu::Adapter) -> Option<Vec<(u32, u64)>> {
    // SAFETY: the guard only reads the memory properties of the physical device and is dropped before this returns.
    let hal_adapter = unsafe { adapter.as_hal::<wgpu::hal::api::Vulkan>() }?;
    let instance = hal_adapter.shared_instance().raw_instance();
    let properties = unsafe { instance.get_physical_device_memory_properties(hal_adapter.raw_physical_device()) };
    let heap_count = properties.memory_heap_count as usize;
    Some(properties.memory_heaps[..heap_count].iter().map(|heap| (heap.flags.as_raw(), heap.size)).collect())
}

pub(crate) fn max_unique_triangles(limits: &wgpu::Limits) -> u64 {
    (largest_storage_buffer_bytes(limits) / TRIANGLE_RECORD_BYTES as u64).min(limits.max_buffer_size / VERTEX_BYTES_PER_TRIANGLE)
}

#[napi]
pub fn adapter_capacity() -> Result<AdapterCapacity> {
    let adapter = request_adapter()?;
    let info = adapter.get_info();
    let limits = required_device_limits(&adapter.limits());
    let heaps = vulkan_heaps(&adapter);
    let (memory_bytes, memory_source) = match heaps.as_deref().map(device_local_bytes) {
        None => (None, "unavailable: the adapter did not expose its Vulkan handle"),
        Some(None) => (None, "unavailable: the driver reports no device-local memory heap"),
        Some(Some(bytes)) => (Some(bytes as f64), "Vulkan memory heaps flagged device local"),
    };
    let largest_table_bytes = largest_storage_buffer_bytes(&limits);
    Ok(AdapterCapacity {
        adapter: info.name,
        device_type: format!("{:?}", info.device_type),
        device_local_memory_bytes: memory_bytes,
        device_local_memory_source: memory_source.to_string(),
        max_storage_buffer_binding_bytes: limits.max_storage_buffer_binding_size as f64,
        max_buffer_bytes: limits.max_buffer_size as f64,
        largest_table_bytes: largest_table_bytes as f64,
        triangle_table_bytes: TRIANGLE_RECORD_BYTES as f64,
        triangle_vertex_bytes: VERTEX_BYTES_PER_TRIANGLE as f64,
        instance_table_bytes: INSTANCE_RECORD_BYTES as f64,
        texel_bytes: TEXEL_BYTES as f64,
        max_unique_triangles: max_unique_triangles(&limits) as f64,
        max_instances: (largest_table_bytes / INSTANCE_RECORD_BYTES as u64) as f64,
        max_texture_texels: (largest_table_bytes / TEXEL_BYTES) as f64,
        includes_acceleration_structure: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ABI_SOURCE: &str = include_str!("../cycles/abi.wgsl");
    const PACKER_SOURCE: &str = include_str!("../../pack-input-v2.mjs");

    /// The size the WGSL comment above `struct <name> {` states.
    fn wgsl_struct_bytes(name: &str) -> usize {
        let lines: Vec<&str> = ABI_SOURCE.lines().collect();
        let struct_line = lines.iter().position(|line| line.starts_with(&format!("struct {name} {{"))).unwrap();
        let comment = lines[..struct_line]
            .iter()
            .rev()
            .find(|line| line.starts_with("// ") && line.contains(" bytes"))
            .unwrap();
        comment[3..].split(' ').next().unwrap().parse().unwrap()
    }

    fn packer_stride(name: &str) -> usize {
        let line = PACKER_SOURCE.lines().find(|line| line.trim_start().starts_with(&format!("{name}:"))).unwrap();
        line.split(':').nth(1).unwrap().trim().trim_end_matches(',').parse().unwrap()
    }

    #[test]
    fn the_per_item_costs_equal_the_packed_layouts() {
        assert_eq!(TRIANGLE_RECORD_BYTES, wgsl_struct_bytes("TriangleRecord"));
        assert_eq!(TRIANGLE_RECORD_BYTES, packer_stride("triangle"));
        assert_eq!(INSTANCE_RECORD_BYTES, wgsl_struct_bytes("InstanceRecord"));
        assert_eq!(INSTANCE_RECORD_BYTES, packer_stride("instance"));
    }

    #[test]
    fn the_vertex_and_texel_costs_follow_their_element_types() {
        assert_eq!(VERTEX_BYTES_PER_TRIANGLE, 3 * 3 * std::mem::size_of::<f32>() as u64);
        assert_eq!(TEXEL_BYTES, std::mem::size_of::<u32>() as u64);
    }

    #[test]
    fn only_device_local_heaps_count_towards_memory() {
        assert_eq!(device_local_bytes(&[(1, 100), (0, 900), (1, 50)]), Some(150));
        assert_eq!(device_local_bytes(&[(0, 900)]), None);
        assert_eq!(device_local_bytes(&[]), None);
    }

    #[test]
    fn the_triangle_bound_follows_the_smaller_limit() {
        let limits = wgpu::Limits {
            max_storage_buffer_binding_size: 224 * 1000,
            max_buffer_size: 224 * 10 + 5,
            ..wgpu::Limits::default()
        };
        assert_eq!(max_unique_triangles(&limits), 10);
        let wide = wgpu::Limits { max_storage_buffer_binding_size: 224 * 1000, max_buffer_size: 1 << 40, ..wgpu::Limits::default() };
        assert_eq!(max_unique_triangles(&wide), 1000);
    }
}
