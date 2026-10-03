// Inline SVG icons (Tabler-style) — ported from design handoff app-icons.jsx / popover.jsx
import type { SVGProps } from "react";

function isvg(size: number, sw?: number): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: sw || 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  };
}

type P = { size?: number };

// Canopod brandmark — refined git fork (two parents → one child), 24u grid.
// `nodeColor` optionally tints the three nodes (the signature teal-node look);
// `solid` fills the nodes for small sizes (< ~20px).
export const Fork = ({ size = 14, nodeColor, solid }: P & { nodeColor?: string; solid?: boolean }) => (
  <svg {...isvg(size)}>
    <path d="M7 8v1.5a2.5 2.5 0 0 0 2.5 2.5h5a2.5 2.5 0 0 0 2.5 -2.5v-1.5" />
    <path d="M12 12v4" />
    <g stroke={nodeColor || "currentColor"} fill={solid ? nodeColor || "currentColor" : "none"}>
      <circle cx="7" cy="6" r="2.05" />
      <circle cx="17" cy="6" r="2.05" />
      <circle cx="12" cy="18" r="2.05" />
    </g>
  </svg>
);

export const Search = ({ size = 14 }: P) => (
  <svg {...isvg(size)}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M21 21l-4.5 -4.5" />
  </svg>
);

// git-commit — the node on the line; names the Commit action
export const Git = ({ size = 14 }: P) => (
  <svg {...isvg(size)}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M3 12h5.8" />
    <path d="M15.2 12H21" />
  </svg>
);

export const Folder = ({ size = 14 }: P) => (
  <svg {...isvg(size)}>
    <path d="M4 5h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1 -2 2H4a2 2 0 0 1 -2 -2V7a2 2 0 0 1 2 -2z" />
  </svg>
);

export const Plus = ({ size = 14 }: P) => (
  <svg {...isvg(size)}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </svg>
);

export const Refresh = ({ size = 15 }: P) => (
  <svg {...isvg(size)}>
    <path d="M20 11a8 8 0 1 0 -2.3 5.7" />
    <path d="M20 5v6h-6" />
  </svg>
);

export const Settings = ({ size = 15 }: P) => (
  <svg {...isvg(size)}>
    <path d="M10.3 3.2a1.6 1.6 0 0 1 3.4 0l.1.6a1.6 1.6 0 0 0 2.3 1l.5-.3a1.6 1.6 0 0 1 2.2 2.2l-.3.5a1.6 1.6 0 0 0 1 2.3l.6.1a1.6 1.6 0 0 1 0 3.4l-.6.1a1.6 1.6 0 0 0-1 2.3l.3.5a1.6 1.6 0 0 1-2.2 2.2l-.5-.3a1.6 1.6 0 0 0-2.3 1l-.1.6a1.6 1.6 0 0 1-3.4 0l-.1-.6a1.6 1.6 0 0 0-2.3-1l-.5.3a1.6 1.6 0 0 1-2.2-2.2l.3-.5a1.6 1.6 0 0 0-1-2.3l-.6-.1a1.6 1.6 0 0 1 0-3.4l.6-.1a1.6 1.6 0 0 0 1-2.3l-.3-.5a1.6 1.6 0 0 1 2.2-2.2l.5.3a1.6 1.6 0 0 0 2.3-1z" />
    <circle cx="12" cy="12" r="2.6" />
  </svg>
);

export const Editor = ({ size = 15 }: P) => (
  <svg {...isvg(size)}>
    <path d="M16 18l6-6-6-6" />
    <path d="M8 6l-6 6 6 6" />
  </svg>
);

export const Finder = ({ size = 15 }: P) => (
  <svg {...isvg(size)}>
    <path d="M5 4h14a1 1 0 0 1 1 1v3H4V5a1 1 0 0 1 1-1z" />
    <rect x="4" y="8" width="16" height="12" rx="1.5" />
  </svg>
);

export const Terminal = ({ size = 15 }: P) => (
  <svg {...isvg(size)}>
    <path d="M5 7l5 5-5 5" />
    <path d="M12 19h7" />
  </svg>
);

export const Pull = ({ size = 15 }: P) => (
  <svg {...isvg(size)}>
    <path d="M12 3v12" />
    <path d="M7 10l5 5 5-5" />
    <path d="M5 21h14" />
  </svg>
);

export const Database = ({ size = 15 }: P) => (
  <svg {...isvg(size)}>
    <ellipse cx="12" cy="6" rx="7" ry="2.6" />
    <path d="M5 6v6c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6v-6" />
    <path d="M5 12v6c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6v-6" />
  </svg>
);

export const More = ({ size = 16 }: P) => (
  <svg {...isvg(size)}>
    <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </svg>
);

export const MoreV = ({ size = 16 }: P) => (
  <svg {...isvg(size)}>
    <circle cx="12" cy="5" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="19" r="1.4" fill="currentColor" stroke="none" />
  </svg>
);

export const Chevron = ({ size = 14 }: P) => (
  <svg {...isvg(size)}>
    <path d="M6 9l6 6l6 -6" />
  </svg>
);

