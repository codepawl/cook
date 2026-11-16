#!/usr/bin/env bash
# Renders the dispersion short's prism scene with caustic light tracing at several sample and photon counts, one still each, and
# prints the wall seconds of every run (codepawl/crucible#1715). Run from the repository root.
#   bash tools/caustic-sweep.sh <output-directory> <width> <height> <samples:photons> [<samples:photons> ...]
# Set RUN_PREFIX to a command that wraps each render (a GPU queue, for example).
set -euo pipefail
output_directory="${1:?output directory}"
width="${2:?width}"
height="${3:?height}"
shift 3
mkdir -p "$output_directory"
for configuration in "$@"; do
  samples="${configuration%%:*}"
  photons="${configuration##*:}"
  ${RUN_PREFIX:-} node tools/caustic-render.mjs \
    "$output_directory/${width}x${height}-s${samples}-p${photons}" --storyboard --light-tracing \
    --width "$width" --height "$height" --samples "$samples" --photons "$photons"
done
