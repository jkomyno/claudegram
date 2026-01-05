import { defineConfig } from 'tsdown'

export default defineConfig({
  clean: true,
  dts: true,
  entry: ['./src/index.ts'],
  format: ['esm', 'cjs'],
  noExternal: ['marked'],
  outDir: 'build',
  sourcemap: true,
  tsconfig: './tsconfig.build.json',
})
