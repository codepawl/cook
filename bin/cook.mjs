#!/usr/bin/env node
// The Cook command line: render a pack file to a picture, or describe one. Loads only this package and Node built-ins.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname } from 'node:path';
import { parseArgs } from 'node:util';

import { describeEngine, isTimeLimitError } from '../engine.mjs';
import { COOK_PACK_REVISION_CODE, loadNativeAddon, traceNative } from '../index.mjs';
import { PackFileError, decodePackFile, describePackFile } from '../pack-file.mjs';
import { validatePackOptions } from '../pack-input-v2.mjs';
import { fetchPrebuiltAddon } from '../fetch-addon.mjs';
import { encodeNpy } from '../output/npy.mjs';
import { encodePng } from '../output/png.mjs';
import { toneMapToRgba8 } from '../output/tone-map.mjs';

// Exit codes a script can rely on.
const EXIT_OK = 0;
const EXIT_RENDER_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_BAD_PACK = 3;
const EXIT_TIME_LIMIT = 4;
const EXIT_NO_ADDON = 5;

const DENOISERS = ['none', 'atrous'];

const HELP_TEXT = `Usage:
  cook render <scene.cookpack> --output <file.png|file.npy> [options]
  cook info <scene.cookpack>
  cook fetch-addon
  cook --help | --version

render options:
  --output <file>          where to write: .png (8-bit, ACES curve and gamma 2.2) or .npy (linear float32 RGBA, shape height x width x 4)
  --width <n>, --height <n>  image size; the packed aspect ratio is kept, so give one of them or both at that ratio
  --samples <n>            samples per pixel (default: the number stored in the pack)
  --max-seconds <s>        stop with exit code 4 and write nothing once the trace has run this long
  --denoise none|atrous    none (default) or the a-trous filter (smoothed, biased)
  --dispatch-samples <n>   samples drawn per GPU dispatch (default: chosen automatically)

fetch-addon downloads the prebuilt native addon of this version (Windows x64 and Linux x64) and checks its SHA-256,
so rendering needs no Rust. Elsewhere, build it with npm run build.

The scene is always rendered with the cycles kernel. The seed, camera and bounce limits are stored in the pack.
Environment: COOK_ADDON_PATH names a built render-native.node elsewhere.

Exit codes: 0 done, 1 the render failed, 2 wrong arguments, 3 the pack file is unreadable, damaged or of a revision this
Cook does not read, 4 the time limit passed, 5 the native addon is not built, cannot be loaded or cannot be downloaded (cook fetch-addon, or npm run build).
A render that fails on the card (for example no Vulkan adapter with ray queries) exits 1 with the addon's message.
`;

class UsageError extends Error {}

class CliFailure extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

function parseWholeNumber(text, optionName) {
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new UsageError(`${optionName} must be a whole number of at least 1; got ${JSON.stringify(text)}.`);
  }
  return Number(text);
}

function parseSeconds(text) {
  const seconds = Number(text);
  if (text.trim() === '' || !Number.isFinite(seconds) || seconds <= 0) {
    throw new UsageError(`--max-seconds must be a number greater than 0; got ${JSON.stringify(text)}.`);
  }
  return seconds;
}

// A wrong folder is found before the trace, not after minutes of rendering.
function requireWritableOutputFolder(outputPath) {
  const folder = dirname(outputPath);
  let isFolder = false;
  try {
    isFolder = statSync(folder).isDirectory();
  } catch {
    isFolder = false;
  }
  if (!isFolder) {
    throw new UsageError(`--output ${JSON.stringify(outputPath)}: the folder ${JSON.stringify(folder)} does not exist. Create it or give another path.`);
  }
}

function parseRenderOptions(values) {
  const outputExtension = values.output === undefined ? '' : extname(values.output).toLowerCase();
  if (values.output === undefined) {
    throw new UsageError('render needs --output <file.png|file.npy>.');
  }
  if (outputExtension !== '.png' && outputExtension !== '.npy') {
    throw new UsageError(`--output must end in .png or .npy; got ${JSON.stringify(basename(values.output))}.`);
  }
  requireWritableOutputFolder(values.output);
  const denoise = values.denoise ?? 'none';
  if (!DENOISERS.includes(denoise)) {
    throw new UsageError(`--denoise must be one of ${DENOISERS.join(', ')}; got ${JSON.stringify(denoise)}.`);
  }
  return {
    outputPath: values.output,
    outputFormat: outputExtension.slice(1),
    width: values.width === undefined ? undefined : parseWholeNumber(values.width, '--width'),
    height: values.height === undefined ? undefined : parseWholeNumber(values.height, '--height'),
    samples: values.samples === undefined ? undefined : parseWholeNumber(values.samples, '--samples'),
    maxSeconds: values['max-seconds'] === undefined ? undefined : parseSeconds(values['max-seconds']),
    samplesPerDispatch: values['dispatch-samples'] === undefined ? undefined : parseWholeNumber(values['dispatch-samples'], '--dispatch-samples'),
    denoise,
  };
}

