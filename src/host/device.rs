use std::borrow::Cow;

use napi::{Error, Result};
use wgpu::util::DeviceExt;

pub(crate) fn failure(message: impl Into<String>) -> Error {
    Error::from_reason(message.into())
}

/// The bytes of a storage buffer: a multiple of four long and at least 16. Bytes that already fit are borrowed, so a texel
/// pool of hundreds of megabytes is not copied once more on the host before it reaches the GPU.
pub(crate) fn padded_storage_bytes(bytes: &[u8]) -> Cow<'_, [u8]> {
    let padded_length = bytes.len().next_multiple_of(4).max(16);
    if padded_length == bytes.len() {
        return Cow::Borrowed(bytes);
    }
    let mut padded = bytes.to_vec();
    padded.resize(padded_length, 0);
    Cow::Owned(padded)
}

pub(crate) fn storage_buffer(device: &wgpu::Device, label: &str, bytes: &[u8]) -> wgpu::Buffer {
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some(label),
        contents: &padded_storage_bytes(bytes),
        usage: wgpu::BufferUsages::STORAGE,
    })
}

pub(crate) fn layout_entry(binding: u32, binding_type: wgpu::BindingType) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: binding_type,
        count: None,
    }
}

pub(crate) fn storage_entry(binding: u32, read_only: bool) -> wgpu::BindGroupLayoutEntry {
    layout_entry(
        binding,
        wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Storage { read_only },
            has_dynamic_offset: false,
            min_binding_size: None,
        },
    )
}

/// The error for an adapter without ray queries. It names the adapter, because a software adapter (llvmpipe, lavapipe)
/// means the GPU driver did not load, which has a different fix than a GPU that is too old.
pub(crate) fn missing_ray_query_message(adapter_name: &str, device_type: wgpu::DeviceType) -> String {
    if device_type == wgpu::DeviceType::Cpu {
        return format!(
            "The Vulkan adapter does not support ray queries: Cook found only the software adapter \"{adapter_name}\", so the Vulkan driver of the GPU did not load. \
             Install the GPU driver; on a Linux server or container also install libegl1, libgl1, libx11-6 and libxext6, \
             and in Docker set NVIDIA_DRIVER_CAPABILITIES=all. `vulkaninfo --summary` lists the adapters Vulkan sees."
        );
    }
    format!(
        "The Vulkan adapter does not support ray queries: \"{adapter_name}\" does not report VK_KHR_ray_query. \
         Cook needs a GPU that does, such as NVIDIA RTX, AMD Radeon RX 6000, Intel Arc or newer, with a current driver."
    )
}

/// The most bytes one storage buffer can hold on this device: a binding is capped by the binding limit and the buffer by the buffer limit.
pub(crate) fn largest_storage_buffer_bytes(limits: &wgpu::Limits) -> u64 {
    u64::from(limits.max_storage_buffer_binding_size).min(limits.max_buffer_size)
}

/// Refuses a table that does not fit one storage buffer of the device, naming the table, its size and the limit. Without this
/// the upload makes an invalid buffer, wgpu reports it late, and the render fails with a message that does not say why.
pub(crate) fn check_buffer_sizes_fit(tables: &[(&str, u64)], limits: &wgpu::Limits) -> Result<()> {
    let limit_bytes = largest_storage_buffer_bytes(limits);
    for (table_name, table_bytes) in tables {
        if *table_bytes > limit_bytes {
            let overshoot_bytes = table_bytes - limit_bytes;
            return Err(failure(format!(
                "The {table_name} table needs {table_bytes} bytes, but the device limit is {limit_bytes} bytes (the smaller of max storage buffer binding size {} and max buffer size {}), {overshoot_bytes} bytes over. Drop what fills this table: fewer triangles, fewer instances, fewer or smaller textures or a smaller image, or render on a GPU with a larger storage buffer limit. `adapterCapacity()` lists the limits and the bytes each triangle, instance and texel costs.",
                limits.max_storage_buffer_binding_size, limits.max_buffer_size
            )));
        }
    }
    Ok(())
}

/// Runs GPU work inside an out-of-memory and a validation error scope and turns what wgpu reports into an error that says
/// what was being done. The error then belongs to this call alone: it does not mark the shared device lost.
pub(crate) fn run_in_error_scopes<T>(device: &wgpu::Device, doing: &str, work: impl FnOnce() -> T) -> Result<T> {
    let validation_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let memory_scope = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let produced = work();
    let memory_error = pollster::block_on(memory_scope.pop());
    let validation_error = pollster::block_on(validation_scope.pop());
    if let Some(error) = memory_error {
        return Err(failure(format!(
            "The GPU ran out of memory while {doing}: {error}. Lower the image size or the scene size and run the render again."
        )));
    }
    if let Some(error) = validation_error {
        return Err(failure(format!("The GPU rejected the work while {doing}: {error}")));
    }
    Ok(produced)
}

/// Cook asks the device for at most this much per buffer, whatever the adapter offers (1 GiB).
pub(crate) const DEVICE_BUFFER_CAP_BYTES: u64 = 1 << 30;

/// The adapter Cook renders on: the high performance Vulkan adapter, or an error that says why there is none.
pub(crate) fn request_adapter() -> Result<wgpu::Adapter> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::VULKAN,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        ..Default::default()
    }))
    .map_err(|error| failure(format!("No Vulkan adapter: {error}")))
}

