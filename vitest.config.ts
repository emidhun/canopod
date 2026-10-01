import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Frontend unit tests. jsdom gives appearance.ts a real localStorage +
// document to drive, and the settings panels a DOM to render into; the pure
// helpers (command grouping, validation) need nothing from it.
// Tests live next to what they cover as *.test.ts(x).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
