import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const repository = process.env.GITHUB_REPOSITORY?.split("/")[1] ?? "ESP32S3_AudioBoard_Platform";
const isUserSite = repository.toLowerCase() === "kirthana-web.github.io";

export default defineConfig({
  base: isUserSite ? "/" : `/${repository}/`,
  plugins: [react()],
  publicDir: "public",
  build: {
    outDir: "dist/pages",
    emptyOutDir: true,
    rollupOptions: { input: "index.html" },
  },
});
