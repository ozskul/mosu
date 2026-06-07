import { defineConfig } from "vite";

// Base path is configurable so the app can be deployed to a project page
// (e.g. https://<user>.github.io/mosu/). Set MOSU_BASE at build time.
const env = (globalThis as { process?: { env?: Record<string, string> } }).process?.env ?? {};

export default defineConfig({
  base: env.MOSU_BASE ?? "/",
  build: {
    target: "es2020",
    outDir: "dist",
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
} as any);
