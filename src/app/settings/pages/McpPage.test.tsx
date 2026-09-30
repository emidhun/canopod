import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import McpPage from "./McpPage";
import { ipc, type McpStatus } from "../../../ipc";

vi.mock("../../../ipc", () => ({
  hasBackend: () => true,
  errText: (e: unknown) => String(e),
  ipc: { mcpAgentTarget: vi.fn(), mcpConnectAgent: vi.fn(), mcpStatus: vi.fn(), getSettings: vi.fn(), mcpConfigure: vi.fn(), mcpRotateToken: vi.fn(), mcpConnection: vi.fn() },
}));
const disabled: McpStatus = { allowWorktreeWrite: false, executionError: null, enabled: false, error: null, endpoint: "http://127.0.0.1:47831/mcp", repoIds: [], permissions: ["read"], transport: "streamable-http" };
const enabled = { ...disabled, enabled: true, repoIds: ["repo"] };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.mcpAgentTarget).mockResolvedValue("/home/user/.claude.json");
  vi.mocked(ipc.mcpConnectAgent).mockResolvedValue("/home/user/.claude.json");
  vi.mocked(ipc.mcpStatus).mockResolvedValue(disabled);
  vi.mocked(ipc.getSettings).mockResolvedValue({ repos: [{ id: "repo", name: "My repo", path: "/repo" }] } as Awaited<ReturnType<typeof ipc.getSettings>>);
  vi.mocked(ipc.mcpConfigure).mockResolvedValue(enabled);
  vi.mocked(ipc.mcpConnection).mockResolvedValue({ endpoint: disabled.endpoint, token: "private-token" });
});

describe("MCP settings and onboarding controls", () => {
  it("requires explicit repository selection and enablement", async () => {
    const user = userEvent.setup(); render(<McpPage />);
    expect(await screen.findByRole("button", { name: "Enable MCP" })).toBeDisabled();
    expect(ipc.mcpConnection).not.toHaveBeenCalled();
    await user.click(screen.getByRole("checkbox", { name: /My repo/ }));
    await user.click(screen.getByRole("button", { name: "Enable MCP" }));
    expect(ipc.mcpConfigure).toHaveBeenCalledWith(true, ["repo"], false);
    expect(await screen.findByText("Enabled")).toBeInTheDocument();
  });
  it("preselects the onboarding repository without enabling MCP", async () => {
    render(<McpPage preferredRepoPath="/repo" />);
    expect(await screen.findByRole("checkbox", { name: /My repo/ })).toBeChecked();
    expect(ipc.mcpConfigure).not.toHaveBeenCalled();
  });
  it("requires an explicit grant and supports revoking write access", async () => {
    const user = userEvent.setup();
    vi.mocked(ipc.mcpStatus).mockResolvedValue(enabled);
    vi.mocked(ipc.mcpConfigure).mockResolvedValueOnce({ ...enabled, allowWorktreeWrite: true }).mockResolvedValueOnce(enabled);
    render(<McpPage />);
    const permission = await screen.findByRole("checkbox", { name: "Allow worktree creation and setup" });
    expect(permission).not.toBeChecked();
    await user.click(permission);
    await user.click(screen.getByRole("button", { name: "Apply MCP access" }));
    await waitFor(() => expect(ipc.mcpConfigure).toHaveBeenLastCalledWith(true, ["repo"], true));
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply MCP access" })).toBeDisabled());
    await user.click(permission);
    await user.click(screen.getByRole("button", { name: "Apply MCP access" }));
    await waitFor(() => expect(ipc.mcpConfigure).toHaveBeenLastCalledWith(true, ["repo"], false));
  });
  it("only exports secrets on copy and creates the selected agent configuration", async () => {
    const user = userEvent.setup(); vi.mocked(ipc.mcpStatus).mockResolvedValue(enabled);
    render(<McpPage />);
    await screen.findByText("Enabled");
    expect(ipc.mcpConnection).not.toHaveBeenCalled();
    await user.click(screen.getByText("Copy a complete configuration instead"));
    await user.selectOptions(screen.getByLabelText("Agent"), "codex");
    await user.click(screen.getByRole("button", { name: "Copy agent configuration" }));
    const clipboard = await navigator.clipboard.readText();
    expect(clipboard).toContain('[mcp_servers.canopy]');
    expect(clipboard).toContain('Authorization = "Bearer private-token"');
    expect(screen.queryByText(/private-token/)).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Agent"), "claude");
    await user.click(screen.getByRole("button", { name: "Copy agent configuration" }));
    expect(JSON.parse(await navigator.clipboard.readText()).mcpServers.canopy.headers.Authorization).toBe("Bearer private-token");
  });
  it("confirms rotation and reports clipboard failures", async () => {
    const user = userEvent.setup(); vi.mocked(ipc.mcpStatus).mockResolvedValue(enabled);
    vi.mocked(ipc.mcpRotateToken).mockResolvedValue(enabled);
    render(<McpPage />); await screen.findByText("Enabled");
    await user.click(screen.getByRole("button", { name: "Rotate token…" }));
    expect(ipc.mcpRotateToken).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Rotate token" }));
    expect(ipc.mcpRotateToken).toHaveBeenCalledOnce();
    await screen.findByText(/Token rotated/);
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("clipboard denied"));
    await user.click(screen.getByRole("button", { name: "Copy token" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("clipboard denied");
  });
  it("does not claim success after an enable failure and supports disabling", async () => {
    const user = userEvent.setup(); vi.mocked(ipc.mcpConfigure).mockRejectedValueOnce(new Error("policy changed"));
    render(<McpPage preferredRepoPath="/repo" />);
    await screen.findByRole("checkbox", { name: /My repo/ });
    await user.click(screen.getByRole("button", { name: "Enable MCP" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("policy changed");
    expect(screen.getByRole("button", { name: "Copy token" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Enable MCP" }));
    await screen.findByText("Enabled");
    vi.mocked(ipc.mcpConfigure).mockResolvedValue(disabled);
    await user.click(screen.getByRole("button", { name: "Disable MCP" }));
    await waitFor(() => expect(ipc.mcpConfigure).toHaveBeenLastCalledWith(false, undefined, undefined));
    expect(await screen.findByText("Disabled")).toBeInTheDocument();
  });
  it("connects the selected agent only on request and copies individual fields", async () => {
    const user = userEvent.setup(); vi.mocked(ipc.mcpStatus).mockResolvedValue(enabled);
    render(<McpPage />); await screen.findByText("Enabled");
    expect(ipc.mcpConnectAgent).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Connect Claude Code" }));
    expect(ipc.mcpConnectAgent).toHaveBeenCalledWith("claude");
    expect(await screen.findByRole("status")).toHaveTextContent("Agent configured");
    await user.click(screen.getByRole("button", { name: "Copy transport" }));
    expect(await navigator.clipboard.readText()).toBe("streamable-http");
    await user.click(screen.getByRole("button", { name: "Copy Authorization value" }));
    expect(await navigator.clipboard.readText()).toBe("Bearer private-token");
  });
  it("blocks enablement when no repositories are registered", async () => {
    vi.mocked(ipc.getSettings).mockResolvedValue({ repos: [] } as unknown as Awaited<ReturnType<typeof ipc.getSettings>>);
    render(<McpPage />);
    expect(await screen.findByText("Add a repository before enabling MCP.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enable MCP" })).toBeDisabled();
  });
});
