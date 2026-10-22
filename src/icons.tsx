// Small stroke icons, drawn by hand on a 24px grid.
import type { ReactNode } from "react";

const I = (children: ReactNode) => () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

export const Icon = {
  pointer: I(<path d="M5 3l13 8-6 1.5L9 19z" />),
  undo: I(<><path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 010 12h-3" /></>),
  redo: I(<><path d="M15 14l5-5-5-5" /><path d="M20 9H10a6 6 0 000 12h3" /></>),
  split: I(<><path d="M12 3v18" /><path d="M8 6H5v12h3" /><path d="M16 6h3v12h-3" /></>),
  delLeft: I(<><path d="M14 3v18" strokeDasharray="2 2.5" /><path d="M10 6H5v12h5" /><path d="M18 6v12" /></>),
  delRight: I(<><path d="M10 3v18" strokeDasharray="2 2.5" /><path d="M14 6h5v12h-5" /><path d="M6 6v12" /></>),
  trash: I(<><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" /></>),
  marker: I(<path d="M6 3h12v12l-6 6-6-6z" />),
  speed: I(<><path d="M4 18a8 8 0 1116 0" /><path d="M12 18l4-6" /></>),
  magnet: I(<><path d="M6 4v8a6 6 0 0012 0V4" /><path d="M6 8h3M15 8h3" /></>),
  link: I(<><path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" /></>),
  zoomIn: I(<><circle cx="11" cy="11" r="6" /><path d="M20 20l-4-4M11 8v6M8 11h6" /></>),
  zoomOut: I(<><circle cx="11" cy="11" r="6" /><path d="M20 20l-4-4M8 11h6" /></>),
  fit: I(<><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></>),
  play: () => (
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 001.5.86l12-7.5a1 1 0 000-1.72l-12-7.5A1 1 0 007 4.5z" /></svg>
  ),
  pause: () => (
    <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
  ),
  prev: I(<><path d="M6 5v14" /><path d="M18 5l-9 7 9 7z" /></>),
  next: I(<><path d="M18 5v14" /><path d="M6 5l9 7-9 7z" /></>),
  media: I(<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M10 9l5 3-5 3z" /></>),
  markers: I(<><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" /></>),
  analyze: I(<><path d="M3 12h3l2-6 4 12 3-9 2 3h4" /></>),
  effects: I(<><path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" /><path d="M19 16l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" /></>),
  transitions: I(<><rect x="3" y="6" width="9" height="12" rx="1.5" /><rect x="12" y="6" width="9" height="12" rx="1.5" /><path d="M10 12h4" /></>),
  history: I(<><path d="M3 12a9 9 0 103-6.7" /><path d="M3 4v4h4" /><path d="M12 8v4l3 2" /></>),
  plus: I(<path d="M12 5v14M5 12h14" />),
  folder: I(<path d="M3 6a1 1 0 011-1h5l2 2h9a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1z" />),
  export: I(<><path d="M12 15V3" /><path d="M7 8l5-5 5 5" /><path d="M5 14v5a2 2 0 002 2h10a2 2 0 002-2v-5" /></>),
  video: I(<><rect x="3" y="6" width="13" height="12" rx="2" /><path d="M16 10l5-3v10l-5-3" /></>),
  audio: I(<><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" /></>),
  eye: I(<><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>),
  close: I(<path d="M6 6l12 12M18 6L6 18" />),
  plug: I(<><path d="M9 2v6M15 2v6" /><path d="M6 8h12v3a6 6 0 01-12 0z" /><path d="M12 17v5" /></>),
};
