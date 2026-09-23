import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 构建产物落到 ../webui/public/react/ —— 现有 webui server 的 serveStatic 直接托管，
// 服务端零改动即可提供新 UI（base: '/react/'）。
// dev 时由 vite 起本地 server，并把 /api 与 /api/stream(WS) 反向代理到真实 webui server。
const WEBUI_TARGET = process.env.WEBUI_TARGET ?? 'http://127.0.0.1:18090'

export default defineConfig({
  base: '/react/',
  plugins: [react()],
  build: {
    outDir: '../webui/public/react',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5180,
    proxy: {
      '/api': {
        target: WEBUI_TARGET,
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
