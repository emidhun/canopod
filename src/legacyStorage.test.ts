import { describe, expect, it } from "vitest";
import { migrateLegacyStorage } from "./legacyStorage";

describe("migrateLegacyStorage", () => {
  it("moves pre-rename keys without overwriting current ones", () => {
    localStorage.clear();
    localStorage.setItem("canopy.appearance", '{"theme":"light"}');
    localStorage.setItem("canopy.ctx.repo:main", "old");
    localStorage.setItem("canopod.ctx.repo:main", "new");
    localStorage.setItem("unrelated", "x");
    migrateLegacyStorage();
    expect(localStorage.getItem("canopod.appearance")).toBe('{"theme":"light"}');
    expect(localStorage.getItem("canopod.ctx.repo:main")).toBe("new");
    expect(localStorage.getItem("canopy.appearance")).toBeNull();
    expect(localStorage.getItem("canopy.ctx.repo:main")).toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("x");
  });
});
