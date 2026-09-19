import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // 故意避开 5173——Cyrene-Agent / 其他常见 vite 项目常占用
    port: 5180,
    strictPort: true,
  },
  // Tauri 用固定资产路径；dev 下从 http://localhost:5180 加载
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: 'chrome105',
    minify: 'esbuild',
    sourcemap: false,
  },
})
