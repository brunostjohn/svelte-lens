import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(
  await readFile(new URL('../packages/vite-plugin/package.json', import.meta.url), 'utf8')
);
const extensionPackageJson = JSON.parse(
  await readFile(new URL('../apps/extension/package.json', import.meta.url), 'utf8')
);
const extensionManifest = JSON.parse(
  await readFile(new URL('../apps/extension/src/manifest.json', import.meta.url), 'utf8')
);

const expectedName = 'svelte-lens-vite';
const releaseTag = process.argv[2] ?? '';

if (packageJson.name !== expectedName) {
  throw new Error(`Expected package name ${expectedName}, received ${String(packageJson.name)}`);
}

if (typeof packageJson.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version)) {
  throw new Error(`Invalid package version: ${String(packageJson.version)}`);
}

for (const [label, version] of [
  ['extension package', extensionPackageJson.version],
  ['extension manifest', extensionManifest.version]
]) {
  if (version !== packageJson.version) {
    throw new Error(`${label} version ${String(version)} does not match npm package ${packageJson.version}`);
  }
}

if (releaseTag && releaseTag !== `v${packageJson.version}`) {
  throw new Error(`Release tag ${releaseTag} does not match package version v${packageJson.version}`);
}

process.stdout.write(`name=${packageJson.name}\nversion=${packageJson.version}\n`);
