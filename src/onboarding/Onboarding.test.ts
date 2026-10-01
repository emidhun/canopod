import { describe, expect, it } from "vitest";
import type { RepoDetection } from "../ipc";
import { derive } from "./Onboarding";

const detection = (overrides: Partial<RepoDetection> = {}): RepoDetection => ({
  top: "/tmp/example",
  name: "example",
  branch: "main",
  origin: "",
  stack: "node",
  packageManager: "npm",
  hasConfig: false,
  scripts: [{ name: "dev", command: "vite" }],
  ...overrides,
});

describe("onboarding suggestions", () => {
  it.each(["npm", "pnpm", "yarn"])("uses the detected %s commands", (packageManager) => {
    const result = derive(detection({ packageManager }));
    expect(result.services[0].cmd).toBe(`${packageManager} run dev`);
    expect(result.cfg.setup.map((step) => step.cmd)).toEqual([`${packageManager} install`]);
  });

  it("does not invent Node commands for an unknown project", () => {
    const result = derive(detection({ stack: "other", packageManager: "", scripts: [] }));
    expect(result.services).toEqual([]);
    expect(result.cfg.setup).toEqual([]);
    expect(result.cfg.env).toEqual([]);
    expect(result.cfg.writeConfig).toBe(false);
  });

  it("keeps database defaults out of database-free projects", () => {
    const result = derive(detection());
    expect(result.cfg.env.map((entry) => entry.key)).toEqual(["PORT"]);
    expect(result.cfg.resetDb).toBe("");
    expect(result.cfg.migrate).toBe("");
  });

  it("adds database configuration only when database scripts exist", () => {
    const result = derive(detection({ scripts: [
      { name: "dev", command: "vite" },
      { name: "db:migrate", command: "node migrate.js" },
      { name: "db:reset", command: "node reset.js" },
    ] }));
    expect(result.cfg.env.map((entry) => entry.key)).toEqual(["PORT", "PG_DB"]);
    expect(result.cfg.migrate).toBe("npm run db:migrate");
    expect(result.cfg.resetDb).toBe("npm run db:reset");
  });

  it("preserves an existing repository configuration by default", () => {
    const result = derive(detection({ hasConfig: true }));
    expect(result.cfg.writeConfig).toBe(false);
    expect(result.cfg.env).toEqual([]);
    expect(result.cfg.setup).toEqual([]);
  });
});