/// The limits Cook opens the device with, from what the adapter offers.
pub(crate) fn required_device_limits(adapter_limits: &wgpu::Limits) -> wgpu::Limits {
    wgpu::Limits {
        max_storage_buffer_binding_size: adapter_limits.max_storage_buffer_binding_size.min(DEVICE_BUFFER_CAP_BYTES),
        max_buffer_size: adapter_limits.max_buffer_size.min(DEVICE_BUFFER_CAP_BYTES),
        // The light bake binds nine storage buffers (the scene, the accumulation and the texels); the default allows eight.
        max_storage_buffers_per_shader_stage: adapter_limits.max_storage_buffers_per_shader_stage.min(16),
        ..wgpu::Limits::default()
    }
    .using_minimum_supported_acceleration_structure_values()
}

pub(crate) fn open_device() -> Result<(wgpu::Device, wgpu::Queue, wgpu::AdapterInfo)> {
    let adapter = request_adapter()?;
    if !adapter.features().contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY) {
        let adapter_info = adapter.get_info();
        return Err(failure(missing_ray_query_message(&adapter_info.name, adapter_info.device_type)));
    }
    let required_limits = required_device_limits(&adapter.limits());
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("render-native"),
        required_features: wgpu::Features::EXPERIMENTAL_RAY_QUERY,
        required_limits,
        experimental_features: unsafe { wgpu::ExperimentalFeatures::enabled() },
        ..Default::default()
    }))
    .map_err(|error| failure(format!("Could not open the device: {error}")))?;
    Ok((device, queue, adapter.get_info()))
}

#[cfg(test)]
mod tests {
    use super::{check_buffer_sizes_fit, largest_storage_buffer_bytes, missing_ray_query_message, padded_storage_bytes};
    use std::borrow::Cow;

    #[test]
    fn a_table_over_the_binding_limit_is_named_with_its_size_and_the_limit() {
        let limits = wgpu::Limits::default();
        let limit_bytes = largest_storage_buffer_bytes(&limits);
        let message = check_buffer_sizes_fit(&[("lights", 16), ("triangles", limit_bytes + 1)], &limits)
            .unwrap_err()
            .to_string();
        assert!(message.contains("The triangles table needs"));
        assert!(message.contains(&format!("{} bytes", limit_bytes + 1)));
        assert!(message.contains(&format!("device limit is {limit_bytes} bytes")));
        assert!(message.contains("1 bytes over"));
        assert!(message.contains("Drop what fills this table"));
    }

    #[test]
    fn an_oversized_texture_pool_names_the_limit_the_overshoot_and_what_to_drop() {
        let limits = wgpu::Limits::default();
        let limit_bytes = largest_storage_buffer_bytes(&limits);
        let message = check_buffer_sizes_fit(&[("texture pool", limit_bytes + 4096)], &limits).unwrap_err().to_string();
        assert!(message.contains("The texture pool table needs"), "{message}");
        assert!(message.contains(&format!("device limit is {limit_bytes} bytes")), "{message}");
        assert!(message.contains("4096 bytes over"), "{message}");
        assert!(message.contains("fewer or smaller textures"), "{message}");
    }

    #[test]
    fn the_too_large_message_has_no_run_of_spaces() {
        let limits = wgpu::Limits::default();
        let limit_bytes = largest_storage_buffer_bytes(&limits);
        let message = check_buffer_sizes_fit(&[("triangles", limit_bytes + 1)], &limits).unwrap_err().to_string();
        assert!(!message.contains("  "), "{message}");
    }

    #[test]
    fn tables_at_or_under_the_limit_pass() {
        let limits = wgpu::Limits::default();
        let limit_bytes = largest_storage_buffer_bytes(&limits);
        assert!(check_buffer_sizes_fit(&[("triangles", limit_bytes), ("lights", 0)], &limits).is_ok());
    }

    #[test]
    fn a_software_adapter_is_named_with_the_driver_fix() {
        let message = missing_ray_query_message("llvmpipe (LLVM 15.0.7, 256 bits)", wgpu::DeviceType::Cpu);
        assert!(message.starts_with("The Vulkan adapter does not support ray queries: "));
        assert!(message.contains("software adapter \"llvmpipe (LLVM 15.0.7, 256 bits)\""));
        assert!(message.contains("libegl1, libgl1, libx11-6 and libxext6"));
        assert!(message.contains("NVIDIA_DRIVER_CAPABILITIES=all"));
    }

    #[test]
    fn a_gpu_without_ray_queries_is_named_with_the_cards_that_have_them() {
        let message = missing_ray_query_message("NVIDIA GeForce GTX 1080", wgpu::DeviceType::DiscreteGpu);
        assert!(message.starts_with("The Vulkan adapter does not support ray queries: "));
        assert!(message.contains("\"NVIDIA GeForce GTX 1080\" does not report VK_KHR_ray_query"));
        assert!(!message.contains("software adapter"));
    }

    #[test]
    fn padded_storage_bytes_borrows_bytes_that_already_fit() {
        let bytes = [7u8; 32];
        let padded = padded_storage_bytes(&bytes);
        assert!(matches!(padded, Cow::Borrowed(_)));
        assert_eq!(padded.as_ptr(), bytes.as_ptr());
    }

    #[test]
    fn padded_storage_bytes_pads_short_and_unaligned_input_with_zeros() {
        assert_eq!(padded_storage_bytes(&[]).len(), 16);
        let unaligned = padded_storage_bytes(&[1u8; 18]);
        assert_eq!(unaligned.len(), 20);
        assert_eq!(&unaligned[18..], &[0u8, 0u8]);
        assert_eq!(&unaligned[..18], &[1u8; 18]);
    }
}
