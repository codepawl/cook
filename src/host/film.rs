use napi::Result;

use crate::host::device::failure;

const WORKGROUP_SIZE: u32 = 8;
/// Must match `TEXEL_WORKGROUP_SIZE` in texel.wgsl.
const TEXEL_WORKGROUP_SIZE: u32 = 64;
/// A dispatch is at most 65535 workgroups wide; a larger bake wraps onto the second dimension.
const MAXIMUM_TEXEL_GROUPS_X: u32 = 4096;

pub(crate) struct ResolvedImage {
    pub(crate) rgba: Vec<f32>,
    pub(crate) albedo: Vec<f32>,
    pub(crate) normal: Vec<f32>,
    pub(crate) depth: Vec<f32>,
    pub(crate) variance: Vec<f32>,
    pub(crate) average_samples: f64,
}

pub(crate) struct ResolvedTexels {
    pub(crate) radiance: Vec<f32>,
    pub(crate) escaped: Vec<f32>,
}

pub(crate) fn image_accumulation_bytes(width: u32, height: u32) -> u64 {
    let pixel_count = width as u64 * height as u64;
    pixel_count * 4 * 16
}

pub(crate) fn image_workgroups(width: u32, height: u32) -> (u32, u32) {
    let groups_x = width.div_ceil(WORKGROUP_SIZE);
    let groups_y = height.div_ceil(WORKGROUP_SIZE);
    (groups_x, groups_y)
}

pub(crate) fn texel_accumulation_bytes(count: usize) -> u64 {
    count as u64 * 2 * 16
}

pub(crate) fn texel_workgroups(count: u32) -> (u32, u32) {
    let workgroups = count.div_ceil(TEXEL_WORKGROUP_SIZE);
    let groups_x = workgroups.min(MAXIMUM_TEXEL_GROUPS_X);
    let groups_y = workgroups.div_ceil(groups_x);
    (groups_x, groups_y)
}

/// Must match `LT_FIXED_POINT_SCALE` in integrator.wgsl: the splat buffer holds the photon contributions times this.
pub(crate) const CAUSTIC_FIXED_POINT_SCALE: f32 = 4096.0;

/// The caustic splat buffer of a film and what the host needs to turn it into radiance.
pub(crate) struct CausticSplat<'a> {
    pub(crate) buffer: &'a wgpu::Buffer,
    pub(crate) pixel_count: u64,
    pub(crate) photons_per_sample: u32,
    /// The `total_samples` the kernel divided every photon by.
    pub(crate) planned_samples: u32,
}

/// Four u32 per pixel (red, green, blue and one unused word).
pub(crate) fn caustic_splat_bytes(width: u32, height: u32) -> u64 {
    width as u64 * height as u64 * 16
}

pub(crate) fn read_accumulation(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    accumulation: &wgpu::Buffer,
    accumulation_bytes: u64,
) -> Result<Vec<f32>> {
    read_buffer_words::<f32>(device, queue, accumulation, accumulation_bytes)
}

/// The film sums, with the caustic splats added to the radiance when the frame light traced.
pub(crate) fn read_film_sums(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    accumulation: &wgpu::Buffer,
    accumulation_bytes: u64,
    caustics: Option<&CausticSplat<'_>>,
) -> Result<Vec<f32>> {
    let mut sums = read_accumulation(device, queue, accumulation, accumulation_bytes)?;
    if let Some(splat) = caustics {
        let splat_words = read_buffer_words::<u32>(device, queue, splat.buffer, splat.pixel_count * 16)?;
        add_caustic_splat(&mut sums, &splat_words, splat.pixel_count, splat.photons_per_sample, splat.planned_samples);
    }
    Ok(sums)
}

