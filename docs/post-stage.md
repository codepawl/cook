# Post stage

`session.render({ post })` and `session.resolve({ post })` turn the film into 8-bit sRGB RGBA on the GPU, so a film frame needs no JavaScript loop over its pixels. Without `post` the result is byte for byte what it was.

```js
const frame = session.render({
  samples: 64,
  denoise: 'atrous',
  post: { viewTransform: 'agx', exposure: 1.2, bloom: { strength: 0.2, threshold: 1 }, grain: { amount: 0.02, seed: frameIndex }, vignette: { strength: 0.2 } },
});
frame.display; // Uint8Array, width * height * 4, rows from the top
frame.rgba;    // the linear float film, as before
frame.postSeconds;
```

`display` is made from `denoisedRgba` when a denoise was asked for, else from `rgba`. Alpha is the film's alpha as a byte; the colour is not divided by it.

## Options

Every field is optional. A value outside its range throws an error that names the field and the valid range.

| Option | Range | Default |
| --- | --- | --- |
| `exposure` | 0.01 to 16, a multiplier of the linear film | 1 |
| `viewTransform` | `agx`, `aces`, `neutral`, `standard` (clamp only) | `agx` |
| `whiteBalance` | -1 (cool) to 1 (warm) | 0 |
| `lift` | -0.5 to 0.5, a number or `[r, g, b]` | 0 |
| `gamma` | 0.2 to 5, a number or `[r, g, b]` | 1 |
| `gain` | 0 to 4, a number or `[r, g, b]` | 1 |
| `bloom.strength` | 0 to 4 (0 skips the bloom) | 0 |
| `bloom.radius` | 0 to 8; 1 is 1% of the image height | 1 |
| `bloom.threshold` | 0 to 64, in exposed linear light | 1 |
| `grain.amount` | 0 to 0.1, the peak-to-peak size in display units | 0 |
| `grain.seed` | whole number, 0 to 4294967295 | 0 |
| `vignette.strength` | 0 to 1 | 0 |

## Order

1. Multiply the linear film by `exposure`.
2. Bloom: the part of the exposed film above `bloom.threshold` (per channel) is averaged over 8x8 pixel cells, blurred with a gaussian (sigma `radius` * 1% of the height, at most 32 taps a side on the small copy), upsampled bilinearly and added times `strength`.
3. The view transform, then the power 1 / 2.2. The curves are those of Crucible's `src/view-transform.js` (`agxColor`, `acesChannel`, `neutralColor`), and the encode is its `displayColor`.
4. White balance, as Crucible's `temperature`: red times `1 + 0.1 * whiteBalance`, blue times `1 - 0.1 * whiteBalance`.
5. `max(color * gain + lift, 0) ** (1 / gamma)` per channel.
6. Vignette, as Crucible's: times `max(0, 1 - strength * dot(c, c))`, with `c` the pixel centre in -1 to 1.
7. Grain: add `(hash(x, y, seed) - 0.5) * amount`. The hash is an integer PCG hash, so a seed gives the same picture on every GPU; it is not the sin hash of Crucible's browser shader.
8. Clamp to 0 to 1 and round to a byte.

## Tolerance against the JavaScript reference

`tests/gpu/post.test.mjs` compares `display` with `tests/support/post-reference.mjs`, a double-precision twin of the shader (the Crucible curve functions copied into it), over a rendered 100x75 film with every option on, for all four view transforms. Largest accepted difference: 2/255 per channel. Grain has its own test (same seed gives the same bytes, another seed does not, the offset stays inside the amount).

Crucible's browser post pass is not a bit-exact target: it blurs bloom with its own kernel, applies saturation and contrast, and hashes its grain with `sin`. This stage matches Crucible's curves, order of tone steps, temperature and vignette; its bloom and grain follow the definitions above.

## Cost

`tools/measure-post-timing.mjs [width] [height] [runs]` prints the median of `postSeconds` (upload, passes and the 8-bit readback). The fixture room is 4:3, so the run uses 1440x1080 and 1920x1440. The first frame of a session with a `post` compiles the passes; later frames reuse them.
