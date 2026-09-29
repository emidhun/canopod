// A live terminal pane: one xterm.js renderer bound to a backend PTY session.
//
// The PTY lives in Rust (keyed by `termId`); this component is the disposable
// view. On mount it opens/attaches the session, rehydrates scrollback, and
// streams bytes both ways. On unmount it disposes the widget but LEAVES the PTY
// running — switching worktrees or toggling the Agent/Shell tab keeps the shell
// (and any agent in it) alive; we rehydrate from the backend buffer on return.
import { useEffect, useRef } from "react";
import { Terminal, type IBufferLine, type ILink } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { errText, hasBackend, ipc, on, type TermCfg } from "../ipc";
import { useStore } from "../store";

/** Open a URL in the user's browser (never in the app's own webview). */
async function openExternal(url: string) {
  if (!hasBackend()) {
    window.open(url, "_blank", "noopener");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

// File paths as build tools and agents print them: `src/app/Foo.tsx:12:3`,
// `./x/y.ts`, `/abs/path.rs`. Requires a slash and an extension so ordinary
// prose ("2:30", "v1.2") isn't turned into a link. The optional :line:col tail
// is captured so it can be stripped before the path is resolved.
const FILE_RE = /(?:^|[\s"'`([<])((?:\.{0,2}\/)?(?:[\w.@~+-]+\/)+[\w.@+-]+\.\w{1,8})((?::\d+){0,2})/g;

/** base64 (raw PTY bytes) → Uint8Array for xterm.write */
function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const THEME = {
  background: "#191a1d", // --panel-2
  foreground: "#cfd1d6",
  cursor: "#5cc7cd", // --accent
  cursorAccent: "#191a1d",
  selectionBackground: "rgba(92,199,205,.25)",
  // Keep the terminal's ANSI colors explicit. Supplying only black/brightBlack
  // lets renderer/platform defaults vary, which made colored CLI output appear
  // monochrome after the lane theme was introduced.
  black: "#191a1d",
  red: "#f07178",
  green: "#7bd88f",
  yellow: "#f5c76b",
  blue: "#82aaff",
  magenta: "#c792ea",
  cyan: "#5cc7cd",
  white: "#cfd1d6",
  brightBlack: "#7c7e86",
  brightRed: "#ff8f91",
  brightGreen: "#a6e3a1",
  brightYellow: "#ffd580",
  brightBlue: "#9cc3ff",
  brightMagenta: "#e0b7ff",
  brightCyan: "#8ae7eb",
  brightWhite: "#f4f5f7",
};

/* Embedded-shell settings, fetched once per webview and shared by every pane.

   Applied to a LIVE terminal rather than being a constructor argument: making
   the pane wait for an async settings read would either delay every terminal
   behind an IPC round-trip, or remount (and so tear down) live sessions
   whenever settings changed. xterm takes all of these at runtime. */
let termCfgPromise: Promise<TermCfg | null> | null = null;
function loadTermCfg(): Promise<TermCfg | null> {
  if (!termCfgPromise) {
    termCfgPromise = ipc
      .getSettings()
      .then((s) => s.embeddedTerminal ?? null)
      .catch(() => null);
  }
  return termCfgPromise;
}
/** Called after a settings save, so the next pane to mount reads fresh values. */
export function invalidateTermCfg() {
  termCfgPromise = null;
}

/** Apply only the fields the user actually set — an unset field keeps the
    design's own default rather than being overwritten with a magic number. */
function applyTermCfg(term: Terminal, cfg: TermCfg | null) {
  if (!cfg) return;
  if (cfg.fontFamily.trim()) term.options.fontFamily = cfg.fontFamily.trim();
  if (cfg.fontSize > 0) term.options.fontSize = cfg.fontSize;
  if (cfg.scrollback > 0) term.options.scrollback = cfg.scrollback;
  if (cfg.cursor === "block" || cfg.cursor === "underline" || cfg.cursor === "bar") term.options.cursorStyle = cfg.cursor;
  term.options.cursorBlink = cfg.cursorBlink;
}

export default function TerminalPane({
  termId,
  cwd,
  hidden,
  command,
  readOnly,
}: {
  termId: string;
  cwd: string;
  hidden?: boolean;
  /** run this command instead of an interactive shell; the session ends (fires
      terminal:exit) when it exits — used to track agent lifecycle */
  command?: string;
  /** Show a finished session's retained output without opening a PTY. Opening
      one here would re-run `command`, which is exactly what the user didn't
      ask for; input is swallowed since there's nothing to write to. */
  readOnly?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    if (!hasBackend()) {
      host.innerHTML =
        '<div style="padding:14px;font:12.5px var(--mono);color:var(--faint)">Terminal runs in the Canopy desktop app.</div>';
      return;
    }

    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      theme: THEME,
      allowProposedApi: true,
      scrollback: 2500,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    let alive = true;
    let bellTimer: number | undefined;
    loadTermCfg().then((cfg) => {
      if (!alive) return;
      applyTermCfg(term, cfg);
      fit.fit();
      // xterm dropped `bellStyle`, so the audible/visual bell is ours. A flash
      // on the pane is the right shape here: a beep from a background worktree
      // with no visible tab tells you nothing about WHERE it came from.
      if (cfg?.bell) {
        term.onBell(() => {
          host.classList.add("is-bell");
          window.clearTimeout(bellTimer);
          bellTimer = window.setTimeout(() => host.classList.remove("is-bell"), 160);
        });
      }
    });

    // http(s) links → the user's browser, never this webview.
    term.loadAddon(
      // failures surface as a toast, not by writing into the buffer — that
      // would read as output from the process and pollute copied scrollback
      new WebLinksAddon((event, uri) => {
        event?.preventDefault();
        openExternal(uri).catch((e) => useStore.getState().showToast(`Couldn't open link — ${errText(e)}`));
      }),
    );

    // File paths → the configured editor. The backend resolves them against the
    // worktree root and refuses anything that escapes it, so a path printed by
    // some arbitrary process can't be used to open a file elsewhere on disk.
    const fileLinks = term.registerLinkProvider({
      provideLinks(y, cb) {
        const line: IBufferLine | undefined = term.buffer.active.getLine(y - 1);
        if (!line) return cb(undefined);
        const text = line.translateToString(true);
        const links: ILink[] = [];
        for (const m of text.matchAll(FILE_RE)) {
          const path = m[1];
          // m.index points at the leading delimiter (if any), not the path
          const start = (m.index ?? 0) + m[0].length - path.length - m[2].length;
          links.push({
            // xterm columns are 1-based and ranges are inclusive
            range: { start: { x: start + 1, y }, end: { x: start + path.length + m[2].length, y } },
            text: path + m[2],
            activate: (event) => {
              event?.preventDefault();
              // the :line:col tail is dropped — the editor command takes a path
              ipc.openFileInEditor(cwd, path).catch((e) => {
                useStore.getState().showToast(`Couldn't open ${path} — ${errText(e)}`);
              });
            },
          });
        }
        cb(links.length ? links : undefined);
      },
    });

    // GPU rendering — far faster under heavy output. Fall back to the DOM
    // renderer if WebGL is unavailable or its context is lost.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      /* no WebGL — DOM renderer stays */
    }

    let disposed = false;
    let unlistenData: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;
    let hydrated = false;
    // xterm re-answers query escape sequences (Device Attributes, cursor-position
    // reports) it finds while replaying scrollback; those replies must NOT reach
    // the PTY or the shell prompt echoes them as junk ("1;2c22;3R…"). Suppressed
    // only while the snapshot write is parsing.
    let suppressOut = false;
    const pending: { seq: number; data: string }[] = [];
    const writeChunk = (b64: string) => termRef.current?.write(decode(b64));
    // cumulative byte cursor of the last chunk we applied. The backend stops
    // emitting while every window is hidden (the PTY keeps running and its
    // scrollback keeps advancing) — a seq gap on the next event, or a stale
    // cursor on window focus, means "resync from the snapshot".
    let lastSeq = 0;
    /** decoded byte length of a base64 chunk, without decoding it */
    const b64len = (s: string) => (s.length / 4) * 3 - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0);
    const resync = async () => {
      if (!hydrated) return; // initial hydrate owns the buffer until done
      try {
        const snap = await ipc.terminalGetBuffer(termId);
        if (disposed || !termRef.current || !snap || snap.seq === lastSeq) return;
        lastSeq = snap.seq;
        suppressOut = true;
        termRef.current.reset();
        termRef.current.write(decode(snap.buffer), () => {
          suppressOut = false;
        });
      } catch {
        /* the next chunk's gap check retries */
      }
    };

    // fit only when the host is actually laid out — fitting a zero-size or
    // display:none element leaves xterm's renderer without dimensions and throws
    // asynchronously on the next write.
    const safeFit = () => {
      if (!host.clientWidth || !host.clientHeight) return;
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
    };
    requestAnimationFrame(safeFit);

    // keystrokes (and terminal reports) → PTY. The PTY echoes; no local echo.
    const onDataDisp = term.onData((data) => {
      if (suppressOut || readOnly) return;
      ipc.terminalWrite(termId, data).catch(() => {});
    });

    // Register listeners BEFORE opening so no output is missed, then rehydrate
    // against the snapshot cursor: replay the snapshot, then apply only queued
    // live events past its seq — no double-render, no gap.
    (async () => {
      // if the effect is torn down before a listen() resolves (StrictMode),
      // cleanup can't see the unlisten yet — unregister it right here instead,
      // or the handler leaks and keeps appending after unmount.
      const u1 = await on.terminalData((e) => {
        if (e.id !== termId) return;
        if (!hydrated) {
          pending.push({ seq: e.seq, data: e.data });
        } else if (e.seq - b64len(e.data) !== lastSeq) {
          // missed chunks (emits were skipped while hidden) — full resync
          void resync();
        } else {
          writeChunk(e.data);
          lastSeq = e.seq;
        }
      });
      if (disposed) return u1();
      unlistenData = u1;
      const u2 = await on.terminalExit((e) => {
        if (e.id === termId) termRef.current?.write("\r\n\x1b[38;5;244m[process exited]\x1b[0m\r\n");
      });
      if (disposed) return u2();
      unlistenExit = u2;

      try {
        // read-only replays a finished session's retained buffer; opening would
        // spawn a process the user didn't ask to restart
        if (!readOnly) await ipc.terminalOpen(termId, cwd, term.cols, term.rows, command);
        const snap = await ipc.terminalGetBuffer(termId);
        if (disposed || !termRef.current) return;
        const baseline = snap?.seq ?? 0;
        if (snap?.buffer) {
          suppressOut = true;
          termRef.current.write(decode(snap.buffer), () => {
            suppressOut = false;
          });
        }
        lastSeq = baseline;
        for (const p of pending)
          if (p.seq > baseline) {
            writeChunk(p.data);
            lastSeq = p.seq;
          }
        pending.length = 0;
        hydrated = true;
      } catch (err) {
        termRef.current?.write(`\r\n\x1b[31mterminal error: ${errText(err)}\x1b[0m\r\n`);
      }
    })();

    // window back on screen → catch up on output emitted-nothing while hidden
    const onVisible = () => {
      if (!document.hidden) void resync();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    // keep the PTY sized to the widget
    const ro = new ResizeObserver(() => {
      if (hidden || !host.clientWidth || !host.clientHeight) return;
      safeFit();
      if (!readOnly) ipc.terminalResize(termId, term.cols, term.rows).catch(() => {});
    });
    ro.observe(host);

    return () => {
      disposed = true;
      alive = false;
      window.clearTimeout(bellTimer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      unlistenData?.();
      unlistenExit?.();
      fileLinks.dispose();
      onDataDisp.dispose();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId, cwd, command, readOnly]);

  // re-fit when the pane becomes visible (tab toggle) or the lane resizes
  useEffect(() => {
    if (hidden) return;
    const id = requestAnimationFrame(() => {
      const host = hostRef.current;
      if (!host || !fitRef.current || !termRef.current || !host.clientWidth || !host.clientHeight) return;
      try {
        fitRef.current.fit();
        ipc.terminalResize(termId, termRef.current.cols, termRef.current.rows).catch(() => {});
      } catch {
        /* ignore */
      }
    });
    return () => cancelAnimationFrame(id);
  }, [hidden, termId]);

  return <div ref={hostRef} className="xterm-host" />;
}
