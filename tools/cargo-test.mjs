// Runs the Rust tests of the addon crate. The crate is a Node addon, so its napi symbols are only resolved when Node loads
// the library; a test binary on Linux must therefore link with them left unresolved, which these flags allow.
//   node tools/cargo-test.mjs [extra cargo test arguments]
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
const LINUX_TEST_LINK_FLAGS = '-C relro-level=partial -C link-arg=-Wl,--unresolved-symbols=ignore-all -C link-arg=-Wl,-z,lazy';

const environment = { ...process.env };
if (process.platform === 'linux') {
  environment.RUSTFLAGS = [process.env.RUSTFLAGS, LINUX_TEST_LINK_FLAGS].filter(Boolean).join(' ');
}
const targetArguments = process.platform === 'win32' ? ['--target', 'x86_64-pc-windows-msvc'] : [];
const run = spawnSync('cargo', ['test', '--locked', ...targetArguments, ...process.argv.slice(2)], {
  cwd: repositoryDirectory,
  env: environment,
  stdio: 'inherit',
});
process.exit(run.status ?? 1);
