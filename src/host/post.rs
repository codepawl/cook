use std::sync::atomic::Ordering;
use std::time::Instant;

use napi::Result;
use wgpu::util::DeviceExt;

use crate::host::denoise::DeviceHealth;
use crate::host::device::{failure, layout_entry, storage_entry};
use crate::host::film::image_workgroups;
use crate::host::session::{compile_compute_pipeline, take_uncaptured_error};

const SHADER_SOURCE: &str = include_str!("../post.wgsl");
/// Must match `BLOOM_CELL` in post.wgsl: the bloom is computed on a copy this many times smaller.
const BLOOM_CELL: u32 = 8;
/// Bloom radius 1 is this share of the image height, in pixels of the full-size image.
const BLOOM_RADIUS_HEIGHT_SHARE: f32 = 0.01;
const MAXIMUM_BLUR_TAPS: u32 = 32;
const MINIMUM_BLOOM_SIGMA: f32 = 0.5;
const MAXIMUM_BUFFER_BYTES: u64 = 1 << 30;
const MAXIMUM_WORKGROUPS_PER_DIMENSION: u32 = 65_535;

/// The look of one post stage. JavaScript has validated and defaulted every field; the view transform is one of
/// `standard`, `aces`, `agx` and `neutral`.
pub(crate) struct PostSettings {
    pub(crate) exposure: f32,
    pub(crate) view_transform: String,
    pub(crate) white_balance: f32,
    pub(crate) lift: [f32; 3],
    pub(crate) gamma: [f32; 3],
    pub(crate) gain: [f32; 3],
    pub(crate) bloom_strength: f32,
    pub(crate) bloom_radius: f32,
    pub(crate) bloom_threshold: f32,
    pub(crate) grain_amount: f32,
    pub(crate) grain_seed: u32,
    pub(crate) vignette_strength: f32,
}

pub(crate) struct PostOutput {
    /// RGBA, four bytes per pixel, row by row from the top; the colour is sRGB-encoded (power 1 / 2.2).
    pub(crate) display: Vec<u8>,
    /// Upload, the dispatches and the readback.
    pub(crate) seconds: f64,
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct ShaderParameters {
    sizes: [u32; 4],
    tone: [f32; 4],
    lift: [f32; 4],
    gamma: [f32; 4],
    gain: [f32; 4],
    finish: [f32; 4],
    switches: [u32; 4],
}

fn view_transform_index(name: &str) -> Result<u32> {
    match name {
        "standard" => Ok(0),
        "aces" => Ok(1),
        "agx" => Ok(2),
        "neutral" => Ok(3),
        other => Err(failure(format!(
            "Invalid post viewTransform {other:?}: pass \"agx\", \"aces\", \"neutral\" or \"standard\"."
        ))),
    }
}

fn padded(values: [f32; 3]) -> [f32; 4] {
    [values[0], values[1], values[2], 0.0]
}

/// The gaussian of the bloom: its sigma in bloom pixels and how many taps it reads on each side of a pixel.
fn bloom_blur_shape(radius: f32, image_height: u32) -> (f32, u32) {
    let sigma = (radius * BLOOM_RADIUS_HEIGHT_SHARE * image_height as f32 / BLOOM_CELL as f32).max(MINIMUM_BLOOM_SIGMA);
    let taps = ((sigma * 3.0).ceil() as u32).min(MAXIMUM_BLUR_TAPS);
    (sigma, taps)
}

fn shader_parameters(settings: &PostSettings, width: u32, height: u32) -> Result<ShaderParameters> {
    let bloom_on = settings.bloom_strength > 0.0;
    let (sigma, taps) = bloom_blur_shape(settings.bloom_radius, height);
    Ok(ShaderParameters {
        sizes: [width, height, width.div_ceil(BLOOM_CELL), height.div_ceil(BLOOM_CELL)],
        tone: [settings.exposure, settings.white_balance, settings.bloom_strength, settings.bloom_threshold],
        lift: padded(settings.lift),
        gamma: padded(settings.gamma),
        gain: padded(settings.gain),
        finish: [settings.vignette_strength, settings.grain_amount, sigma, 0.0],
        switches: [
            view_transform_index(&settings.view_transform)?,
            settings.grain_seed,
            taps,
            u32::from(bloom_on),
        ],
    })
}

fn validate_input(rgba: &[f32], width: u32, height: u32) -> Result<()> {
    if width == 0 || height == 0 {
        return Err(failure("The post stage needs a width and a height of at least 1."));
    }
    let (groups_x, groups_y) = image_workgroups(width, height);
    if groups_x > MAXIMUM_WORKGROUPS_PER_DIMENSION || groups_y > MAXIMUM_WORKGROUPS_PER_DIMENSION {
        return Err(failure(format!(
            "The post stage handles at most {} pixels per side, got {width}x{height}.",
            MAXIMUM_WORKGROUPS_PER_DIMENSION * 8
        )));
    }
    let pixel_count = width as u64 * height as u64;
    if pixel_count * 16 > MAXIMUM_BUFFER_BYTES {
        return Err(failure("The image is too large for the post stage's buffers."));
    }
    if rgba.len() as u64 != pixel_count * 4 {
        return Err(failure(format!(
            "The post stage expects {} floats for a {width}x{height} film, got {}.",
            pixel_count * 4,
            rgba.len()
        )));
    }
    Ok(())
}

fn post_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
    let parameters = layout_entry(
        0,
        wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: None,
        },
    );
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("post stage"),
        entries: &[
            parameters,
            storage_entry(1, true),
            storage_entry(2, false),
            storage_entry(3, false),
            storage_entry(4, false),
        ],
    })
}

