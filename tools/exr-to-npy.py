"""Converts linear EXR renders to .npy files (float32, height x width x 4, top row first) for tools/grid-volume-compare.mjs.

    blender -b --factory-startup --python tools/exr-to-npy.py -- in.exr out.npy [in2.exr out2.npy ...]
"""
import sys

import bpy
import numpy


def main():
    arguments = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(arguments) == 0 or len(arguments) % 2 != 0:
        raise SystemExit("usage: blender -b --factory-startup --python tools/exr-to-npy.py -- in.exr out.npy [in2.exr out2.npy ...]")
    for source, target in zip(arguments[0::2], arguments[1::2]):
        image = bpy.data.images.load(source)
        width, height = image.size
        pixels = numpy.empty(width * height * 4, dtype=numpy.float32)
        image.pixels.foreach_get(pixels)
        numpy.save(target, pixels.reshape(height, width, 4)[::-1].copy())
        print(f"EXR_TO_NPY {source} {width}x{height}")


main()
