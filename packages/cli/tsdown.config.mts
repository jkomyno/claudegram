import { defineConfig } from 'tsdown'

export default defineConfig({
  clean: true,
  dts: true,
  entry: ['./src/bin.ts'],
  format: ['esm', 'cjs'],
  outDir: 'build',
  sourcemap: true,
  tsconfig: './tsconfig.build.json',
})