fn empty_storage(device: &wgpu::Device, label: &str, bytes: u64, extra_usage: wgpu::BufferUsages) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some(label),
        size: bytes.max(16),
        usage: wgpu::BufferUsages::STORAGE | extra_usage,
        mapped_at_creation: false,
    })
}

fn read_display_bytes(device: &wgpu::Device, queue: &wgpu::Queue, display: &wgpu::Buffer, bytes: u64) -> Result<Vec<u8>> {
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("post readback"),
        size: bytes,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("post readback") });
    encoder.copy_buffer_to_buffer(display, 0, &readback, 0, bytes);
    queue.submit(Some(encoder.finish()));
    readback.slice(..).map_async(wgpu::MapMode::Read, |_| {});
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let mapped = readback
        .slice(..)
        .get_mapped_range()
        .map_err(|error| failure(format!("Could not read the display image back: {error}")))?;
    let display_bytes = mapped.to_vec();
    drop(mapped);
    readback.unmap();
    readback.destroy();
    Ok(display_bytes)
}

fn dispatch_pass(
    encoder: &mut wgpu::CommandEncoder,
    pipeline: &wgpu::ComputePipeline,
    bind_group: &wgpu::BindGroup,
    groups: (u32, u32),
) {
    let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: None, timestamp_writes: None });
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, bind_group, &[]);
    pass.dispatch_workgroups(groups.0, groups.1, 1);
}

fn fail_if_post_failed(health: &DeviceHealth<'_>, device_was_lost: bool) -> Result<()> {
    if let Some(reported) = take_uncaptured_error(health.uncaptured_error) {
        return Err(failure(format!(
            "The GPU rejected the post stage ({reported}). Lower the image size and run it again."
        )));
    }
    if !device_was_lost && health.device_lost.load(Ordering::SeqCst) {
        let detail = health.device_error.lock().map(|stored| stored.clone()).unwrap_or_default();
        return Err(failure(format!(
            "The GPU device was lost while the post stage ran ({detail}). Create a new session or run it again."
        )));
    }
    Ok(())
}

/// The compiled passes of the post stage, kept by a session so only the first frame with a `post` pays for compiling them.
pub(crate) struct PostPipelines {
    layout: wgpu::BindGroupLayout,
    bloom_down: wgpu::ComputePipeline,
    bloom_blur_horizontal: wgpu::ComputePipeline,
    bloom_blur_vertical: wgpu::ComputePipeline,
    finish: wgpu::ComputePipeline,
}

impl PostPipelines {
    pub(crate) fn compile(device: &wgpu::Device) -> Result<PostPipelines> {
        let layout = post_layout(device);
        let compile = |entry_point: &str| compile_compute_pipeline(device, SHADER_SOURCE.to_string(), entry_point, &layout);
        Ok(PostPipelines {
            bloom_down: compile("bloom_down")?,
            bloom_blur_horizontal: compile("bloom_blur_horizontal")?,
            bloom_blur_vertical: compile("bloom_blur_vertical")?,
            finish: compile("finish")?,
            layout,
        })
    }
}

