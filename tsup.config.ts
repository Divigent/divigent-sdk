import { defineConfig } from 'tsup';

/**
 * Build config for @divigent/sdk.
 *
 * - ESM-first, CJS fallback via tsup dual build.
 * - `viem` is declared external — consumer already has it as a peerDep.
 * - Tree-shaking on. Every top-level export in src/ must be individually
 *   importable and strip cleanly when unused.
 * - Source maps are not shipped in beta packages to keep the npm artifact lean.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: false,
  clean: true,
  minify: false,
  treeshake: true,
  splitting: false,
  external: ['viem'],
  target: 'es2022',
  outDir: 'dist',
});
