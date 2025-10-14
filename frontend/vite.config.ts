import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

const hydrateViteEnvFromDevVars = () => {
  const devVarsPath = path.resolve(__dirname, "../.dev.vars");
  if (!fs.existsSync(devVarsPath)) {
    return;
  }

  const contents = fs.readFileSync(devVarsPath, "utf8");
  contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.startsWith("VITE_"))
    .forEach((line) => {
      const separatorIndex = line.indexOf("=");
      if (separatorIndex === -1) {
        return;
      }
      const key = line.slice(0, separatorIndex).trim();
      if (!key || process.env[key]) {
        return;
      }
      const rawValue = line.slice(separatorIndex + 1).trim();
      const isWrappedInQuotes =
        (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
        (rawValue.startsWith("'") && rawValue.endsWith("'")) ||
        (rawValue.startsWith("`") && rawValue.endsWith("`"));
      const value = isWrappedInQuotes ? rawValue.slice(1, -1) : rawValue;
      process.env[key] = value;
    });
};

hydrateViteEnvFromDevVars();

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
              target: "http://localhost:5002",
              changeOrigin: true,
            },
          },
    },
  };
});
