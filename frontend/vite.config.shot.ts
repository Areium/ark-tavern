import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// 截图验证专用配置：端口 5174，API 代理到 5001（独立后端实例）。
// 依赖预打包缓存必须与主开发配置（vite.config.ts）分开：两份配置的插件不同 → 缓存
// 指纹不同，共用 node_modules/.vite 会让后启动的一方重新优化并覆盖前者的产物，
// 正在跑的 5173 开发服务器随之报「Outdated Optimize Dep」整页重载。
export default defineConfig({
  plugins: [react()],
  base: "./",
  cacheDir: path.resolve(__dirname, "node_modules/.vite-shot"),
  resolve: {
    alias: { "@": path.resolve(__dirname, "src"), url: "url/url.js" },
  },
  optimizeDeps: {
      include: ["pixi.js", "@pixi-spine/base", "@pixi-spine/runtime-3.8"],
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:5001", changeOrigin: true } },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
