import { useLayoutEffect, type RefObject } from "react";

/** Choose the roomier side when the preferred side cannot fit the list. */
export function popoverPosition(anchor: DOMRect, width: number, height: number, viewportWidth: number, viewportHeight: number) {
  const gap = 4;
  const below = Math.max(0, viewportHeight - anchor.bottom - gap * 2);
  const above = Math.max(0, anchor.top - gap * 2);
  const up = below < height && above > below;
  const maxHeight = Math.min(height, up ? above : below);
  const fittedWidth = Math.min(width, Math.max(0, viewportWidth - gap * 2));
  return {
    top: Math.max(gap, up ? anchor.top - gap - maxHeight : Math.min(anchor.bottom + gap, viewportHeight - gap - maxHeight)),
    left: Math.max(gap, Math.min(anchor.left, viewportWidth - fittedWidth - gap)),
    width: fittedWidth,
    maxHeight,
  };
}

/** The top layer escapes clipping while keeping popup focus inside its modal. */
export function useViewportPopover(anchor: RefObject<HTMLElement | null>, popup: RefObject<HTMLElement | null>, open: boolean, height = 196, width?: number | "content") {
  useLayoutEffect(() => {
    const element = popup.current;
    if (!open || !element) return;
    element.showPopover?.();
    const contentWidth = Number.parseFloat(getComputedStyle(element).width) || 346;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const desiredWidth = width === "content" ? contentWidth : width ?? rect.width;
      const desiredHeight = Math.min(height, element.scrollHeight + element.offsetHeight - element.clientHeight || height);
      const position = popoverPosition(rect, desiredWidth, desiredHeight, window.innerWidth, window.innerHeight);
      Object.assign(element.style, {
        position: "fixed", margin: "0", right: "auto", bottom: "auto",
        top: `${position.top}px`, left: `${position.left}px`,
        width: `${position.width}px`, maxHeight: `${position.maxHeight}px`,
      });
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    if (anchor.current) observer?.observe(anchor.current);
    observer?.observe(element);
    const content = new MutationObserver(place);
    content.observe(element, {childList:true, subtree:true, characterData:true});
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer?.disconnect();
      content.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      if (element.isConnected) element.hidePopover?.();
    };
  }, [anchor, popup, open, height, width]);
}
