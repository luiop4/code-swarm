import { build, context } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { buildNative } from './build-native.mjs';
buildNative();
await mkdir('dist', { recursive: true });
const configs = [
  { entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', external: ['vscode'], sourcemap: true },
  { entryPoints: ['src/webview/app.ts'], outfile: 'dist/app.js', platform: 'browser', format: 'iife', sourcemap: true },
  { entryPoints: ['tests/core.test.ts'], outfile: 'dist/core.test.cjs', platform: 'node', format: 'cjs' },
  { entryPoints: ['tests/extension.test.ts'], outfile: 'dist/extension.test.cjs', platform: 'node', format: 'cjs', external: ['vscode'] },
  { entryPoints: ['tests/webview-host.ts'], outfile: 'dist/webview-host.test.cjs', platform: 'node', format: 'cjs', external: ['vscode'] }
  ,{ entryPoints: ['tests/overlay.test.ts'], outfile: 'dist/overlay.test.cjs', platform: 'node', format: 'cjs', external: ['vscode'] }
  ,{ entryPoints: ['tests/managed.test.ts'], outfile: 'dist/managed.test.cjs', platform: 'node', format: 'cjs', external: ['vscode'] }
].map(c => ({ ...c, bundle: true, target: 'es2022', logLevel: 'warning' }));
await copyFile('src/webview/style.css', 'dist/style.css');
await copyFile('src/webview/index.html', 'dist/index.html');
await copyFile('scripts/swarm_input.py','dist/swarm_input.py');
await copyFile('scripts/managed-producer.py','dist/input-producer.py');
if (process.argv.includes('--watch')) {
  for (const c of configs) await (await context(c)).watch();
  console.log('Watching TypeScript. Run build again after editing HTML/CSS.');
} else {
  await Promise.all(configs.map(c => build(c)));
  console.log('Built extension, stage and tests.');
}
