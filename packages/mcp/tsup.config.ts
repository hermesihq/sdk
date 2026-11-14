import { defineConfig } from 'tsup'

export default defineConfig([
  { entry: { index: 'src/index.ts' }, format: ['esm'], dts: true, sourcemap: true, clean: true, target: 'es2022', platform: 'node' },
  // The command people run: no types, a shebang.
  { entry: { stdio: 'src/stdio.ts' }, format: ['esm'], sourcemap: true, target: 'es2022', platform: 'node', banner: { js: '#!/usr/bin/env node' } },
  // The hosted worker: one self-contained file, with the MCP SDK bundled in.
  { entry: { worker: 'src/worker.ts' }, format: ['esm'], sourcemap: false, target: 'es2022', platform: 'neutral', noExternal: [/.*/] },
])
