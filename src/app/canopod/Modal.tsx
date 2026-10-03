/* The modal shell every dialog is built on.

   Every modal ends the same way: a ghost dismiss plus ONE primary that names
   its action — the same "next action" contract as the main window. If a
   button could sensibly say "OK", the dialog hasn't decided what it's for.

   The card floats, so it carries radius and shadow. Its interior is flat. */
import { useEffect, useRef, type ComponentType, type ReactNode } from "react";
import { Cube, X } from "../../icons";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';

export default function Modal({
  icon: Icon = Cube,
  danger,
  title,
  sub,
  wide,
  narrow,
  busy,
  onClose,
  children,
  foot,
}: {
  icon?: ComponentType<{ size?: number }>;
  danger?: boolean;
  title: string;
  sub?: string;
  wide?: boolean;
  narrow?: boolean;
  /** while busy the dialog refuses Escape and scrim-dismiss — a half-finished
      worktree create should not be dismissable by a stray click */
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
  foot?: ReactNode;
}) {
  const card = useRef<HTMLDivElement>(null);
  // latest props read inside once-subscribed listeners, so the effects below
  // never need `busy`/`onClose` in their deps (callers pass a fresh inline
  // `onClose` every render — keying the effect on it re-ran the initial-focus
  // step on every re-render and yanked focus back to the first field/button)
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // keyboard: focus trap + Escape — subscribed once for the dialog's lifetime
  useEffect(() => {
    // aria-modal="true" promises focus cannot leave the dialog. Without a trap
    // Tab walks straight into the app behind the scrim, so the promise was
    // false for assistive tech and keyboard users alike.
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !card.current) return;
      const items = [...card.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const outside = !card.current.contains(active);
      // both directions recover from focus that has escaped the card (e.g. a
      // focused child was removed and focus fell to <body>), so Tab can't walk
      // into the app behind the scrim
      if (e.shiftKey && (active === first || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || outside)) {
        e.preventDefault();
        first.focus();
      }
    };
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyRef.current) {
        // An open popup inside the card (a ref picker's menu, say) marks itself
        // with data-esc-claim. Escape belongs to the innermost thing it can
        // close, so stand down and let the event reach it — dismissing the
        // whole dialog would skip a level. The claimant stops the event itself,
        // keeping the app-level handler out of it just as we do below.
        if (card.current?.querySelector("[data-esc-claim]")) return;
        // capture phase + stopPropagation: the app-level Escape handler would
        // otherwise also close the palette or attention queue behind us
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", trap, true);
    document.addEventListener("keydown", k, true);
    return () => {
      document.removeEventListener("keydown", trap, true);
      document.removeEventListener("keydown", k, true);
    };
  }, []);

  // initial focus + restore — runs ONCE per open, never on a re-render, so
  // typing in a field can't be interrupted by a re-focus of the first control
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const first = card.current?.querySelector<HTMLElement>("input,textarea,select,button.cx-btn--primary");
    const t = setTimeout(() => first?.focus(), 40);
    return () => {
      clearTimeout(t);
      // hand focus back to whatever opened us, so the keyboard doesn't reset
      // to the top of the document
      opener?.focus?.();
    };
  }, []);

  // Recovery after re-renders: some modals swap their content in place (e.g.
  // DatabaseModal's snapshot prompt) rather than remounting. If that removes
  // the focused element, focus falls to <body> and Tab could escape behind the
  // scrim. Pull it back into the card — but ONLY when focus has actually
  // orphaned, never while the user is typing in a still-present field, so this
  // can't reintroduce the focus-stealing this component was fixed to avoid.
  useEffect(() => {
    const active = document.activeElement;
    if (card.current && (active === document.body || active === document.documentElement || active === null)) {
      card.current.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    }
  });

  return (
    <div
      className="cx-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className={"cx-modal" + (wide ? " cx-modal--wide" : "") + (narrow ? " cx-modal--narrow" : "")}
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="cx-modal__head">
          <span className={"cx-modal__ic" + (danger ? " cx-modal__ic--danger" : "")}>
            <Icon size={14} />
          </span>
          <span className="cx-modal__title">
            <b>{title}</b>
            {sub && <span>{sub}</span>}
          </span>
          {/* marked so usePrimaryAction can tell "the user tabbed to a button
              and means to press it" from "focus fell back here" — this is the
              first focusable in the card, so an orphaned focus lands on it */}
          <button className="cx-ib" data-modal-close onClick={onClose} disabled={busy} title="Close">
            <X size={13} />
          </button>
        </div>
        <div className="cx-modal__body">{children}</div>
        {foot && <div className="cx-modal__foot">{foot}</div>}
      </div>
    </div>
  );
}

/** Bind a dialog's primary action to the key its button already advertises.

    Every dialog here prints a key on its primary button, and until now only
    one of them listened for it — the rest were decoration. The guards are what
    make a bare ⏎ safe to claim:

      · a textarea keeps it (⏎ types a newline there)
      · a focused button keeps it (⏎ is how you press the one you tabbed to) —
        except the header's close, which is where focus FALLS BACK to rather
        than somewhere the user chose, and which Escape already covers
      · an inner popup that claimed Escape has also claimed ⏎ (a ref picker
        committing a choice), so stand down for it
      · a disabled action never fires

    `⌘⏎` needs none of that — a modifier cannot collide with typing — which is
    why the heavier actions advertise that one. Capture phase + stopPropagation
    keeps the app-level ⏎ (run next action) out of it while a dialog is up. */
export function usePrimaryAction(key: "enter" | "mod-enter", enabled: boolean, run: () => void) {
  const runRef = useRef(run);
  runRef.current = run;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !enabledRef.current) return;
      const mod = e.metaKey || e.ctrlKey;
      if (key === "mod-enter" ? !mod : mod) return;
      if (document.querySelector("[data-esc-claim]")) return;
      if (key === "enter") {
        const el = document.activeElement as HTMLElement | null;
        if (el?.tagName === "TEXTAREA" || el?.isContentEditable) return;
        if (el?.tagName === "BUTTON" && !el.hasAttribute("data-modal-close")) return;
      }
      e.preventDefault();
      e.stopPropagation();
      runRef.current();
    };
    document.addEventListener("keydown", h, true);
    return () => document.removeEventListener("keydown", h, true);
  }, [key]);
}

/** The footer's supporting line — always the elastic item, so the actions
    beside it never shrink or wrap. */
export function Hint({ icon: Icon, children, tone }: { icon?: ComponentType<{ size?: number }>; children: ReactNode; tone?: "warn" }) {
  return (
    <span className="cx-modal__hint" style={tone === "warn" ? { color: "var(--state-attention)" } : undefined}>
      {Icon && <Icon size={11} />}
      <span>{children}</span>
    </span>
  );
}

export const Spacer = () => <span className="cxs-spacer" />;
