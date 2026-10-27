import { defineConfig } from 'vite'

// One file with everything inside (the shared core library and zod), so the droplet needs only
// Node itself: copy dist/server.mjs over and run it. Node's own modules stay external.
export default defineConfig({
  build: {
    ssr: 'src/server.ts',
    outDir: 'dist',
    target: 'node22',
    minify: false,
    emptyOutDir: true,
    rollupOptions: { output: { format: 'es', entryFileNames: 'server.mjs' } }
  },
  ssr: { noExternal: true }
})
