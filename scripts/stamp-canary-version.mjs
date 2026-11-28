// Writes a canary version into the image's package.json, which the engine reports as its
// version (PKG_VERSION, `/api/health`). The control plane checks that version against the
// image's semver tag on a rollout, so a canary image tagged by scripts/canary-version.sh
// must carry the same value.
//
// Usage: node stamp-canary-version.mjs <package.json> <version>
// An empty version is a build that is not a canary (release, staging): nothing changes.
// Only the canary shape is accepted, so this step cannot stamp a release version.
import { readFileSync, writeFileSync } from 'node:fs';

const [, , file, version = ''] = process.argv;
if (version === '') process.exit(0);
if (!file || !/^\d+\.\d+\.\d+-canary\.[0-9a-f]{8}$/.test(version)) {
  console.error(`stamp-canary-version: refusing ${JSON.stringify(version)}, not <x.y.z>-canary.<sha8>`);
  process.exit(1);
}
const pkg = JSON.parse(readFileSync(file, 'utf8'));
pkg.version = version;
writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
