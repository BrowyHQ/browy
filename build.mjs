import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = resolve(__dirname, 'dist');

try { rmSync(dist, { recursive: true, force: true }); } catch {}
mkdirSync(dist, { recursive: true });

const PROD = process.env.BA_PROD === '1';
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8'));

async function build() {
  await esbuild.build({
    entryPoints: ['src/cli-bin.ts', 'src/native-host.ts'],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    outdir: 'dist',
    sourcemap: PROD ? false : true,
    minify: PROD,
    legalComments: 'none',
    banner: { js: '' },
    // The native host reports this in hello.ack so the extension can tell
    // which host it is talking to.
    define: { __BROWY_VERSION__: JSON.stringify(pkg.version) },
    external: ['playwright-core', 'ws', '@azure/identity', '@github/copilot-sdk'],
    logLevel: 'info',
  });

  console.log('\n✅ Build complete → dist/');
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
