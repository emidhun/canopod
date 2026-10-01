import { useEffect, useState } from "react";
import { errText, hasBackend, ipc, type McpConnection, type McpStatus, type RepoCfg } from "../../../ipc";
import "../../../styles/mcp.css";

type Client = "claude" | "codex" | "generic";
export function connectionConfig(client: Client, connection: McpConnection): string {
  if (client === "codex") return `[mcp_servers.canopy]\nurl = ${JSON.stringify(connection.endpoint)}\nbearer_token_env_var = "CANOPY_MCP_TOKEN"`;
  if (client === "generic") return JSON.stringify({ url: connection.endpoint, transport: "streamable-http", headers: { Authorization: `Bearer ${connection.token}` } }, null, 2);
  return JSON.stringify({ mcpServers: { canopy: { type: "http", url: connection.endpoint, headers: { Authorization: `Bearer ${connection.token}` } } } }, null, 2);
}

export function firstTask(repoId: string): string {
  return `Call canopy_status for repository ${JSON.stringify(repoId)}. Then list its worktrees and services, report anything stopped or failing, and do not make changes.`;
}

export default function McpPage({ preferredRepoPath }: { preferredRepoPath?: string }) {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [repos, setRepos] = useState<RepoCfg[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [allowConfiguration, setAllowConfiguration] = useState(false);
  const [allowServices, setAllowServices] = useState(false);
  const [allowWrite, setAllowWrite] = useState(false);
  const [client, setClient] = useState<Client>("claude");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [rotate, setRotate] = useState(false);
  const [target, setTarget] = useState("");
  const [targetError, setTargetError] = useState("");
  const native = hasBackend();

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [next, settings] = await Promise.all([ipc.mcpStatus(), ipc.getSettings()]);
      setStatus(next);
      setAllowWrite(next.allowWorktreeWrite);
      setAllowServices(next.allowServiceControl);
      setAllowConfiguration(next.allowConfiguration);
      setRepos(settings.repos);
      const allowed = next.repoIds.filter((id) => settings.repos.some((r) => r.id === id));
      const preferred = settings.repos.find((r) => r.path === preferredRepoPath);
      setSelected(preferred ? [...new Set([...allowed, preferred.id])] : allowed);
    } catch (e) { setError(errText(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (native) void load(); else setLoading(false); }, [native, preferredRepoPath]);

  useEffect(() => {
    let active = true;
    setTarget(""); setTargetError("");
    if (native && client !== "generic") ipc.mcpAgentTarget(client).then((path) => { if (active) setTarget(path); }).catch((e) => { if (active) setTargetError(errText(e)); });
    return () => { active = false; };
  }, [native, client]);

  async function connect() {
    setBusy(true); setError(""); setNotice("");
    try {
      const path = await ipc.mcpConnectAgent(client);
      setNotice(`Agent configured in ${path}. Restart or reconnect the agent to use Canopy. The connection reads the current token automatically.`);
    } catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  }

  async function change(action: "enable" | "disable" | "rotate") {
    setBusy(true); setError(""); setNotice("");
    try {
      const next = action === "rotate" ? await ipc.mcpRotateToken()
        : await ipc.mcpConfigure(action === "enable", action === "enable" ? selected : undefined, action === "enable" ? allowWrite : undefined, action === "enable" ? allowServices : undefined, action === "enable" ? allowConfiguration : undefined);
      setStatus(next);
      setAllowWrite(next.allowWorktreeWrite);
      setAllowServices(next.allowServiceControl);
      setAllowConfiguration(next.allowConfiguration);
      setRotate(false);
      setNotice(action === "rotate" ? "Token rotated. Reconnect agents configured here. For manual setup, copy the new token into your agent."
        : action === "disable" ? "MCP access disabled." : "MCP access saved. Connect your agent below.");
    } catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  }
  async function copy(kind: "config" | "token" | "endpoint" | "transport" | "header" | "task") {
    setBusy(true); setError(""); setNotice("");
    try {
      if (!navigator.clipboard) throw new Error("Clipboard is unavailable. Use Canopy's desktop app.");
      if (kind === "endpoint") await navigator.clipboard.writeText(status!.endpoint);
      else if (kind === "transport") await navigator.clipboard.writeText("streamable-http");
      else if (kind === "task") await navigator.clipboard.writeText(firstTask(status!.repoIds[0]));
      else {
        const connection = await ipc.mcpConnection();
        await navigator.clipboard.writeText(kind === "token" ? connection.token : kind === "header" ? `Bearer ${connection.token}` : connectionConfig(client, connection));
      }
      setNotice(kind === "config" ? client === "codex" ? "Codex configuration copied. Set CANOPY_MCP_TOKEN from the separately copied token, then restart Codex."
        : "Configuration copied, including the token. Paste it into your agent's private configuration and reconnect."
        : kind === "task" ? "First task copied. Paste it into your connected agent."
        : kind === "token" ? "MCP token copied." : kind === "header" ? "Authorization header value copied." : kind === "transport" ? "Transport copied." : "Endpoint copied.");
    } catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  }

  if (!native) return <div className="mcp-panel"><p>MCP configuration is available in the Canopy desktop app.</p></div>;
  const changed = status && (allowWrite !== status.allowWorktreeWrite || allowServices !== status.allowServiceControl || allowConfiguration !== status.allowConfiguration || [...selected].sort().join("\n") !== [...status.repoIds].sort().join("\n"));
  return <div className="mcp-panel" aria-busy={busy || loading}>
    {(error || notice) && <div className="mcp-feedback">
      {error && <p role="alert" className="mcp-error">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </div>}
    <section className="mcp-section">
      <div className="mcp-heading"><h3>MCP access</h3><span className={`mcp-status ${status?.enabled ? "enabled" : ""}`}>{loading ? "Loading…" : status?.error ? "Needs attention" : status?.enabled ? "Enabled" : "Disabled"}</span></div>
      <p>Let an agent read repository status, list worktrees and services, and inspect redacted logs and job output for repositories you choose. Enable write access below to let it create worktrees and run setup.</p>
      {status?.error && <p role="alert" className="mcp-error">{status.error}</p>}
      <div className="mcp-actions"><button className="btn" disabled={busy || loading} onClick={() => void load()}>Refresh status</button></div>
      {status && <>
        <fieldset disabled={busy || loading} className="mcp-repos"><legend>Allowed repositories</legend>
          {repos.length === 0 && <p>Add a repository before enabling MCP.</p>}
          {repos.map((repo) => <label key={repo.id} className="mcp-repo"><input type="checkbox" checked={selected.includes(repo.id)} onChange={(e) => setSelected((ids) => e.target.checked ? [...ids, repo.id] : ids.filter((id) => id !== repo.id))} /><span>{repo.name}<small>{repo.path}</small></span></label>)}
        </fieldset>
        <label className="mcp-repo"><input type="checkbox" checked={allowWrite} disabled={busy || loading || (!!status.executionError && !allowWrite)} onChange={(e) => setAllowWrite(e.target.checked)} /><span>Allow worktree creation and setup</span></label>
        <p className="mcp-hint">Applies to all allowed repositories. Agents can run configured setup scripts; creation follows repository defaults, including service startup. Setup reruns are limited to linked worktrees. Write access is off by default.</p>
        <label className="mcp-repo"><input type="checkbox" checked={allowServices} disabled={busy || loading || (!!status.executionError && !allowServices)} onChange={(e) => setAllowServices(e.target.checked)} /><span>Allow service start, stop and restart</span></label>
        <p className="mcp-hint">Agents can control configured services in all allowed repositories, including the main checkout. Starting a service runs its configured command.</p>
        <label className="mcp-repo"><input type="checkbox" checked={allowConfiguration} disabled={busy || loading} onChange={(e) => setAllowConfiguration(e.target.checked)} /><span>Allow repository and service configuration</span></label>
        <p className="mcp-hint">Agents can update allowed repositories and existing services, including commands and worktree defaults. Changes apply to future starts and setup; running services are not restarted.</p>
        {status.executionError && <p role="alert" className="mcp-error">Worktree jobs unavailable: {status.executionError}</p>}
        <div className="mcp-actions">
          <button className="btn pri" disabled={busy || loading || selected.length === 0 || (!!status.enabled && !changed)} onClick={() => void change("enable")}>{status.enabled ? "Apply MCP access" : "Enable MCP"}</button>
          <button className="btn" disabled={busy || loading || (!status.enabled && !status.error)} onClick={() => void change("disable")}>Disable MCP</button>
        </div>
        <p className="mcp-hint">Changes apply immediately. Access stays available while Canopy is in the tray and ends when the app quits.</p>
      </>}
    </section>
    {status && <section className="mcp-section">
      <h3>Connect to agent</h3>
      <p>Use an agent on this computer. Enable MCP, choose automatic or manual setup, then reconnect the agent.</p>
      <h4>Automatic setup</h4>
      <label className="mcp-label">Agent<select disabled={busy} value={client} onChange={(e) => setClient(e.target.value as Client)}><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="generic">Other MCP client</option></select></label>
      {client !== "generic" && <>
        {target && <p>Creates or updates the <code>canopy</code> MCP entry for your user in <code>{target}</code>. Other agent settings are preserved.</p>}
        {targetError && <p role="alert" className="mcp-error">{targetError}</p>}
        <button className="btn pri" disabled={busy || !status.enabled || !target} onClick={() => void connect()}>Connect {client === "claude" ? "Claude Code" : "Codex"}</button>
        <p className="mcp-hint">Use an up-to-date Claude Code or Codex, then restart or reconnect after setup. Tokens refresh automatically when you reconnect.</p>
      </>}
      <h4>Manual connection</h4>
      <div className="mcp-field"><label className="mcp-label">Endpoint <input readOnly value={status.endpoint} /></label><button className="btn" disabled={busy} onClick={() => void copy("endpoint")}>Copy endpoint</button></div>
      <div className="mcp-field"><label className="mcp-label">Transport<input readOnly value="Streamable HTTP" /></label><button className="btn" disabled={busy} onClick={() => void copy("transport")}>Copy transport</button></div>
      <div className="mcp-field"><label className="mcp-label">Bearer token<input readOnly type="password" value={status.enabled ? "hidden-token" : ""} placeholder="Enable MCP to create a token" /></label><button className="btn" disabled={busy || !status.enabled} onClick={() => void copy("token")}>Copy token</button></div>
      <div className="mcp-field"><label className="mcp-label">Authorization header<input readOnly value="Authorization: Bearer <MCP_TOKEN>" /></label><button className="btn" disabled={busy || !status.enabled} onClick={() => void copy("header")}>Copy Authorization value</button></div>
      <details><summary>Copy a complete configuration instead</summary>
      <p>{client === "codex" ? "Merge this entry into your private ~/.codex/config.toml, set CANOPY_MCP_TOKEN to the separately copied token before starting Codex, then restart it. Replace an existing canopy entry instead of adding a duplicate."
        : client === "claude" ? "Save this as a private JSON file outside your repository, then start Claude Code with: claude --mcp-config /path/to/canopy-mcp.json. Use /mcp to check the connection."
        : "Add a Streamable HTTP server with this URL and Authorization header in your MCP client."}</p>
      <pre className="mcp-config">{connectionConfig(client, { endpoint: status.endpoint, token: "<MCP_TOKEN>" })}</pre>
      <button className="btn pri" disabled={busy || !status.enabled} onClick={() => void copy("config")}>Copy agent configuration</button>
      </details>
      <p className="mcp-hint">{client === "codex" ? "The Codex configuration references CANOPY_MCP_TOKEN instead of embedding your secret. Keep the token private." : "The copied configuration includes your secret token. Keep the file private and out of version control."} After connecting, use one of these repository IDs:</p>
      <ul>{repos.filter((r) => status.repoIds.includes(r.id)).map((r) => <li key={r.id}>{r.name}: <code>{r.id}</code></li>)}</ul>
      {status.repoIds.length > 0 && <><pre className="mcp-config">{firstTask(status.repoIds[0])}</pre><button className="btn" disabled={busy} onClick={() => void copy("task")}>Copy first task</button></>}
      <div className="mcp-actions"><button className="btn" disabled={busy} onClick={() => setRotate(true)}>Rotate token…</button></div>
      {rotate && <div className="mcp-confirm"><p>Rotating invalidates the current token. Manually configured agents will need the new token. Agents connected here can read it when they reconnect.</p><div className="mcp-actions"><button className="btn danger" disabled={busy} onClick={() => void change("rotate")}>Rotate token</button><button className="btn" disabled={busy} onClick={() => setRotate(false)}>Cancel</button></div></div>}
    </section>}
  </div>;
}
