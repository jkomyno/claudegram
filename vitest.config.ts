import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const sourceAliases = {
  '@claudegram/core': fileURLToPath(
    new URL('./packages/claudegram/src/index.ts', import.meta.url),
  ),
}

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: sourceAliases },
        test: {
          name: 'unit',
          include: ['**/unit/**/*.test.ts'],
          environment: 'node',
          globals: true,
          passWithNoTests: true,
        },
      },
      {
        resolve: { alias: sourceAliases },
        test: {
          name: 'integration',
          include: ['**/integration/**/*.test.ts'],
          environment: 'node',
          globals: true,
          passWithNoTests: true,
        },
      },
    ],
  },
})