/// Turns a linear RGBA film into 8-bit display RGBA on the GPU; the only readback is the 8-bit buffer.
pub(crate) fn apply_post(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    pipelines: &PostPipelines,
    rgba: &[f32],
    width: u32,
    height: u32,
    settings: &PostSettings,
    health: &DeviceHealth<'_>,
) -> Result<PostOutput> {
    validate_input(rgba, width, height)?;
    let parameters = shader_parameters(settings, width, height)?;
    let device_was_lost = health.device_lost.load(Ordering::SeqCst);
    let _ = take_uncaptured_error(health.uncaptured_error);

    let bloom_on = settings.bloom_strength > 0.0;
    let started = Instant::now();
    let pixel_count = width as u64 * height as u64;
    let bloom_pixels = parameters.sizes[2] as u64 * parameters.sizes[3] as u64;
    let parameter_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("post parameters"),
        contents: bytemuck::bytes_of(&parameters),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let film = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("post film"),
        contents: bytemuck::cast_slice(rgba),
        usage: wgpu::BufferUsages::STORAGE,
    });
    let bloom_bytes = if bloom_on { bloom_pixels * 16 } else { 16 };
    let bloom_a = empty_storage(device, "post bloom a", bloom_bytes, wgpu::BufferUsages::empty());
    let bloom_b = empty_storage(device, "post bloom b", bloom_bytes, wgpu::BufferUsages::empty());
    let display_bytes = pixel_count * 4;
    let display = empty_storage(device, "post display", display_bytes, wgpu::BufferUsages::COPY_SRC);
    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("post stage"),
        layout: &pipelines.layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: parameter_buffer.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: film.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: bloom_a.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 3, resource: bloom_b.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 4, resource: display.as_entire_binding() },
        ],
    });

    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("post stage") });
    if bloom_on {
        let bloom_groups = image_workgroups(parameters.sizes[2], parameters.sizes[3]);
        dispatch_pass(&mut encoder, &pipelines.bloom_down, &bind_group, bloom_groups);
        dispatch_pass(&mut encoder, &pipelines.bloom_blur_horizontal, &bind_group, bloom_groups);
        dispatch_pass(&mut encoder, &pipelines.bloom_blur_vertical, &bind_group, bloom_groups);
    }
    dispatch_pass(&mut encoder, &pipelines.finish, &bind_group, image_workgroups(width, height));
    queue.submit(Some(encoder.finish()));
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    fail_if_post_failed(health, device_was_lost)?;

    let display_image = read_display_bytes(device, queue, &display, display_bytes)?;
    Ok(PostOutput { display: display_image, seconds: started.elapsed().as_secs_f64() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(view_transform: &str) -> PostSettings {
        PostSettings {
            exposure: 1.0,
            view_transform: view_transform.to_string(),
            white_balance: 0.0,
            lift: [0.0; 3],
            gamma: [1.0; 3],
            gain: [1.0; 3],
            bloom_strength: 0.0,
            bloom_radius: 1.0,
            bloom_threshold: 1.0,
            grain_amount: 0.0,
            grain_seed: 0,
            vignette_strength: 0.0,
        }
    }

    #[test]
    fn an_unknown_view_transform_is_refused_with_the_valid_names() {
        let message = shader_parameters(&settings("filmic"), 4, 4).err().unwrap().reason;
        assert!(message.contains("\"agx\""), "{message}");
    }

    #[test]
    fn the_bloom_copy_covers_a_size_that_is_not_a_multiple_of_the_cell() {
        let parameters = shader_parameters(&settings("agx"), 17, 9).unwrap();
        assert_eq!(parameters.sizes, [17, 9, 3, 2]);
    }

    #[test]
    fn the_blur_never_reads_more_taps_than_the_shader_allows() {
        let (_, taps) = bloom_blur_shape(8.0, 4320);
        assert_eq!(taps, MAXIMUM_BLUR_TAPS);
    }

    #[test]
    fn a_film_of_the_wrong_length_is_refused() {
        let message = validate_input(&[0.0; 7], 2, 1).unwrap_err().reason;
        assert!(message.contains("expects 8 floats"), "{message}");
    }
}
