import { defineConfig } from 'vite';

const HUB = process.env.NP_HUB_URL || `http://localhost:${process.env.PORT || 50000}`;

export default defineConfig({
  server: {
    port: 50001,
    strictPort: true, // 端口被占用时直接报错，而不是悄悄换成别的端口
    proxy: {
      '/api': { target: HUB, changeOrigin: true },
      '/agent': { target: HUB, changeOrigin: true },
    },
  },
  build: { chunkSizeWarningLimit: 1500 },
});
