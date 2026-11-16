"""Scores a dispersion scene rendered by Cook and by Cycles (codepawl/crucible#1714) and writes a side by side PNG.

    uv run --no-project --with numpy --with pillow python tools/dispersion-parity-compare.py <prefix> [--exposure E]

Reads <prefix>.cook.npy and <prefix>.cycles.npy. The numbers that say whether the spectra match:
  - meanRatio: mean of each channel, Cook over Cycles (1 is equal energy);
  - spreadCook, spreadCycles: horizontal distance in pixels between the red and the blue centroid of the image, the width of the
    fan the glass makes (a glass without dispersion gives 0 for a symmetric scene);
  - fringeColourRatio: mean of the colour difference |R - B| over the mean of the channels, Cook over Cycles.
Writes <prefix>.compare.json and <prefix>.compare.png (Cook left, Cycles right).
"""
import json
import sys

import numpy
from PIL import Image


def srgb_bytes(linear, exposure):
    scaled = numpy.clip(linear[..., :3] * exposure, 0.0, 1.0)
    encoded = numpy.where(scaled <= 0.0031308, scaled * 12.92, 1.055 * numpy.power(scaled, 1 / 2.4) - 0.055)
    return (encoded * 255 + 0.5).astype(numpy.uint8)


def channel_centroids(image):
    columns = numpy.arange(image.shape[1], dtype=numpy.float64)
    centroids = []
    for channel in range(3):
        profile = image[..., channel].sum(axis=0).astype(numpy.float64)
        centroids.append(float((profile * columns).sum() / max(profile.sum(), 1e-12)))
    return centroids


def main():
    prefix = sys.argv[1]
    exposure = float(sys.argv[sys.argv.index("--exposure") + 1]) if "--exposure" in sys.argv else 1.0
    cook = numpy.load(prefix + ".cook.npy")[..., :3].astype(numpy.float64)
    cycles = numpy.load(prefix + ".cycles.npy")[..., :3].astype(numpy.float64)
    cook_centroids = channel_centroids(cook)
    cycles_centroids = channel_centroids(cycles)
    cook_fringe = numpy.abs(cook[..., 0] - cook[..., 2]).mean() / max(cook.mean(), 1e-12)
    cycles_fringe = numpy.abs(cycles[..., 0] - cycles[..., 2]).mean() / max(cycles.mean(), 1e-12)
    result = {
        "meanCook": cook.mean(axis=(0, 1)).tolist(),
        "meanCycles": cycles.mean(axis=(0, 1)).tolist(),
        "meanRatio": (cook.mean(axis=(0, 1)) / numpy.maximum(cycles.mean(axis=(0, 1)), 1e-12)).tolist(),
        "spreadCook": cook_centroids[0] - cook_centroids[2],
        "spreadCycles": cycles_centroids[0] - cycles_centroids[2],
        "fringeColourCook": float(cook_fringe),
        "fringeColourCycles": float(cycles_fringe),
        "fringeColourRatio": float(cook_fringe / max(cycles_fringe, 1e-12)),
    }
    with open(prefix + ".compare.json", "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=1)
    both = numpy.concatenate([srgb_bytes(cook, exposure), srgb_bytes(cycles, exposure)], axis=1)
    Image.fromarray(both).save(prefix + ".compare.png")
    print(json.dumps(result))


main()
