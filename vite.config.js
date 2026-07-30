import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import macros from 'unplugin-parcel-macros'
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig({
  plugins: [
    macros.vite(),
    react(),
    // HTTPS (self-signed) is on by default; set NEXUS_NO_SSL=1 for plain HTTP
    // local dev/preview where a self-signed cert would otherwise block loads.
    ...(process.env.NEXUS_NO_SSL ? [] : [basicSsl()]),
  ],
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})