// The camera in a pack has the aspect ratio of the packed size, so another size is accepted only at that ratio. With one
// side given, the other follows from the ratio.
function resolveImageSize(requestedWidth, requestedHeight, packedImage) {
  const { width: packedWidth, height: packedHeight } = packedImage;
  if (requestedWidth === undefined && requestedHeight === undefined) {
    return { width: packedWidth, height: packedHeight };
  }
  const widthFromHeight = requestedHeight === undefined ? undefined : Math.round((requestedHeight * packedWidth) / packedHeight);
  const heightFromWidth = requestedWidth === undefined ? undefined : Math.round((requestedWidth * packedHeight) / packedWidth);
  const width = requestedWidth ?? widthFromHeight;
  const height = requestedHeight ?? heightFromWidth;
  const keepsAspect = requestedWidth === undefined || requestedHeight === undefined
    || requestedWidth * packedHeight === requestedHeight * packedWidth;
  if (!keepsAspect) {
    throw new UsageError(
      `${requestedWidth} x ${requestedHeight} has another aspect ratio than the packed ${packedWidth} x ${packedHeight}, and the camera in the pack is fixed to it. Give one of --width or --height, or a size at the ratio ${packedWidth}:${packedHeight} (for example ${packedWidth * 2} x ${packedHeight * 2}).`
    );
  }
  return { width, height };
}

function readPackFile(path) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (readError) {
    throw new CliFailure(`cannot read ${JSON.stringify(path)}: ${readError.message}`, EXIT_BAD_PACK);
  }
  try {
    return { bytes, description: describePackFile(bytes) };
  } catch (packError) {
    if (packError instanceof PackFileError) throw new CliFailure(`${path}: ${packError.message}`, EXIT_BAD_PACK);
    throw packError;
  }
}

function decodePackFileForCli(bytes, path) {
  try {
    return decodePackFile(bytes);
  } catch (packError) {
    if (packError instanceof PackFileError) throw new CliFailure(`${path}: ${packError.message}`, EXIT_BAD_PACK);
    throw packError;
  }
}

function requireReadablePackRevision(description, path) {
  const [oldestRevision, newestRevision] = describeEngine().packFormat.readsRevisions;
  if (description.packRevision < oldestRevision || description.packRevision > newestRevision) {
    const failure = new CliFailure(
      `${path} has pack revision ${description.packRevision}, but this Cook (${describeEngine().version}) reads revisions ${oldestRevision} to ${newestRevision}. ${description.packRevision > newestRevision ? 'Update Cook' : 'Pack the scene again'} (error ${COOK_PACK_REVISION_CODE}).`,
      EXIT_BAD_PACK
    );
    failure.code = COOK_PACK_REVISION_CODE;
    throw failure;
  }
}

// Loads the addon now, so a missing, wrong-platform or damaged addon exits 5 before any work and not 1 after it.
function requireAddon() {
  try {
    loadNativeAddon();
  } catch (loadError) {
    throw new CliFailure(loadError.message, EXIT_NO_ADDON);
  }
}

function writePicture(options, pixels, width, height) {
  const bytes = options.outputFormat === 'png'
    ? encodePng(toneMapToRgba8(pixels, width, height), width, height)
    : encodeNpy(pixels, width, height);
  try {
    writeFileSync(options.outputPath, bytes);
  } catch (writeError) {
    throw new CliFailure(`cannot write ${JSON.stringify(options.outputPath)}: ${writeError.message}`, EXIT_RENDER_FAILED);
  }
}

