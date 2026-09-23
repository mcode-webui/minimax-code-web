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
    // 拆包优化：antd 体积大且更新节奏与业务代码不同，单独成 chunk 便于长期缓存；
    // react 运行时同理。业务代码变更时这两个 chunk 的哈希不变，用户无需重新下载。
    rollupOptions: {
      output: {
        // 按路径分组而不是按包名：包名写法会被 hoisting 影响，产出空 chunk。
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (
            /node_modules\/(antd|@ant-design|@rc-component|rc-[^/]+)/.test(id)
          ) {
            return 'antd-vendor';
          }
          if (/node_modules\/(react|react-dom|scheduler)(\/|$)/.test(id)) {
            return 'react-vendor';
          }
          return undefined;
        },
      },
    },
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
