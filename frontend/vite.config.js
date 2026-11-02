import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const shared = fileURLToPath(new URL('../shared', import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@shared': shared },
  },
  server: {
    // моки лежат в ../shared — вне корня фронтенда
    fs: { allow: ['.', shared] },
  },
})
