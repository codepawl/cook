"""Renders a dispersion scene with Blender Cycles (codepawl/crucible#1714), from the JSON that tools/dispersion-parity.mjs writes.

    blender -b --factory-startup --python tools/dispersion-parity-cycles.py -- <scene.json> <output-prefix> --samples N

Writes <prefix>.cycles.npy (linear RGBA float32, rows from the top, like Cook's .npy) and <prefix>.cycles.json (the Principled BSDF
sockets found, seconds, device). The Principled BSDF `Dispersion` socket of Blender 5.3 takes the material's `dispersion` as given:
both engines read it as 20 divided by the Abbe number.
"""
import json
import math
import sys
import time

import bpy
import mathutils
import numpy


def parse_arguments():
    arguments = sys.argv[sys.argv.index("--") + 1:]
    scene_path, prefix = arguments[0], arguments[1]
    samples = int(arguments[arguments.index("--samples") + 1]) if "--samples" in arguments else 64
    return scene_path, prefix, samples


def y_up_to_z_up(vector):
    return (vector[0], -vector[2], vector[1])


def matrix_of(column_major):
    """Cook matrices are column major in a y-up world; Blender is z-up."""
    columns = [column_major[0:4], column_major[4:8], column_major[8:12], column_major[12:16]]
    rows = [[columns[column][row] for column in range(4)] for row in range(4)]
    y_up = mathutils.Matrix(rows)
    conversion = mathutils.Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
    return conversion @ y_up @ conversion.inverted()


def build_material(name, fields, report):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    principled = next(node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED")
    inputs = principled.inputs
    color = fields.get("color", [0.8, 0.8, 0.8])
    inputs["Base Color"].default_value = (color[0], color[1], color[2], 1.0)
    inputs["Roughness"].default_value = fields.get("roughness", 0.5)
    if "ior" in fields:
        inputs["IOR"].default_value = fields["ior"]
    if "transmission" in fields:
        inputs["Transmission Weight"].default_value = fields["transmission"]
    if "emission" in fields:
        inputs["Emission Color"].default_value = (color[0], color[1], color[2], 1.0)
        inputs["Emission Strength"].default_value = fields["emission"]
    if "dispersion" in fields:
        names = [socket.name for socket in inputs if "ispersion" in socket.name]
        report["dispersionSockets"] = names
        if not names:
            raise RuntimeError("This Blender has no Dispersion socket on the Principled BSDF: " + bpy.app.version_string)
        inputs[names[0]].default_value = fields["dispersion"]
    return material


def build_object(spec, report):
    positions = spec["geometry"]["positions"]
    vertices = [y_up_to_z_up(positions[index:index + 3]) for index in range(0, len(positions), 3)]
    indices = spec["geometry"]["indices"]
    triangles = [tuple(indices[index:index + 3]) for index in range(0, len(indices), 3)]
    mesh = bpy.data.meshes.new(spec["name"])
    mesh.from_pydata(vertices, [], triangles)
    mesh.update()
    smooth = spec["name"].startswith("light") or spec["name"] == "sun"
    for polygon in mesh.polygons:
        polygon.use_smooth = smooth
    mesh_object = bpy.data.objects.new(spec["name"], mesh)
    mesh_object.matrix_world = matrix_of(spec["matrix"])
    mesh.materials.append(build_material(spec["name"], spec["material"], report))
    bpy.context.scene.collection.objects.link(mesh_object)


def build_camera(camera, width, height):
    data = bpy.data.cameras.new("camera")
    data.sensor_fit = "VERTICAL"
    data.angle = math.radians(camera["fieldOfViewDegrees"])
    data.clip_start = 0.01
    data.clip_end = 1000.0
    eye = numpy.array(y_up_to_z_up(camera["eye"]))
    target = numpy.array(y_up_to_z_up(camera["target"]))
    forward = target - eye
    forward = forward / numpy.linalg.norm(forward)
    right = numpy.cross(forward, [0.0, 0.0, 1.0])
    right = right / numpy.linalg.norm(right)
    up = numpy.cross(right, forward)
    rotation = mathutils.Matrix(((right[0], up[0], -forward[0]), (right[1], up[1], -forward[1]), (right[2], up[2], -forward[2])))
    camera_object = bpy.data.objects.new("camera", data)
    camera_object.matrix_world = mathutils.Matrix.Translation(eye.tolist()) @ rotation.to_4x4()
    bpy.context.scene.collection.objects.link(camera_object)
    bpy.context.scene.camera = camera_object


def main():
    scene_path, prefix, samples = parse_arguments()
    with open(scene_path, encoding="utf-8") as handle:
        description = json.load(handle)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    report = {"blender": bpy.app.version_string}
    for spec in description["objects"]:
        build_object(spec, report)
    build_camera(description["camera"], description["width"], description["height"])
    world = bpy.data.worlds.new("world")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.0, 0.0, 0.0, 1.0)
    scene.world = world

    scene.render.engine = "CYCLES"
    scene.render.resolution_x = description["width"]
    scene.render.resolution_y = description["height"]
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    cycles = scene.cycles
    cycles.samples = samples
    cycles.seed = description.get("seed", 1)
    cycles.use_denoising = False
    cycles.use_adaptive_sampling = False
    cycles.max_bounces = description["bounces"]
    cycles.transparent_max_bounces = description["bounces"]
    cycles.transmission_bounces = description["bounces"]
    cycles.glossy_bounces = description["bounces"]
    cycles.diffuse_bounces = description["bounces"]
    cycles.sample_clamp_direct = 0.0
    cycles.sample_clamp_indirect = 0.0
    cycles.caustics_reflective = True
    cycles.caustics_refractive = True
    cycles.blur_glossy = 0.0
    try:
        cycles.device = "GPU"
        preferences = bpy.context.preferences.addons["cycles"].preferences
        preferences.compute_device_type = "OPTIX"
        preferences.get_devices()
        for device in preferences.devices:
            device.use = device.type == "OPTIX"
        report["devices"] = [device.name for device in preferences.devices if device.use]
    except Exception as error:  # noqa: BLE001 - the render still runs on the CPU
        report["deviceError"] = str(error)
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.render.image_settings.file_format = "OPEN_EXR"
    scene.render.image_settings.color_depth = "32"
    exr_path = prefix + ".cycles.exr"
    scene.render.filepath = exr_path

    started = time.time()
    bpy.ops.render.render(write_still=True)
    report["seconds"] = time.time() - started
    report["samples"] = samples

    image = bpy.data.images.load(exr_path)
    image.colorspace_settings.name = "Non-Color"
    width, height = image.size
    pixels = numpy.empty(width * height * 4, dtype=numpy.float32)
    image.pixels.foreach_get(pixels)
    rows = pixels.reshape(height, width, 4)[::-1]
    numpy.save(prefix + ".cycles.npy", numpy.ascontiguousarray(rows))
    with open(prefix + ".cycles.json", "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=1)
    print("CYCLES", json.dumps(report))


main()
