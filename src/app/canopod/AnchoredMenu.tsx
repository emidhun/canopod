/* A menu that floats free of its trigger's layout.

   Anchored popovers cannot live inside the chrome that opens them. Two
   separate things trap them:

     · `.cxs-wtbar` sets `overflow: hidden` so a long branch name ellipses —
       and an ancestor's clip beats any z-index a descendant can set.
     · `.cxs-main` sets `container-type: inline-size` for the pane queries,
       which applies layout containment. That makes it both a stacking
       context and the containing block for absolutely positioned children,
       so a popover inside it can never paint above the status bar.

   So the menu is portalled to <body> and positioned from the trigger's
   viewport rect. Fixed rather than absolute, because the reference is a
   viewport rect and the app itself never scrolls. */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

export default function AnchoredMenu({
  anchor,
  onClose,
  align = "right",
  width,
  children,
  role = "menu",
  label,
}: {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** which edge of the menu lines up with the trigger */
  align?: "left" | "right";
  width?: number;
  children: ReactNode;
  role?: "menu" | "dialog";
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number } | null>(null);

  // measure before paint so the menu never shows at 0,0 for a frame
  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      if (!a) return;
      const gap = 4;
      const menuHeight = ref.current?.offsetHeight ?? 0;
      const menuWidth = ref.current?.offsetWidth ?? width ?? 216;
      const top = a.bottom + gap + menuHeight > window.innerHeight ? Math.max(gap, a.top - menuHeight - gap) : a.bottom + gap;
      setPos(
        align === "right"
          ? { top, right: Math.max(gap, window.innerWidth - a.right) }
          : { top, left: Math.max(gap, Math.min(a.left, window.innerWidth - menuWidth - gap)) },
      );
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor, align, width, !!pos]);

  useEffect(() => {
    if (pos && role === "dialog") ref.current?.querySelector<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex='0']")?.focus();
  }, [!!pos, role]);

  useEffect(() => {
    // the trigger is outside this element, so a click on it would otherwise
    // close-then-reopen; ignore anything inside the anchor too
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (role === "dialog" && e.key === "Tab") {
        const items = Array.from(ref.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex='0']") ?? []);
        const current = items.indexOf(document.activeElement as HTMLElement);
        if (items.length && (current < 0 || (e.shiftKey ? current === 0 : current === items.length - 1))) {
          e.preventDefault();
          items[e.shiftKey ? items.length - 1 : 0].focus();
        }
      }
      if (role === "menu" && ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
        if (!items.length) return;
        e.preventDefault();
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (current + (e.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
        items[next].focus();
      }
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        anchor.current?.focus();
      }
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key, true);
    };
  }, [anchor, onClose, role]);

  if (!pos) return null;

  return createPortal(
    <div
      className="cx-pop"
      role={role}
      aria-label={label}
      ref={ref}
      style={{ position: "fixed", top: pos.top, left: pos.left, right: pos.right, minWidth: width ? Math.min(width, window.innerWidth - 8) : undefined, maxHeight: "calc(100vh - 8px)", overflowY: "auto" }}
    >
      {children}
    </div>,
    document.body,
  );
}
