import "./legacyStorage";
import React, { useEffect, useRef } from "react";
import ReactDOM from "react-dom/client";
import Popover from "./popover/Popover";
import { initSync, useStore } from "./store";
import { hasBackend } from "./ipc";
import { applyPlatformClass } from "./platform";
import { initAppearance } from "./appearance";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/popover.css";

applyPlatformClass();
initAppearance();

const POP_W = 348; // design width
const POP_MAX_H = 472; // design cap — the list scrolls inside past this

function PopoverRoot() {
  const ref = useRef<HTMLDivElement>(null);
  const tree = useStore((s) => s.tree);

  useEffect(() => initSync(), []);

  // Fit the window to the content, capped at the design's 472px (and never past
  // the available screen height). Past the cap the .list scrolls inside.
  useEffect(() => {
    if (!hasBackend() || !ref.current) return;
    const el = ref.current;
    let raf = 0;
    const measure = async () => {
      const ph = el.querySelector(".ph") as HTMLElement | null;
      const list = el.querySelector(".list") as HTMLElement | null;
      const pf = el.querySelector(".pf") as HTMLElement | null;
      // header + footer are fixed; the list contributes its full content height
      const natural = ph && pf && list
        ? Math.ceil(ph.offsetHeight + pf.offsetHeight + list.scrollHeight + 2 /* card borders */)
        : el.offsetHeight;
      const maxH = Math.min(POP_MAX_H, Math.max(260, window.screen.availHeight - 14));
      const h = Math.min(natural, maxH);
      const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
      getCurrentWindow()
        .setSize(new LogicalSize(POP_W, h))
        .catch(() => {});
    };
    // measure after layout settles, and again once more to converge if clamped
    raf = requestAnimationFrame(() => {
      measure();
      raf = requestAnimationFrame(measure);
    });
    return () => cancelAnimationFrame(raf);
  }, [tree]);

  return (
    <div className="pop-gutter">
      <div ref={ref}>
        <Popover />
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PopoverRoot />
  </React.StrictMode>,
);
