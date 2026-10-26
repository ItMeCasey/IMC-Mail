import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// @imc/core ships TypeScript source, so it must be bundled rather than externalized.
const bundledWorkspaceDeps = ['@imc/core']

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: bundledWorkspaceDeps })]
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: bundledWorkspaceDeps })]
  },
  renderer: {
    resolve: {
      alias: { '@renderer': resolve(__dirname, 'src/renderer/src') }
    },
    plugins: [
      react(),
      tailwindcss(),
      {
        // The dev server needs a websocket for hot reload; the shipped app must not be able to talk to local services.
        name: 'dev-csp-localhost',
        apply: 'serve',
        transformIndexHtml: (html) => html.replace("connect-src 'self'", "connect-src 'self' ws://localhost:* http://localhost:*")
      }
    ]
  }
})
