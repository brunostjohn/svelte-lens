# Releasing Svelte Lens

The release workflow is `.github/workflows/release.yml`.

- A manual dispatch validates the repository and uploads the npm tarball plus Chrome extension ZIP without publishing.
- A `v*` tag runs the same validation and publishes the npm tarball through npm trusted publishing.
- The npm package, extension workspace package, Chrome manifest, and tag must all carry the same version.
- Only the publish job receives GitHub's `id-token: write` permission. No reusable npm token is stored in the repository or GitHub Actions.

## Release

1. Update the version in:
   - `package.json`
   - `packages/vite-plugin/package.json`
   - `apps/extension/package.json`
   - `apps/extension/src/manifest.json`
   - `examples/playground/package.json`
2. Run `pnpm install` so the lockfile records the package versions.
3. Run `pnpm test`, `pnpm check`, and `pnpm build`.
4. Commit the release and push `main`.
5. Create and push the matching tag, such as `v0.2.0`.

The workflow uploads:

- `svelte-lens-vite-<version>.tgz`
- `svelte-lens-chrome-<version>.zip`

The trusted publisher on npm must target GitHub user `brunostjohn`, repository `svelte-lens`, workflow `release.yml`, with npm publishing allowed.
