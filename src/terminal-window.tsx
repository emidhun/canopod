import "./legacyStorage";
// Entry for the detached terminal window. Reads the session id / cwd / branch
// from the URL and renders the terminal, attaching to the same backend PTY.
import React from "react";
import ReactDOM from "react-dom/client";
import DetachedTerminal from "./app/DetachedTerminal";
import { applyPlatformClass } from "./platform";
import { initAppearance } from "./appearance";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/terminal.css";

applyPlatformClass();
initAppearance();

const params = new URLSearchParams(location.search);
const termId = params.get("id") ?? "";
const cwd = params.get("cwd") ?? "";
const branch = params.get("branch") ?? "";
const title = params.get("title") || "Terminal";
const command = params.get("cmd") || undefined;

document.body.style.background = "var(--panel-2)";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <DetachedTerminal termId={termId} cwd={cwd} branch={branch} title={title} command={command} />
  </React.StrictMode>,
);
