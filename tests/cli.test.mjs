import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIRECTORY = fileURLToPath(new URL('..', import.meta.url));
const CLI_PATH = join(PACKAGE_DIRECTORY, 'bin', 'cook.mjs');
const FIXTURE_PATH = join(PACKAGE_DIRECTORY, 'fixtures', 'room.cookpack');
const WORK_DIRECTORY = mkdtempSync(join(tmpdir(), 'cook-cli-test-'));
// Points the addon at a path that does not exist, so no test here depends on whether this machine built the addon.
const MISSING_ADDON_ENVIRONMENT = { ...process.env, COOK_ADDON_PATH: join(WORK_DIRECTORY, 'no-such-addon.node') };

after(() => rmSync(WORK_DIRECTORY, { recursive: true, force: true }));

function cook(args) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], { encoding: 'utf8', env: MISSING_ADDON_ENVIRONMENT });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function outputPath(name) {
  return join(WORK_DIRECTORY, name);
}

test('--help prints the usage and the exit codes, --version prints the package version', () => {
  const help = cook(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /cook render <scene\.cookpack> --output/);
  assert.match(help.stdout, /Exit codes: 0 done/);
  const version = cook(['--version']);
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), JSON.parse(readFileSync(join(PACKAGE_DIRECTORY, 'package.json'), 'utf8')).version);
});

test('info describes the fixture without an addon', () => {
  const result = cook(['info', FIXTURE_PATH]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /file: room\.cookpack/);
  assert.match(result.stdout, /pack revision: 1 \(this Cook reads 1 to 1\)/);
  assert.match(result.stdout, /image: 160 x 120, 64 samples/);
  assert.match(result.stdout, /triangleCount: 86/);
  assert.match(result.stdout, /textureTexels {2}u32 {2}offset \d+ {2}\d+ bytes/);
});

test('info exits 3 for a missing file and for a file that is not a pack', () => {
  const missing = cook(['info', outputPath('missing.cookpack')]);
  assert.equal(missing.status, 3);
  assert.match(missing.stderr, /^cook: cannot read/);
  const garbagePath = outputPath('garbage.cookpack');
  writeFileSync(garbagePath, 'this is not a pack file at all');
  const garbage = cook(['info', garbagePath]);
  assert.equal(garbage.status, 3);
  assert.match(garbage.stderr, /not a Cook pack file/);
});

test('argument errors exit 2 with a message that says what to pass, and write nothing', () => {
  const picture = outputPath('never.png');
  const cases = [
    [[], /missing command/],
    [['paint', FIXTURE_PATH], /unknown command "paint"/],
    [['render'], /render takes one scene file/],
    [['render', FIXTURE_PATH], /render needs --output/],
    [['render', FIXTURE_PATH, '--output', outputPath('never.jpg')], /must end in \.png or \.npy/],
    [['render', FIXTURE_PATH, '--output', picture, '--width', 'wide'], /--width must be a whole number/],
    [['render', FIXTURE_PATH, '--output', picture, '--samples', '0'], /--samples must be a whole number of at least 1/],
    [['render', FIXTURE_PATH, '--output', picture, '--max-seconds', '0'], /--max-seconds must be a number greater than 0/],
    [['render', FIXTURE_PATH, '--output', picture, '--denoise', 'wavelet'], /--denoise must be one of none, atrous/],
    [['render', FIXTURE_PATH, '--output', picture, '--bounces', '4'], /bounces/],
    [['render', FIXTURE_PATH, FIXTURE_PATH, '--output', picture], /render takes one scene file/],
    [['render', FIXTURE_PATH, '--output', picture, '--width', '200', '--height', '100'], /another aspect ratio than the packed 160 x 120/],
    [['render', FIXTURE_PATH, '--output', picture, '--width', '99999'], /width/],
    [['render', FIXTURE_PATH, '--output', picture, '--dispatch-samples', '70000'], /samplesPerDispatch/],
  ];
  for (const [args, pattern] of cases) {
    const result = cook(args);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, pattern, args.join(' '));
    assert.equal(result.stdout, '');
  }
  assert.equal(existsSync(picture), false);
});

test('a size at the packed aspect ratio gets past the argument checks and stops at the missing addon', () => {
  for (const sizeArguments of [['--width', '80'], ['--height', '60'], ['--width', '320', '--height', '240']]) {
    const result = cook(['render', FIXTURE_PATH, '--output', outputPath('never.png'), ...sizeArguments]);
    assert.equal(result.status, 5, `${sizeArguments.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, /COOK_ADDON_PATH is set to .* which does not exist/);
  }
  assert.equal(existsSync(outputPath('never.png')), false);
});

test('render refuses a pack of a newer revision before it looks for the addon, and info still reads it', () => {
  const newerPath = outputPath('newer.cookpack');
  const original = readFileSync(FIXTURE_PATH);
  const patched = Buffer.from(original.toString('latin1').replace('"packRevision":1', '"packRevision":2'), 'latin1');
  assert.equal(patched.length, original.length);
  writeFileSync(newerPath, patched);
  const render = cook(['render', newerPath, '--output', outputPath('never.png')]);
  assert.equal(render.status, 3);
  assert.match(render.stderr, /pack revision 2, but this Cook .* reads revisions 1 to 1\. Update Cook \(error COOK_PACK_REVISION\)/);
  const info = cook(['info', newerPath]);
  assert.equal(info.status, 0);
  assert.match(info.stdout, /pack revision: 2 \(this Cook reads 1 to 1: NOT readable\)/);
});