export const Play = ({ size = 15 }: P) => (
  <svg {...isvg(size)}>
    <path d="M7 5v14l11-7z" fill="currentColor" stroke="none" />
  </svg>
);

export const Stop = ({ size = 14 }: P) => (
  <svg {...isvg(size)}>
    <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" stroke="none" />
  </svg>
);

export const Restart = ({ size = 15 }: P) => (
  <svg {...isvg(size)}>
    <path d="M20 11a8 8 0 1 0 -2.3 5.7" />
    <path d="M20 5v6h-6" />
  </svg>
);

export const Logs = ({ size = 15 }: P) => (
  <svg {...isvg(size)}>
    <path d="M4 7h16" />
    <path d="M4 12h10" />
    <path d="M4 17h13" />
  </svg>
);

export const Globe = ({ size = 15 }: P) => (
  <svg {...isvg(size, 1.7)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3c2.5 2.5 2.5 15 0 18" />
    <path d="M12 3c-2.5 2.5-2.5 15 0 18" />
  </svg>
);

export const Server = ({ size = 15 }: P) => (
  <svg {...isvg(size, 1.7)}>
    <rect x="3" y="4" width="18" height="7" rx="1.6" />
    <rect x="3" y="13" width="18" height="7" rx="1.6" />
    <path d="M7 7.5h.01" />
    <path d="M7 16.5h.01" />
  </svg>
);

export const Cog = ({ size = 15 }: P) => (
  <svg {...isvg(size, 1.7)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
  </svg>
);

export const Check = ({ size = 18 }: P) => (
  <svg {...isvg(size)}>
    <path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" />
    <path d="M9 12l2 2l4 -4" />
  </svg>
);

export const X = ({ size = 18 }: P) => (
  <svg {...isvg(size)}>
    <path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" />
    <path d="M10 10l4 4m0 -4l-4 4" />
  </svg>
);

export const Spinner = ({ size = 18, className = "spin" }: P & { className?: string }) => (
  <svg {...isvg(size)} className={className}>
    <path d="M12 3a9 9 0 1 0 9 9" />
  </svg>
);

export const External = ({ size = 13 }: P) => (
  <svg {...isvg(size)}>
    <path d="M12 6h-5a2 2 0 0 0 -2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2 -2v-5" />
    <path d="M11 13l9 -9" />
    <path d="M15 4h5v5" />
  </svg>
);

export const WindowIcon = ({ size = 16 }: P) => (
  <svg {...isvg(size)}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 9h18" />
  </svg>
);

export const Package = ({ size = 15 }: P) => (
  <svg {...isvg(size)}>
    <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
    <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
  </svg>
);

export const Copy = ({ size = 15 }: P) => (
  <svg {...isvg(size)}>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </svg>
);

export const Trash = ({ size = 15 }: P) => (
  <svg {...isvg(size)}>
    <path d="M4 7h16" />
    <path d="M10 11v6M14 11v6" />
    <path d="M5 7l1 13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-13" />
    <path d="M9 7V4h6v3" />
  </svg>
);

export const Power = ({ size = 16 }: P) => (
  <svg {...isvg(size)}>
    <path d="M7 6a7.75 7.75 0 1 0 10 0" />
    <path d="M12 4v8" />
  </svg>
);

// ── Files-to-provision UI ──
export const File = ({ size = 15 }: P) => (
  <svg {...isvg(size)}>
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
  </svg>
);

export const Braces = ({ size = 14 }: P) => (
  <svg {...isvg(size)}>
    <path d="M7 4a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2" />
    <path d="M17 4a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2" />
  </svg>
);

export const Upload = ({ size = 14 }: P) => (
  <svg {...isvg(size)}>
    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    <path d="M12 15V3" />
    <path d="M7 8l5-5 5 5" />
  </svg>
);

export const Download = ({ size = 14 }: P) => (
  <svg {...isvg(size)}>
    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    <path d="M12 3v12" />
    <path d="M7 10l5 5 5-5" />
  </svg>
);

export const Cube = ({ size = 15 }: P) => (
  <svg {...isvg(size)}>
    <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
    <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
  </svg>
);

// ── Agent lane ──
export const PopOut = ({ size = 14 }: P) => (
  <svg {...isvg(size, 1.8)}>
    <path d="M11 5h-4a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-4" />
    <path d="M13 11l7 -7" />
    <path d="M15 4h5v5" />
  </svg>
);

export const PopIn = ({ size = 14 }: P) => (
  <svg {...isvg(size, 1.8)}>
    <path d="M13 19h4a2 2 0 0 0 2 -2v-10a2 2 0 0 0 -2 -2h-10a2 2 0 0 0 -2 2v4" />
    <path d="M11 13l-7 7" />
    <path d="M9 20h-5v-5" />
  </svg>
);

export const Sparkle = ({ size = 14 }: P) => (
  <svg {...isvg(size, 1.7)}>
    <path d="M12 3l1.9 5.1l5.1 1.9l-5.1 1.9l-1.9 5.1l-1.9 -5.1l-5.1 -1.9l5.1 -1.9z" />
    <path d="M18.5 16.5l.7 1.8l1.8 .7l-1.8 .7l-.7 1.8l-.7 -1.8l-1.8 -.7l1.8 -.7z" />
  </svg>
);

export const Doc = ({ size = 14 }: P) => (
  <svg {...isvg(size, 1.7)}>
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z" />
    <path d="M9 12h6" />
    <path d="M9 16h4" />
  </svg>
);

export const Link = ({ size = 13 }: P) => (
  <svg {...isvg(size, 1.8)}>
    <path d="M9 15l6 -6" />
    <path d="M11 6l.5 -.5a3.5 3.5 0 0 1 5 5l-.5 .5" />
    <path d="M13 18l-.5 .5a3.5 3.5 0 0 1 -5 -5l.5 -.5" />
  </svg>
);

export const ChevRight = ({ size = 14 }: P) => (
  <svg {...isvg(size)}>
    <path d="M9 6l6 6l-6 6" />
  </svg>
);

export const ChevLeft = ({ size = 14 }: P) => (
  <svg {...isvg(size)}>
    <path d="M15 6l-6 6l6 6" />
  </svg>
);

export const ExpandH = ({ size = 15 }: P) => (
  <svg {...isvg(size, 1.8)}>
    <path d="M4 8v-2a1 1 0 0 1 1 -1h2" />
    <path d="M4 16v2a1 1 0 0 0 1 1h2" />
    <path d="M20 8v-2a1 1 0 0 0 -1 -1h-2" />
    <path d="M20 16v2a1 1 0 0 1 -1 1h-2" />
    <path d="M9 12h6" />
    <path d="M11 10l-2 2l2 2" />
    <path d="M13 10l2 2l-2 2" />
  </svg>
);

export const Info = ({ size = 13 }: P) => (
  <svg {...isvg(size, 1.8)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8h.01" />
    <path d="M11 12h1v4h1" />
  </svg>
);

/* ── workflow layer — added for the redesign (attention queue, next action,
   layout presets, the sidebar toggle). Same 24u grid, same stroke discipline. */

export const Alert = ({ size = 13 }: P) => (
  <svg {...isvg(size, 1.9)}>
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
    <path d="M10.3 4.3L2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z" />
  </svg>
);

export const Bell = ({ size = 13 }: P) => (
  <svg {...isvg(size, 1.8)}>
    <path d="M10 5a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3a4 4 0 0 0 2 3H4a4 4 0 0 0 2-3v-3a7 7 0 0 1 4-6" />
    <path d="M9 17v1a3 3 0 0 0 6 0v-1" />
  </svg>
);

export const Keyboard = ({ size = 14 }: P) => (
  <svg {...isvg(size, 1.8)}>
    <rect x="2.5" y="6" width="19" height="12" rx="2" />
    <path d="M6 10.5v.01M10 10.5v.01M14 10.5v.01M18 10.5v.01M8 14.5h8" />
  </svg>
);

export const Shield = ({ size = 14 }: P) => (
  <svg {...isvg(size, 1.8)}>
    <path d="M12 3l7 3v5c0 4.5 -3 7.6 -7 9c-4 -1.4 -7 -4.5 -7 -9V6z" />
  </svg>
);

export const Pin = ({ size = 12 }: P) => (
  <svg {...isvg(size, 1.8)}>
    <path d="M9 4h6l-1 6l3 3v2H7v-2l3-3l-1-6z" />
    <path d="M12 15v5" />
  </svg>
);

export const Browser = ({ size = 14 }: P) => (
  <svg {...isvg(size, 1.8)}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9h18" />
    <path d="M6 6.5h.01M8.5 6.5h.01" />
  </svg>
);

export const Bolt = ({ size = 13 }: P) => (
  <svg {...isvg(size, 1.9)}>
    <path d="M13 3l-7 9h5l-1 9l7-9h-5l1-9z" />
  </svg>
);

/* layout presets — a window, split or whole */
export const Split = ({ size = 14 }: P) => (
  <svg {...isvg(size, 1.7)}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M12 4v16" />
  </svg>
);

export const Single = ({ size = 14 }: P) => (
  <svg {...isvg(size, 1.7)}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
  </svg>
);

export const SidebarIcon = ({ size = 14 }: P) => (
  <svg {...isvg(size, 1.7)}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </svg>
);

export const Sliders = ({ size = 14 }: P) => (
  <svg {...isvg(size, 1.8)}>
    <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h13M21 18h-1" />
    <circle cx="15" cy="6" r="1.9" />
    <circle cx="9" cy="12" r="1.9" />
    <circle cx="19" cy="18" r="1.9" />
  </svg>
);

/** Two arrows trading places — branch switching, in place. */
export const Swap = ({ size = 14 }: P) => (
  <svg {...isvg(size, 1.8)}>
    <path d="M4 8h13l-3 -3" />
    <path d="M20 16h-13l3 3" />
  </svg>
);
