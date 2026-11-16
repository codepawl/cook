#!/usr/bin/env bash
# Compares the caustic of the prism-floor scene from two estimators of the same light (codepawl/crucible#1715):
#   reference  camera paths only, a sun of radius 0.3 (large enough that a path from the floor through the prism finds it)
#   traced     caustic light tracing on the same scene
# for dispersion 0 and 1, and prints each box mean and the ratio traced / reference. Run from the repository root.
#   bash tools/caustic-reference.sh <output-directory> [reference-samples] [traced-samples] [photons]
set -euo pipefail
output_directory="${1:?output directory}"
reference_samples="${2:-512}"
traced_samples="${3:-128}"
photons="${4:-4}"
box="60,55,110,85"
common=(--width 240 --height 135 --sun-radius 0.3 --box "$box")
mkdir -p "$output_directory"
for dispersion in 0 1; do
  GPU_LOCK_WEIGHT=heavy bash ~/.agents/tools/gpu-lock.sh node tools/caustic-render.mjs "$output_directory/reference-d$dispersion" \
    "${common[@]}" --dispersion "$dispersion" --samples "$reference_samples"
  GPU_LOCK_WEIGHT=heavy bash ~/.agents/tools/gpu-lock.sh node tools/caustic-render.mjs "$output_directory/traced-d$dispersion" \
    "${common[@]}" --dispersion "$dispersion" --samples "$traced_samples" --light-tracing --photons "$photons"
done
node -e '
const fs = require("node:fs");
const directory = process.argv[1];
for (const dispersion of [0, 1]) {
  const reference = JSON.parse(fs.readFileSync(`${directory}/reference-d${dispersion}.json`, "utf8")).boxMean;
  const traced = JSON.parse(fs.readFileSync(`${directory}/traced-d${dispersion}.json`, "utf8")).boxMean;
  const ratios = traced.map((value, channel) => (value / reference[channel]).toFixed(3));
  console.log(`dispersion ${dispersion}: reference ${reference.map(v => v.toFixed(4))} traced ${traced.map(v => v.toFixed(4))} ratio ${ratios}`);
}
' "$output_directory"
