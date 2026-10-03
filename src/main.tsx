import "./legacyStorage";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { applyPlatformClass } from "./platform";
import { initAppearance } from "./appearance";
import { hasBackend } from "./ipc";
import { useStore } from "./store";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/terminal.css";
// The redesigned shell loads last so its rules win where a class name is
// shared with the older screens (Settings, the modals, onboarding) that
// app.css still owns.
import "./styles/canopod-components.css";
import "./styles/canopod-shell.css";
import "./styles/canopod-modals.css";
import "./styles/canopod-settings.css";

applyPlatformClass();
initAppearance();

// Dev-only affordance: in the no-backend browser mock, expose the store on the
// window so the documentation capture harness (website/scripts) can choreograph
// a demo — onboarding then worktrees appearing in the sidebar — against seeded
// state. hasBackend() is true in the packaged app, so this never runs there.
if (!hasBackend()) {
  (window as unknown as { __canopodStore?: typeof useStore }).__canopodStore = useStore;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
