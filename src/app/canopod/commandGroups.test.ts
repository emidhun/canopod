import { describe, expect, it } from "vitest";
import { groupCommands, groupNames } from "./commandGroups";

const cmd = (label: string, group = "") => ({ label, command: label.toLowerCase(), group });

describe("groupCommands", () => {
  it("promotes the first command to run1 and buckets the rest by group", () => {
    const { flat, groups } = groupCommands([cmd("Dev"), cmd("Lint", "Checks"), cmd("Test", "Checks"), cmd("Deploy", "Release")]);
    expect(flat.map((c) => c.label)).toEqual(["Dev"]);
    expect(Object.keys(groups)).toEqual(["Checks", "Release"]);
    expect(groups.Checks.map((c) => c.label)).toEqual(["Lint", "Test"]);
    expect(groups.Release.map((c) => c.label)).toEqual(["Deploy"]);
  });

  it("buckets ungrouped rest commands under the empty-string key", () => {
    const { groups } = groupCommands([cmd("Dev"), cmd("Build"), cmd("Clean")]);
    expect(groups[""].map((c) => c.label)).toEqual(["Build", "Clean"]);
  });

  it("treats a command with no group field (a pre-groups file) as ungrouped", () => {
    const pre: { label: string; group?: string }[] = [{ label: "Dev" }, { label: "Build" }];
    const { groups } = groupCommands(pre);
    expect(groups[""].map((c) => c.label)).toEqual(["Build"]);
  });

  it("preserves first-seen group order, not alphabetical", () => {
    const { groups } = groupCommands([cmd("run1"), cmd("z", "Zed"), cmd("a", "Alpha")]);
    expect(Object.keys(groups)).toEqual(["Zed", "Alpha"]);
  });

  it("handles empty and single-command lists", () => {
    expect(groupCommands([])).toEqual({ flat: [], groups: {} });
    const one = groupCommands([cmd("Only", "Checks")]);
    expect(one.flat.map((c) => c.label)).toEqual(["Only"]); // the run1 slot ignores group
    expect(one.groups).toEqual({});
  });
});

describe("groupNames", () => {
  it("returns distinct, trimmed, non-empty names in first-seen order", () => {
    expect(groupNames([cmd("a", "Checks"), cmd("b", " Checks "), cmd("c", "Release"), cmd("d", "")])).toEqual(["Checks", "Release"]);
  });

  it("is empty when nothing is grouped", () => {
    expect(groupNames([cmd("a"), cmd("b")])).toEqual([]);
  });
});
