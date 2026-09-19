import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Taskline · 个人任务台',
        short_name: 'Taskline',
        description: '离线优先、使用 GitHub 手动同步的个人任务工作台。',
        theme_color: '#111827',
        background_color: '#f5f7fb',
        display: 'standalone',
        start_url: './',
        scope: './',
        lang: 'zh-CN',
        icons: [
          {
            src: 'favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable'
          }
        ]
      },
      workbox: {
        navigateFallback: 'index.html',
        runtimeCaching: []
      }
    })
  ]
});
