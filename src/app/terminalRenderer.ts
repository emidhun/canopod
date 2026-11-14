import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";

/** Own a GPU context only while this terminal is visible; the PTY is untouched. */
export function terminalRenderer(term: Terminal) {
  let addon: WebglAddon | null = null;
  let lost = false;
  const hide = () => {
    const current = addon;
    addon = null;
    current?.dispose();
  };
  return {
    hide,
    show() {
      if (addon || lost) return;
      try {
        addon = new WebglAddon();
        addon.onContextLoss(() => {
          lost = true;
          hide();
        });
        term.loadAddon(addon);
      } catch {
        hide();
        lost = true;
        // Keep xterm's DOM renderer when GPU rendering is unavailable.
      }
    },
  };
}
