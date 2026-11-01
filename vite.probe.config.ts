import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'e2e',
  base: './',
  plugins: [react()],
  server: { port: 5199, strictPort: true },
  build: { outDir: '../dist-probe', emptyOutDir: true },
})
