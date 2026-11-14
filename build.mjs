// Builds the native addon with cargo and copies it to build/render-native.node.
// Windows must target MSVC: the default GNU toolchain crashes any wgpu 30 program before main.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const libraryName = { win32: 'render_native.dll', darwin: 'librender_native.dylib', linux: 'librender_native.so' }[process.platform];
if (libraryName === undefined) {
  console.error(`Unsupported platform ${process.platform}: Cook builds the addon on win32, darwin and linux.`);
  process.exit(1);
}

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const targetArguments = process.platform === 'win32' ? ['--target', 'x86_64-pc-windows-msvc'] : [];
const targetDirectory = process.env.CARGO_TARGET_DIR
  ? resolve(packageDirectory, process.env.CARGO_TARGET_DIR)
  : join(packageDirectory, 'target');
const releaseDirectory = join(targetDirectory, ...(targetArguments.length > 0 ? [targetArguments[1]] : []), 'release');
const worktreeStampPath = join(releaseDirectory, '.render-native-package-dir');

function exitWhenCargoCannotStart(result) {
  if (result.error === undefined) return;
  console.error(
    `Could not run cargo (${result.error.message}). Install Rust from https://rustup.rs, or run cook fetch-addon for a prebuilt addon.`,
  );
  process.exit(1);
}

if (process.env.CARGO_TARGET_DIR) {
  const previousPackageDirectory = existsSync(worktreeStampPath) ? readFileSync(worktreeStampPath, 'utf8').trim() : '';
  if (previousPackageDirectory !== packageDirectory) {
    const clean = spawnSync('cargo', ['clean', '-p', 'render-native', '--release', ...targetArguments], {
      cwd: packageDirectory,
      stdio: 'inherit',
    });
    exitWhenCargoCannotStart(clean);
  }
}

const build = spawnSync('cargo', ['build', '--release', ...targetArguments], { cwd: packageDirectory, stdio: 'inherit' });
exitWhenCargoCannotStart(build);
if (build.status !== 0) process.exit(build.status ?? 1);
if (process.env.CARGO_TARGET_DIR) {
  writeFileSync(worktreeStampPath, `${packageDirectory}\n`);
}
mkdirSync(join(packageDirectory, 'build'), { recursive: true });
copyFileSync(join(releaseDirectory, libraryName), join(packageDirectory, 'build', 'render-native.node'));
console.log('Built build/render-native.node');
