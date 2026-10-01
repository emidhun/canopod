// Shared Vitest setup: jest-dom matchers plus a DOM teardown between tests.
// Panels render against a mocked `ipc`, so nothing here touches Tauri.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
