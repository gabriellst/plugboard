import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
  format: 'esm',
  target: 'node20',
  // package.json tem "type": "module", entao .js JA e ESM.
  // Sem isso o tsdown emite .mjs e o `exports` aponta pra um arquivo que nao existe.
  outExtensions: () => ({ js: '.js' }),
  dts: true,
  clean: true,
})
