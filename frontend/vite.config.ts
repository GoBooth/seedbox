import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");

  return {
    plugins: [react()],
    server: {
      port: 5173,
      open: false,
      proxy: env.VITE_API_BASE_URL
        ? undefined
        : {
            "/api": {
              target: "http://localhost:5000",
              changeOrigin: true,
            },
          },
    },
  };
});