/// Adds the splatted photons to the radiance sums. The kernel divided each photon by the photons it planned
/// (`pixel_count * planned_samples * photons_per_sample`); the samples actually taken can differ (a time limit, an unfinished
/// accumulation), so the sum is rescaled to the photons really traced. `resolve_image` divides the radiance of a pixel by its own
/// sample count, so the mean is multiplied by that count here.
pub(crate) fn add_caustic_splat(
    sums: &mut [f32],
    splat_words: &[u32],
    pixel_count: u64,
    photons_per_sample: u32,
    planned_samples: u32,
) {
    let pixel_total = pixel_count as usize;
    let plane_length = pixel_total * 4;
    let taken_total: f64 = (0..pixel_total).map(|pixel| sums[3 * plane_length + pixel * 4 + 3] as f64).sum();
    if taken_total <= 0.0 || photons_per_sample == 0 {
        return;
    }
    let planned_photons = pixel_count as f64 * planned_samples.max(1) as f64;
    let rescale = planned_photons / taken_total;
    for pixel in 0..pixel_total {
        let taken = sums[3 * plane_length + pixel * 4 + 3].max(1.0) as f64;
        for channel in 0..3 {
            let fixed_point = splat_words[pixel * 4 + channel] as f64;
            let mean_radiance = fixed_point / CAUSTIC_FIXED_POINT_SCALE as f64 * rescale;
            sums[pixel * 4 + channel] += (mean_radiance * taken) as f32;
        }
    }
}

fn read_buffer_words<T: bytemuck::Pod>(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    accumulation: &wgpu::Buffer,
    accumulation_bytes: u64,
) -> Result<Vec<T>> {
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("readback"),
        size: accumulation_bytes,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut copy_encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("readback"),
    });
    copy_encoder.copy_buffer_to_buffer(accumulation, 0, &readback, 0, accumulation_bytes);
    queue.submit(Some(copy_encoder.finish()));
    readback.slice(..).map_async(wgpu::MapMode::Read, |_| {});
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let mapped = readback
        .slice(..)
        .get_mapped_range()
        .map_err(|error| failure(format!("Could not read the result back: {error}")))?;
    let sums: Vec<T> = bytemuck::cast_slice::<u8, T>(&mapped).to_vec();
    drop(mapped);
    // Release the one-frame staging buffer now instead of when a later poll collects the dropped handle.
    readback.unmap();
    readback.destroy();
    Ok(sums)
}

/// Alpha from the albedo lane's fourth float, which sums 1 for each sample whose camera path ended on the transparent
/// background. A lane that was never written holds 0, so alpha is exactly 1.0 and a render without a transparent background
/// is unchanged. The radiance next to it is premultiplied by this alpha, as Cycles writes it.
fn coverage_alpha(background_coverage_sum: f32, sample_scale: f32) -> f32 {
    if background_coverage_sum <= 0.0 {
        return 1.0;
    }
    (1.0 - background_coverage_sum * sample_scale).clamp(0.0, 1.0)
}

pub(crate) fn resolve_image(sums: &[f32], pixel_count: u64) -> ResolvedImage {
    let pixel_total = pixel_count as usize;
    let plane_length = pixel_total * 4;
    let mut taken_total = 0.0f64;
    let mut rgba = Vec::with_capacity(pixel_total * 4);
    let mut albedo = Vec::with_capacity(pixel_total * 3);
    let mut normal = Vec::with_capacity(pixel_total * 3);
    let mut depth = Vec::with_capacity(pixel_total);
    let mut variance = Vec::with_capacity(pixel_total);
    for pixel in 0..pixel_total {
        let radiance = &sums[pixel * 4..pixel * 4 + 4];
        let albedo_sum = &sums[plane_length + pixel * 4..plane_length + pixel * 4 + 3];
        let background_coverage_sum = sums[plane_length + pixel * 4 + 3];
        let normal_sum = &sums[2 * plane_length + pixel * 4..2 * plane_length + pixel * 4 + 3];
        let statistics = &sums[3 * plane_length + pixel * 4..3 * plane_length + pixel * 4 + 4];
        // A pixel that converged early drew fewer samples; its sums are divided by its own count.
        let taken = statistics[3].max(1.0);
        taken_total += taken as f64;
        let sample_scale = 1.0 / taken;
        let variance_divisor = (taken - 1.0).max(1.0);
        rgba.extend_from_slice(&[
            radiance[0] * sample_scale,
            radiance[1] * sample_scale,
            radiance[2] * sample_scale,
            coverage_alpha(background_coverage_sum, sample_scale),
        ]);
        depth.push(radiance[3] * sample_scale);
        albedo.extend(albedo_sum.iter().map(|value| value * sample_scale));
        normal.extend(normal_sum.iter().map(|value| value * sample_scale));
        let mean_luminance = statistics[0] * sample_scale;
        let luminance_variance = (statistics[1] * sample_scale - mean_luminance * mean_luminance).max(0.0);
        variance.push(luminance_variance / variance_divisor);
    }
    let average_samples = taken_total / pixel_count.max(1) as f64;
    ResolvedImage {
        rgba,
        albedo,
        normal,
        depth,
        variance,
        average_samples,
    }
}

