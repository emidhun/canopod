import { describe, expect, it } from "vitest";
import { repoRelative } from "./FilesPage";

describe("repoRelative", () => {
  it("normalizes Unix and Windows selections", () => {
    expect(repoRelative("/repo/config/.env", "/repo/")).toBe("config/.env");
    expect(repoRelative("C:\\Repo\\config\\app.json", "c:\\repo")).toBe("config/app.json");
  });
  it("rejects sibling paths, traversal, and missing roots", () => {
    for (const path of ["/repo-other/.env", "/elsewhere/file", "/repo/../outside", "/repo"]) {
      expect(() => repoRelative(path, "/repo")).toThrow("inside the repository");
    }
    expect(() => repoRelative("/repo/file", undefined)).toThrow();
  });
});
