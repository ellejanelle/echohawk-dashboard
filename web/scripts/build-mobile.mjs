import { cp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
// This folder contains generated output only. Remove stale hashed bundles.
await rm('mobile-dist', { recursive: true, force: true });
await mkdir('mobile-dist', { recursive: true });
await cp('../vendor/ggwave.js', 'mobile-dist/vendor/ggwave.js', { recursive: true });
await cp('dist/assets', 'mobile-dist/assets', { recursive: true });
await cp('../app/media', 'mobile-dist/app/media', { recursive: true });
await cp('dist/app/index.html', 'mobile-dist/index.html');
// Bundle the catalog for a first launch with no connectivity.
await cp('../kits/catalog.json', 'mobile-dist/kit-catalog.json');
const html = await readFile('mobile-dist/index.html', 'utf8');
await writeFile('mobile-dist/index.html', html.replace(/<link rel="manifest"[^>]*>/, ''));
console.log('Bundled resident screens, kit image and catalog for offline iPhone launch.');
