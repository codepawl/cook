// Downloads the prebuilt native addon of this package version from the GitHub release `v<version>` and writes it to
// build/render-native.node, so a machine can render without Rust. The release workflow (.github/workflows/release.yml)
// builds one addon per supported system and a `.sha256` file next to each; the download is refused when the hash differs.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const RELEASE_BASE_URL = 'https://github.com/codepawl/cook/releases/download';
const DOWNLOAD_TIMEOUT_MILLISECONDS = 120000;

/** The systems the release workflow builds an addon for, as `process.platform-process.arch`. */
export const PREBUILT_SYSTEMS = Object.freeze(['win32-x64', 'linux-x64']);

/** The release asset name of the addon for one system, or null when no prebuilt addon exists for it. */
export function prebuiltAssetName(platform, arch) {
  const system = `${platform}-${arch}`;
  if (!PREBUILT_SYSTEMS.includes(system)) {
    return null;
  }
  return `render-native-${system}.node`;
}

/** The download URL of one release asset for a package version. */
export function prebuiltAssetUrl(version, assetName) {
  return `${RELEASE_BASE_URL}/v${version}/${assetName}`;
}

/** Reads the hash from a `sha256sum` style line ("<64 hex digits>  <file name>"). */
export function parseSha256File(text) {
  const match = /^([0-9a-f]{64})\b/i.exec(String(text).trim());
  if (match === null) {
    throw new Error('The .sha256 file of the release asset does not start with a SHA-256 hash.');
  }
  return match[1].toLowerCase();
}

/** Throws when the bytes do not have the expected SHA-256 hash. */
export function verifySha256(bytes, expectedHash, assetName) {
  const actualHash = createHash('sha256').update(bytes).digest('hex');
  if (actualHash !== expectedHash) {
    throw new Error(
      `The downloaded ${assetName} has SHA-256 ${actualHash}, but the release lists ${expectedHash}. Nothing was written. Download again, or build from source with npm run build.`
    );
  }
}

export async function download(url, fetchImplementation = fetch) {
  let response;
  try {
    response = await fetchImplementation(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MILLISECONDS) });
  } catch (error) {
    throw new Error(`Could not download ${url}: ${error.message}. Check the network, or build from source with npm run build.`);
  }
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Downloading ${url} failed with HTTP ${response.status}. Try again later, or build from source with npm run build.`);
  }
  try {
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new Error(`Could not download ${url}: ${error.message}. Check the network, or build from source with npm run build.`);
  }
}

/** Writes the bytes next to the target and renames them over it; removes the partial file and names the fix on failure. */
export function writeAddonAtomically(partialPath, addonPath, addonBytes) {
  try {
    writeFileSync(partialPath, addonBytes);
    renameSync(partialPath, addonPath);
  } catch (error) {
    rmSync(partialPath, { force: true });
    throw new Error(
      `Could not write ${addonPath}: ${error.message}. Close other cook processes using build/render-native.node, or make build/ writable.`
    );
  }
}

function packageVersion() {
  return JSON.parse(readFileSync(join(PACKAGE_DIRECTORY, 'package.json'), 'utf8')).version;
}

/**
 * Downloads and checks the prebuilt addon, then writes build/render-native.node. Returns the written path. Throws an error
 * that names the fix when this system has no prebuilt addon or the release does not exist.
 */
export async function fetchPrebuiltAddon({ platform = process.platform, arch = process.arch, version = packageVersion() } = {}) {
  const assetName = prebuiltAssetName(platform, arch);
  if (assetName === null) {
    throw new Error(
      `No prebuilt addon exists for ${platform}-${arch}; prebuilt addons cover ${PREBUILT_SYSTEMS.join(' and ')}. Build from source with npm run build (needs Rust).`
    );
  }
  const addonUrl = prebuiltAssetUrl(version, assetName);
  const hashBytes = await download(`${addonUrl}.sha256`);
  const addonBytes = hashBytes === null ? null : await download(addonUrl);
  if (hashBytes === null || addonBytes === null) {
    throw new Error(
      `The release v${version} has no ${assetName}. Install a released version (npm install github:codepawl/cook#v${version} names one), or build from source with npm run build.`
    );
  }
  verifySha256(addonBytes, parseSha256File(hashBytes.toString('utf8')), assetName);
  const buildDirectory = join(PACKAGE_DIRECTORY, 'build');
  mkdirSync(buildDirectory, { recursive: true });
  const addonPath = join(buildDirectory, 'render-native.node');
  const partialPath = `${addonPath}.partial`;
  writeAddonAtomically(partialPath, addonPath, addonBytes);
  return addonPath;
}
