#!/usr/bin/env node

/**
 * Build script for vv-switch CLI
 *
 * Uses esbuild to bundle the CLI into a single executable file.
 * All dependencies (express, commander, inquirer, etc.) are bundled
 * so that npx can execute without downloading/installing dependencies.
 */

import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outdir = join(__dirname, 'dist');

async function main() {
  console.log('Building vv-switch CLI with esbuild...\n');

  mkdirSync(outdir, { recursive: true });

  const outfile = join(outdir, 'cli.cjs');

  await build({
    entryPoints: [join(__dirname, 'bin/cli.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile,
    minify: true,
    sourcemap: false,
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  });

  console.log('Build complete!');
  console.log('  Output: dist/cli.cjs');
  console.log('  This file includes all npm dependencies bundled together.');

  // Copy static assets that esbuild can't bundle
  copyFileSync(join(__dirname, 'src', 'config-ui.html'), join(outdir, 'config-ui.html'));
  console.log('  Copied: src/config-ui.html → dist/config-ui.html');

  console.log('  Run: node dist/cli.cjs --help');
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