function runRender(positionals, values) {
  if (positionals.length !== 1) {
    throw new UsageError('render takes one scene file: cook render <scene.cookpack> --output <file.png|file.npy>.');
  }
  const scenePath = positionals[0];
  const options = parseRenderOptions(values);
  const { bytes, description } = readPackFile(scenePath);
  requireReadablePackRevision(description, scenePath);
  const { width, height } = resolveImageSize(options.width, options.height, description.image);
  const traceOptions = {
    kernel: 'cycles',
    width,
    height,
    samples: options.samples ?? description.image.samples,
    samplesPerDispatch: options.samplesPerDispatch,
    maxSeconds: options.maxSeconds,
    denoise: options.denoise,
  };
  try {
    validatePackOptions(traceOptions, 'cook render', true);
  } catch (rangeError) {
    throw new UsageError(rangeError.message);
  }
  const input = decodePackFileForCli(bytes, scenePath);
  requireAddon();

  let result;
  try {
    result = traceNative(input, traceOptions);
  } catch (traceError) {
    if (isTimeLimitError(traceError)) {
      throw new CliFailure(`the trace passed its time limit of ${options.maxSeconds} s; nothing was written. Raise --max-seconds or lower --samples.`, EXIT_TIME_LIMIT);
    }
    throw new CliFailure(`the render failed: ${traceError.message}`, EXIT_RENDER_FAILED);
  }
  writePicture(options, result.denoisedRgba ?? result.rgba, width, height);
  console.log(`rendered ${width} x ${height}, ${traceOptions.samples} samples in ${result.tracedSeconds.toFixed(2)} s on ${result.adapter}; wrote ${options.outputPath}`);
}

function runInfo(positionals) {
  if (positionals.length !== 1) {
    throw new UsageError('info takes one scene file: cook info <scene.cookpack>.');
  }
  const { description } = readPackFile(positionals[0]);
  const [oldestRevision, newestRevision] = describeEngine().packFormat.readsRevisions;
  const readable = description.packRevision >= oldestRevision && description.packRevision <= newestRevision;
  const lines = [
    `file: ${basename(positionals[0])} (${description.byteLength} bytes)`,
    `container version: ${description.containerVersion}`,
    `input schema: FORMAT-v${description.schemaVersion}`,
    `pack revision: ${description.packRevision} (this Cook reads ${oldestRevision} to ${newestRevision}${readable ? '' : ': NOT readable'})`,
    `image: ${description.image.width} x ${description.image.height}, ${description.image.samples} samples`,
    'counts:',
    ...Object.entries(description.counts).map(([name, count]) => `  ${name}: ${count === null ? 'none (no emitter tables)' : count}`),
    'tables:',
    ...description.directory.map((entry) => `  ${entry.name}  ${entry.elementType}  offset ${entry.byteOffset}  ${entry.byteLength} bytes`),
  ];
  if (description.extra !== undefined) {
    lines.push(`extra: ${JSON.stringify(description.extra)}`);
  }
  console.log(lines.join('\n'));
}

function parseCommandLine(argv) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        output: { type: 'string', short: 'o' },
        width: { type: 'string' },
        height: { type: 'string' },
        samples: { type: 'string' },
        'max-seconds': { type: 'string' },
        denoise: { type: 'string' },
        'dispatch-samples': { type: 'string' },
      },
    });
  } catch (parseError) {
    throw new UsageError(parseError.message);
  }
}

function run(argv) {
  const { values, positionals } = parseCommandLine(argv);
  if (values.help) {
    console.log(HELP_TEXT);
    return;
  }
  if (values.version) {
    console.log(describeEngine().version);
    return;
  }
  const [command, ...rest] = positionals;
  if (command === 'render') return runRender(rest, values);
  if (command === 'info') return runInfo(rest);
  if (command === 'fetch-addon') return runFetchAddon(rest);
  if (command === undefined) throw new UsageError('missing command. Run `cook --help`.');
  throw new UsageError(`unknown command ${JSON.stringify(command)}; use render, info or fetch-addon. Run \`cook --help\`.`);
}

async function runFetchAddon(rest) {
  if (rest.length > 0) {
    throw new UsageError('fetch-addon takes no arguments.');
  }
  let addonPath;
  try {
    addonPath = await fetchPrebuiltAddon();
  } catch (error) {
    throw new CliFailure(error.message, EXIT_NO_ADDON);
  }
  console.log(`Downloaded the prebuilt addon to ${addonPath}`);
}

try {
  await run(process.argv.slice(2));
  process.exitCode = EXIT_OK;
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`cook: ${error.message}`);
    process.exitCode = EXIT_USAGE;
  } else if (error instanceof CliFailure) {
    console.error(`cook: ${error.message}`);
    process.exitCode = error.exitCode;
  } else {
    console.error(`cook: unexpected error: ${error?.stack ?? error}`);
    process.exitCode = EXIT_RENDER_FAILED;
  }
}
