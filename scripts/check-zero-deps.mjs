// Verified n8n community nodes ship with zero runtime dependencies. Fails the build when package.json has any.
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const runtime = Object.keys(pkg.dependencies ?? {});
const optional = Object.keys(pkg.optionalDependencies ?? {});
const bundled = pkg.bundleDependencies ?? pkg.bundledDependencies ?? [];
const offenders = [...runtime, ...optional, ...bundled];
if (offenders.length > 0) {
	console.error(`Runtime dependencies are not allowed in a verified n8n node: ${offenders.join(', ')}`);
	process.exit(1);
}
const peers = Object.keys(pkg.peerDependencies ?? {});
if (peers.some((name) => name !== 'n8n-workflow')) {
	console.error(`Only n8n-workflow may be a peer dependency, found: ${peers.join(', ')}`);
	process.exit(1);
}
console.log('zero runtime dependencies: ok');
