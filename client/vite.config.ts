import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "EBT_PROXY_TARGET");
  const target = env.EBT_PROXY_TARGET || "http://127.0.0.1:3000";
  const proxy = {
    "/api/v1/ws": { target, ws: true },
    "/api/v1": { target },
  };
  return { server: { proxy }, preview: { proxy } };
});