/// Three floats per texel, padded to the four the kernel's vec4 arrays read.
pub(crate) fn pad_texel_vectors(vectors: &[f32], count: usize) -> Vec<u8> {
    let mut padded: Vec<f32> = Vec::with_capacity(count * 4);
    for texel in 0..count {
        padded.extend_from_slice(&vectors[texel * 3..texel * 3 + 3]);
        padded.push(0.0);
    }
    bytemuck::cast_slice(&padded).to_vec()
}

pub(crate) fn resolve_texels(sums: &[f32], count: usize, samples: u32) -> ResolvedTexels {
    let sample_scale = 1.0 / samples.max(1) as f32;
    let mut radiance = Vec::with_capacity(count * 3);
    let mut escaped = Vec::with_capacity(count);
    for texel in 0..count {
        radiance.extend(sums[texel * 4..texel * 4 + 3].iter().map(|value| value * sample_scale));
        escaped.push(sums[(count + texel) * 4] * sample_scale);
    }
    ResolvedTexels { radiance, escaped }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One pixel's four planes: radiance+depth, albedo+coverage, normal, moments+count.
    fn one_pixel_sums(background_coverage_sum: f32, taken: f32) -> Vec<f32> {
        vec![
            0.5 * taken, 0.25 * taken, 0.125 * taken, 0.0,
            0.0, 0.0, 0.0, background_coverage_sum,
            0.0, 0.0, 0.0, 0.0,
            0.0, 0.0, 0.0, taken,
        ]
    }

    #[test]
    fn a_splat_adds_its_mean_radiance_to_the_pixel_it_landed_in() {
        // Two pixels of 4 samples each; the kernel planned 4 samples. Pixel 0 holds 2.0 in red (fixed point), pixel 1 nothing.
        let mut sums = vec![0.0f32; 2 * 16];
        sums[2 * 12 + 3] = 4.0;
        sums[2 * 12 + 4 + 3] = 4.0;
        let mut splat_words = vec![0u32; 8];
        splat_words[0] = (2.0 * CAUSTIC_FIXED_POINT_SCALE) as u32;
        add_caustic_splat(&mut sums, &splat_words, 2, 1, 4);
        let image = resolve_image(&sums, 2);
        assert!((image.rgba[0] - 2.0).abs() < 1.0e-6, "{:?}", image.rgba);
        assert_eq!(image.rgba[4], 0.0);
    }

    #[test]
    fn a_splat_is_rescaled_when_fewer_samples_were_taken_than_planned() {
        let mut sums = vec![0.0f32; 16];
        sums[12 + 3] = 2.0;
        let mut splat_words = vec![0u32; 4];
        splat_words[1] = (1.0 * CAUSTIC_FIXED_POINT_SCALE) as u32;
        add_caustic_splat(&mut sums, &splat_words, 1, 1, 4);
        let image = resolve_image(&sums, 1);
        assert!((image.rgba[1] - 2.0).abs() < 1.0e-6, "{:?}", image.rgba);
    }

    #[test]
    fn a_film_that_never_wrote_coverage_resolves_to_alpha_one() {
        let image = resolve_image(&one_pixel_sums(0.0, 4.0), 1);
        assert_eq!(image.rgba, vec![0.5, 0.25, 0.125, 1.0]);
    }

    #[test]
    fn a_pixel_that_saw_only_background_resolves_to_alpha_zero() {
        let image = resolve_image(&one_pixel_sums(8.0, 8.0), 1);
        assert_eq!(image.rgba[3], 0.0);
    }

    #[test]
    fn coverage_is_divided_by_the_samples_the_pixel_took() {
        let image = resolve_image(&one_pixel_sums(1.0, 4.0), 1);
        assert_eq!(image.rgba[3], 0.75);
    }

    #[test]
    fn a_rounding_overshoot_never_leaves_the_unit_range() {
        let image = resolve_image(&one_pixel_sums(4.0000005, 4.0), 1);
        assert!(image.rgba[3] >= 0.0 && image.rgba[3] <= 1.0);
    }
}
