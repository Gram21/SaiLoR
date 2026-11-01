import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'spike',
  base: './',
  plugins: [react()],
  server: { port: 5199, strictPort: true },
  build: { outDir: '../dist-spike', emptyOutDir: true },
})
