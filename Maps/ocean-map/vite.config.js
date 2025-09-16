import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // Allow overriding via env and falling back to any free port
    port: Number(process.env.PORT) || 5173,
    host: process.env.HOST || true,
    strictPort: false,
    proxy: {
      // Proxy all API calls to NOAA backend server (port 5176)
      '/grid': {
        target: 'http://localhost:5176',
        changeOrigin: true,
        secure: false
      },
      '/grid/historical': {
        target: 'http://localhost:5176',
        changeOrigin: true,
        secure: false
      },
      '/temperature': {
        target: 'http://localhost:5176',
        changeOrigin: true,
        secure: false
      },
      '/status': {
        target: 'http://localhost:5176',
        changeOrigin: true,
        secure: false
      },
      '/sources': {
        target: 'http://localhost:5176',
        changeOrigin: true,
        secure: false
      },
      '/tiles': {
        target: 'http://localhost:5176',
        changeOrigin: true,
        secure: false
      }
    }
  }
})
