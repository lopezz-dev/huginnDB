/**
 * Vitest configuration, deliberately separate from `vite.config.ts`.
 *
 * The app config runs `git log` at load time to stamp `__DOC_UPDATED__` for
 * the in-app documentation viewer, and pulls in the Tauri dev-server plumbing
 * (`TAURI_DEV_HOST`, the fixed port, the HMR socket). None of that is wanted
 * for a test run, and the `git` shell-outs alone make every `vitest` start
 * slower than the tests it is about to run.
 *
 * What tests *do* need from the app config is the `@` alias, which is
 * duplicated below. That is the whole overlap.
 *
 * `environment: "jsdom"` is set per-file via the `@vitest-environment` docblock
 * rather than globally: most of what is worth testing here is pure — SQL
 * splitting, BSON type resolution, clipboard serialisers, driver capability
 * gates — and paying for a DOM in those files buys nothing.
 */
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
