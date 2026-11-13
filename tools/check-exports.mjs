// Fails when a target of the `exports` map or of `bin` is missing from the npm package (`npm pack --dry-run --json`).
// Usage: node tools/check-exports.mjs   (run from the package directory)
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const packOutput = execSync('npm pack --dry-run --json --ignore-scripts', { encoding: 'utf8' });
// Newer npm versions key the report by package name, older ones return an array.
const packReport = JSON.parse(packOutput);
const packedPackage = Array.isArray(packReport) ? packReport[0] : Object.values(packReport)[0];
const packedPaths = new Set(packedPackage.files.map((file) => file.path));

function collectTargets(value, targets) {
  if (typeof value === 'string') targets.push(value);
  else if (value !== null && typeof value === 'object') Object.values(value).forEach((nested) => collectTargets(nested, targets));
}

const targets = [];
collectTargets(packageJson.exports, targets);
collectTargets(packageJson.bin, targets);

const missing = [];
for (const target of targets) {
  const relativePath = target.replace(/^\.\//, '');
  if (relativePath.includes('*')) {
    const prefix = relativePath.slice(0, relativePath.indexOf('*'));
    if (![...packedPaths].some((packedPath) => packedPath.startsWith(prefix))) missing.push(target);
  } else if (!packedPaths.has(relativePath)) {
    missing.push(target);
  }
}

if (missing.length > 0) {
  console.error(`These exports or bin targets are not in the npm package: ${missing.join(', ')}. Add them to "files" in package.json.`);
  process.exit(1);
}
console.log(`ok: ${targets.length} export and bin targets are in the package (${packedPaths.size} files).`);
