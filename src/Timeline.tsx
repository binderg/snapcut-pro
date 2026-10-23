// Canvas timeline. Drawing is cheap, so every change redraws everything.
// Edits are only sent on pointer-up: a drag is a local preview, then one
// edit.move / edit.trim / transition.set call, and the engine's answer
// replaces the preview.
//
// Transitions sit on the cut between two video clips, drawn below the clip
// header so the clips' own trim edges stay reachable there. Drag a
// transition's edge to change its length, its body to move it to another
// cut, or drop one from the Transitions panel onto a cut.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Engine } from "./engine";
import type { Actions } from "./Editor";
import { alignOf, Clip, Cut, cutsOf, findClip, linkedIds, maxTransition, offsetsFor, Project, shortTime, Track, Transition, TRANSITION_MIME } from "./model";
import { Icon } from "./icons";
import { markerColor } from "./LeftPanel";
import { ContextMenu, MenuItem } from "./ContextMenu";

const RULER_H = 30;
const VIDEO_H = 62;
const AUDIO_H = 42;
const LANE_GAP = 6;
const EDGE_PX = 7;
const SNAP_PX = 8;
const CELL_W = 112;
/** Header strip of a clip; transitions are drawn below it. */
const HEAD_H = 16;
/** Narrowest a transition is drawn, so a short one stays clickable when zoomed out. */
const TR_MIN_W = 18;
/** How close (px) a dragged transition must come to a cut to land on it. */
const CUT_PX = 28;

interface Sheet {
  img: HTMLImageElement;
  count: number;
  pad: number;
  cellW: number;
  cellH: number;
  rev: number;
  duration: number;
}


interface Lane {
  track: Track;
  y: number;
  h: number;
}

type Drag =
  | { kind: "scrub" }
  | {
      kind: "move";
      clip: Clip;
      ids: Set<string>;
      x0: number;
      y0: number;
      dx: number;
      lane: Lane | null;
      moved: boolean;
      /** Where the clip will land (frames), how (see `landing`), and how far other clips move. */
      dest: number;
      mode: "push" | "reorder";
      shift: Map<string, number>;
    }
  | { kind: "trim"; clip: Clip; side: "in" | "out"; x0: number; dx: number }
  | { kind: "trtrim"; tr: Transition; side: "in" | "out"; x0: number; duration: number }
  | { kind: "trmove"; tr: Transition; x0: number; y0: number; x: number; y: number; moved: boolean; target: Cut | null };

const C = {
  bg: "#141417",
  laneBg: "#1a1a1e",
  ruler: "#141417",
  tick: "#3a3a42",
  tickText: "#7c7c86",
  video: "#1f6b72",
  videoHead: "#16545a",
  audio: "#1d5a46",
  audioHead: "#164536",
  clipText: "#e6fbfc",
  sel: "#ffffff",
  linked: "rgba(255,255,255,0.45)",
  playhead: "#ffffff",
  snap: "#facc15",
  drop: "#1ccfd9",
  tr: "rgba(230, 251, 252, 0.22)",
  trLine: "rgba(230, 251, 252, 0.7)",
};

export function Timeline(props: { project: Project; engine: Engine; playhead: number; selected: string | null; actions: Actions; playing: boolean }) {
  const { project, engine, playhead, selected, actions, playing } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [ppf, setPpf] = useState(2); // pixels per frame
  const [scroll, setScroll] = useState(0); // px
  const [drag, setDrag] = useState<Drag | null>(null);
  // After a drop, keep drawing the new position until the engine's answer (a new revision) arrives,
  // so the clip does not snap back to where it was for a moment.
  const [settle, setSettle] = useState<{ rev: number; d: Drag } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: (MenuItem | "sep")[] } | null>(null);
  const [dropAt, setDropAt] = useState<{ frame: number; lane: Lane | null } | null>(null);
  const [trDrop, setTrDrop] = useState<Cut | null>(null);
  const [snapAt, setSnapAt] = useState<number | null>(null);
  const [hoverCursor, setHoverCursor] = useState("default");
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const fitted = useRef(false);
  const fps = project.fps;

  const lanes: Lane[] = useMemo(() => {
    const vids = project.tracks.filter((t) => t.kind === "video").reverse();
    const auds = project.tracks.filter((t) => t.kind === "audio");
    let y = RULER_H + 10;
    return [...vids, ...auds].map((track) => {
      const h = track.kind === "video" ? VIDEO_H : AUDIO_H;
      const lane = { track, y, h };
      y += h + LANE_GAP;
      return lane;
    });
  }, [project]);

  // Size.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const contentFrames = Math.max(project.duration, Math.round(fps * 30));
  const maxScroll = Math.max(0, contentFrames * ppf + 200 - size.w);
  const clampScroll = useCallback((s: number) => Math.max(0, Math.min(s, maxScroll)), [maxScroll]);

  const fit = useCallback(() => {
    const frames = Math.max(project.duration, Math.round(fps * 10));
    setPpf(Math.max(0.02, (size.w - 60) / frames));
    setScroll(0);
  }, [project.duration, fps, size.w]);

  // Fit once the first time there is something to show.
  useEffect(() => {
    if (!fitted.current && project.duration > 0 && size.w > 100) {
      fitted.current = true;
      fit();
    }
  }, [project.duration, size.w, fit]);

  useEffect(() => setScroll((s) => clampScroll(s)), [clampScroll]);

  // Follow the playhead while playing.
  useEffect(() => {
    if (!playing) return;
    const x = playhead * ppf - scroll;
    if (x > size.w - 40 || x < 0) setScroll(clampScroll(playhead * ppf - 40));
  }, [playhead, playing]); // eslint-disable-line react-hooks/exhaustive-deps

  // Filmstrip: one row contact sheet of the whole timeline, refreshed after edits.
  useEffect(() => {
    if (project.duration === 0) { setSheet(null); return; }
    const t = setTimeout(async () => {
      const secs = project.duration / fps;
      const count = Math.max(4, Math.min(100, Math.round(secs / 1.5)));
      try {
        const r: any = await engine.query("render.contact_sheet", { count, columns: count, width: CELL_W, format: "jpeg" });
        const img = new Image();
        img.onload = () => {
          // The sheet is `tile`d with equal padding around and between cells.
          const pad = Math.max(0, (img.width - r.columns * CELL_W) / (r.columns + 1));
          setSheet({ img, count, pad, cellW: CELL_W, cellH: img.height - 2 * pad, rev: project.revision, duration: project.duration });
        };
        img.src = `data:${r.mime};base64,${r.data}`;
      } catch {
        // thumbnails are optional
      }
    }, 1200);
    return () => clearTimeout(t);
  }, [project.revision, project.duration]); // eslint-disable-line react-hooks/exhaustive-deps

  const xOf = (f: number) => f * ppf - scroll;
  const frameOf = (x: number) => Math.max(0, Math.round((x + scroll) / ppf));
  const laneAt = (y: number) => lanes.find((l) => y >= l.y - LANE_GAP / 2 && y < l.y + l.h + LANE_GAP / 2) ?? null;

  const hit = (x: number, y: number): { clip: Clip; edge: "in" | "out" | null } | null => {
    const lane = laneAt(y);
    if (!lane || y < lane.y || y > lane.y + lane.h) return null;
    for (const c of lane.track.clips) {
      const x1 = xOf(c.start), x2 = xOf(c.end);
      if (x >= x1 - 2 && x <= x2 + 2) {
        const w = x2 - x1;
        const edgeW = Math.min(EDGE_PX, w / 3);
        const edge = x - x1 < edgeW ? "in" : x2 - x < edgeW ? "out" : null;
        return { clip: c, edge };
      }
    }
    return null;
  };

  /** Where a transition is drawn: its range around the cut, at least TR_MIN_W wide. */
  const trBox = (lane: Lane, cut: number, inOffset: number, outOffset: number) => {
    let x1 = xOf(cut - inOffset), x2 = xOf(cut + outOffset);
    if (x2 - x1 < TR_MIN_W) {
      const mid = xOf(cut) + ((outOffset - inOffset) / 2) * ppf;
      x1 = mid - TR_MIN_W / 2;
      x2 = mid + TR_MIN_W / 2;
    }
    return { x1, x2, y: lane.y + HEAD_H + 2, h: lane.h - HEAD_H - 6 };
  };

  const hitTransition = (x: number, y: number): { tr: Transition; edge: "in" | "out" | null } | null => {
    const lane = laneAt(y);
    if (!lane || lane.track.kind !== "video") return null;
    for (const tr of lane.track.transitions) {
      const b = trBox(lane, tr.cut, tr.inOffset, tr.outOffset);
      if (x < b.x1 - 3 || x > b.x2 + 3 || y < b.y || y > b.y + b.h) continue;
      const edgeW = Math.min(EDGE_PX, (b.x2 - b.x1) / 4);
      const edge = x - b.x1 < edgeW ? "in" : b.x2 - x < edgeW ? "out" : null;
      return { tr, edge };
    }
    return null;
  };

  /** The cut nearest the pointer on the video lane under it, if close enough. */
  const cutNear = (x: number, y: number): Cut | null => {
    const lane = laneAt(y);
    if (!lane || lane.track.kind !== "video") return null;
    let best: Cut | null = null, bestD = CUT_PX;
    for (const c of cutsOf(lane.track)) {
      const d = Math.abs(xOf(c.frame) - x);
      if (d <= bestD) { best = c; bestD = d; }
    }
    return best;
  };

  const laneOfTrack = (id: string) => lanes.find((l) => l.track.id === id) ?? null;

  const snapPoints = useCallback(
    (exclude: Set<string>) => {
      const pts = [0, playhead];
      for (const t of project.tracks) for (const c of t.clips) if (!exclude.has(c.id)) pts.push(c.start, c.end);
      for (const m of project.markers) pts.push(m.start, m.start + m.duration);
      return pts;
    },
    [project, playhead],
  );

  const snap = (frame: number, pts: number[]): [number, number | null] => {
    let best: number | null = null, bestD = SNAP_PX / ppf;
    for (const p of pts) {
      const d = Math.abs(p - frame);
      if (d <= bestD) { best = p; bestD = d; }
    }
    return best == null ? [frame, null] : [best, best];
  };

  // ---------- drawing ----------
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = devicePixelRatio || 1;
    if (cv.width !== Math.round(size.w * dpr) || cv.height !== Math.round(size.h * dpr)) {
      cv.width = Math.round(size.w * dpr);
      cv.height = Math.round(size.h * dpr);
    }
    const g = cv.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = C.bg;
    g.fillRect(0, 0, size.w, size.h);
    g.font = "11px 'Segoe UI', system-ui, sans-serif";
    g.textBaseline = "middle";

    // Ruler ticks: pick a step that gives ~90px between labels.
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600].map((s) => s * fps);
    const step = steps.find((s) => s * ppf >= 90) ?? steps[steps.length - 1];
    const minor = step / 5;
    const f0 = Math.floor(scroll / ppf / minor) * minor;
    g.fillStyle = C.ruler;
    g.fillRect(0, 0, size.w, RULER_H);
    for (let f = f0; xOf(f) < size.w; f += minor) {
      const x = Math.round(xOf(f)) + 0.5;
      const major = Math.abs(f / step - Math.round(f / step)) < 1e-6;
      g.strokeStyle = C.tick;
      g.beginPath();
      g.moveTo(x, major ? RULER_H - 12 : RULER_H - 5);
      g.lineTo(x, RULER_H);
      g.stroke();
      if (major) {
        g.fillStyle = C.tickText;
        g.fillText(shortTime(f, fps), x + 4, RULER_H - 14);
      }
    }

    // Lanes.
    for (const l of lanes) {
      g.fillStyle = C.laneBg;
      g.fillRect(0, l.y, size.w, l.h);
    }

    // Ranged markers (silences etc.) as bands behind the clips.
    for (const m of project.markers) {
      if (m.duration <= 0) continue;
      const x1 = xOf(m.start), x2 = xOf(m.start + m.duration);
      if (x2 < 0 || x1 > size.w) continue;
      g.fillStyle = hexA(markerColor(m.color), 0.13);
      g.fillRect(x1, RULER_H, x2 - x1, size.h - RULER_H);
    }

    const d: Drag | null = drag ?? (settle && settle.rev === project.revision ? settle.d : null);
    const dragIds = d?.kind === "move" ? d.ids : d?.kind === "trim" ? new Set([d.clip.id]) : null;
    const selIds = selected ? linkedIds(project, project.tracks.flatMap((t) => t.clips).find((c) => c.id === selected) ?? ({ id: selected } as Clip)) : new Set<string>();

    // Dragged clips go last so they draw on top of the clips they pass over.
    const order: [Lane, Clip][] = [];
    for (const l of lanes) for (const c of l.track.clips) if (!dragIds?.has(c.id) || d?.kind !== "move") order.push([l, c]);
    if (d?.kind === "move") for (const l of lanes) for (const c of l.track.clips) if (dragIds!.has(c.id)) order.push([l, c]);

    for (const [l, c] of order) {
      {
        let start = c.start, end = c.end, y = l.y, h = l.h, offset = 0;
        if (d?.kind === "move" && dragIds!.has(c.id)) {
          offset = d.dx;
          start += offset;
          end += offset;
          if (c.id === d.clip.id && d.lane && d.lane.track.kind === l.track.kind) { y = d.lane.y; h = d.lane.h; }
        } else if (d?.kind === "move" && d.shift.has(c.id)) {
          offset = d.shift.get(c.id)!;
          start += offset;
          end += offset;
        } else if (d?.kind === "trim" && c.id === d.clip.id) {
          if (d.side === "in") start = Math.min(c.end - 1, c.start + d.dx);
          else end = Math.max(c.start + 1, c.end + d.dx);
        }
        const x1 = xOf(start), x2 = xOf(end);
        if (x2 < 0 || x1 > size.w) continue;
        drawClip(g, c, x1, x2, y, h, {
          selected: c.id === selected,
          linked: selIds.has(c.id) && c.id !== selected,
          ghost: !!(drag?.kind === "move" && dragIds!.has(c.id) && drag.moved),
          sheet: c.kind === "video" && sheet ? sheet : null,
          frameAtX: (x: number) => (x + scroll) / ppf - offset,
          fps,
        });
      }
    }

    // Transitions on their cuts.
    for (const l of lanes) {
      for (const tr of l.track.transitions) {
        let inO = tr.inOffset, outO = tr.outOffset, lane = l, ghost = false;
        if (d?.kind === "trtrim" && d.tr.id === tr.id) [inO, outO] = offsetsFor(d.duration, alignOf(tr));
        if (drag?.kind === "trmove" && drag.tr.id === tr.id && drag.moved) ghost = true;
        const b = trBox(lane, tr.cut, inO, outO);
        if (b.x2 < 0 || b.x1 > size.w) continue;
        drawTransition(g, b, { selected: tr.id === selected, ghost, label: d?.kind === "trtrim" && d.tr.id === tr.id ? `${(d.duration / fps).toFixed(1)}s` : null });
      }
    }

    // A transition being moved follows the pointer; its landing cut lights up.
    if (drag?.kind === "trmove" && drag.moved) {
      const target = drag.target;
      if (target) {
        const lane = laneOfTrack(target.track.id);
        if (lane) {
          const fit = Math.min(drag.tr.inOffset + drag.tr.outOffset, Math.max(1, maxTransition(project, target, alignOf(drag.tr))));
          const [i, o] = offsetsFor(fit, alignOf(drag.tr));
          drawDropCut(g, trBox(lane, target.frame, i, o));
        }
      }
      const lane = laneOfTrack(drag.tr.trackId);
      if (lane) {
        const b = trBox(lane, drag.tr.cut, drag.tr.inOffset, drag.tr.outOffset);
        const w = b.x2 - b.x1;
        drawTransition(g, { x1: drag.x - w / 2, x2: drag.x + w / 2, y: drag.y - b.h / 2, h: b.h }, { selected: true, ghost: false, label: null });
      }
    }

    // A transition dragged in from the panel: highlight the cut it would land on.
    if (trDrop) {
      const lane = laneOfTrack(trDrop.track.id);
      if (lane) {
        const b = trDrop.transition
          ? trBox(lane, trDrop.frame, trDrop.transition.inOffset, trDrop.transition.outOffset)
          : trBox(lane, trDrop.frame, Math.round(fps / 4), Math.round(fps / 4));
        drawDropCut(g, b);
      }
    }

    // Point markers on the ruler.
    for (const m of project.markers) {
      const x = xOf(m.start);
      if (x < -10 || x > size.w + 10) continue;
      g.fillStyle = markerColor(m.color);
      g.beginPath();
      g.moveTo(x - 5, RULER_H - 12);
      g.lineTo(x + 5, RULER_H - 12);
      g.lineTo(x + 5, RULER_H - 5);
      g.lineTo(x, RULER_H);
      g.lineTo(x - 5, RULER_H - 5);
      g.closePath();
      g.fill();
    }

    // Drop indicator.
    if (dropAt) {
      const x = Math.round(xOf(dropAt.frame)) + 0.5;
      g.strokeStyle = hexA(C.drop, 0.35);
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x, RULER_H);
      g.lineTo(x, size.h);
      g.stroke();
      if (dropAt.lane) {
        // Solid on the track the clip goes to.
        g.strokeStyle = C.drop;
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(x, dropAt.lane.y - 2);
        g.lineTo(x, dropAt.lane.y + dropAt.lane.h + 2);
        g.stroke();
      }
      g.lineWidth = 1;
    }

    if (d?.kind === "move" && d.moved && drag) {
      const lane = d.lane && d.lane.track.kind === d.clip.kind ? d.lane : lanes.find((l) => l.track.id === d.clip.trackId);
      if (lane) {
        const x = Math.round(xOf(d.dest)) + 0.5;
        g.strokeStyle = C.drop;
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(x, lane.y - 2);
        g.lineTo(x, lane.y + lane.h + 2);
        g.stroke();
        g.lineWidth = 1;
      }
    }

    if (snapAt != null) {
      const x = Math.round(xOf(snapAt)) + 0.5;
      g.strokeStyle = C.snap;
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(x, RULER_H);
      g.lineTo(x, size.h);
      g.stroke();
      g.setLineDash([]);
    }

    // Playhead.
    const px = Math.round(xOf(playhead)) + 0.5;
    if (px >= -6 && px <= size.w + 6) {
      g.strokeStyle = C.playhead;
      g.beginPath();
      g.moveTo(px, 4);
      g.lineTo(px, size.h);
      g.stroke();
      g.fillStyle = C.playhead;
      g.beginPath();
      g.roundRect(px - 5, 2, 10, 13, 2);
      g.fill();
      g.beginPath();
      g.moveTo(px - 5, 14);
      g.lineTo(px + 5, 14);
      g.lineTo(px, 19);
      g.fill();
    }
  });

  // ---------- pointer ----------
  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const { x, y } = local(e);
    canvasRef.current!.setPointerCapture(e.pointerId);
    if (y < RULER_H) {
      setDrag({ kind: "scrub" });
      actions.seek(frameOf(x));
      return;
    }
    const ht = hitTransition(x, y);
    if (ht) {
      actions.select(ht.tr.id);
      if (ht.edge) setDrag({ kind: "trtrim", tr: ht.tr, side: ht.edge, x0: x, duration: ht.tr.inOffset + ht.tr.outOffset });
      else setDrag({ kind: "trmove", tr: ht.tr, x0: x, y0: y, x, y, moved: false, target: null });
      return;
    }
    const h = hit(x, y);
    if (!h) {
      actions.select(null);
      setDrag({ kind: "scrub" });
      actions.seek(frameOf(x));
      return;
    }
    actions.select(h.clip.id);
    if (h.edge) setDrag({ kind: "trim", clip: h.clip, side: h.edge, x0: x, dx: 0 });
    else setDrag({ kind: "move", clip: h.clip, ids: linkedIds(project, h.clip), x0: x, y0: y, dx: 0, lane: laneAt(y), moved: false, dest: h.clip.start, mode: "push", shift: new Map() });
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const { x, y } = local(e);
    const ht = y < RULER_H ? null : hitTransition(x, y);
    if (ht) {
      actions.select(ht.tr.id);
      setMenu({ x: e.clientX, y: e.clientY, items: [{ label: "Remove transition", hint: "Del", danger: true, run: () => actions.removeTransition(ht.tr.id) }] });
      return;
    }
    const h = y < RULER_H ? null : hit(x, y);
    if (!h) { setMenu(null); return; }
    actions.select(h.clip.id);
    setMenu({ x: e.clientX, y: e.clientY, items: menuItems(h.clip) });
  };

  const menuItems = (c: Clip): (MenuItem | "sep")[] => [
    { label: "Delete", hint: "Del", danger: true, run: () => actions.deleteClip(c.id, true) },
    { label: "Delete, leave gap", hint: "Shift+Del", danger: true, run: () => actions.deleteClip(c.id, false) },
    "sep",
    { label: "Unlink", hint: linkedIds(project, c).size > 1 ? undefined : "not linked", disabled: linkedIds(project, c).size < 2, run: () => actions.unlink(c.id) },
  ];

  // Pointer moves arrive faster than frames; each one used to re-render and redraw the whole canvas.
  // Keep only the latest point per animation frame.
  const pending = useRef<{ x: number; y: number } | null>(null);
  const raf = useRef(0);
  const applyRef = useRef<(x: number, y: number, drag: Drag) => Drag | null>(() => null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

  const onPointerMove = (e: React.PointerEvent) => {
    const { x, y } = local(e);
    if (!drag) {
      if (y < RULER_H) return setHoverCursor("pointer");
      const ht = hitTransition(x, y);
      if (ht) return setHoverCursor(ht.edge ? "ew-resize" : "grab");
      const h = hit(x, y);
      setHoverCursor(h ? (h.edge ? "ew-resize" : "grab") : "default");
      return;
    }
    pending.current = { x, y };
    if (!raf.current) {
      raf.current = requestAnimationFrame(() => {
        raf.current = 0;
        const pt = pending.current, cur = dragRef.current;
        pending.current = null;
        if (pt && cur) applyRef.current(pt.x, pt.y, cur);
      });
    }
  };

  /** Allowed edge movement in frames [min, max] for trimming `side` of a clip, from the media it has. */
  const trimRange = (c: Clip, side: "in" | "out"): [number, number] => {
    const dur = c.end - c.start;
    const asset = project.assets.find((a) => a.url === c.url);
    const speed = c.speed[0] / c.speed[1] || 1;
    if (!asset || asset.frames <= 0) return side === "in" ? [-c.start, dur - 1] : [-(dur - 1), Infinity];
    if (side === "in") {
      // Extending left uses media before the in-point; it cannot go below the source start or the timeline start.
      const more = Math.floor(c.sourceIn / speed);
      return [-Math.min(more, c.start), dur - 1];
    }
    const left = Math.floor((asset.frames - (c.sourceIn + dur * speed)) / speed);
    return [-(dur - 1), Math.max(0, left)];
  };

  /**
   * Where a dragged clip lands, decided by its leading edge (left edge moving left, right edge
   * moving right). On its own track, once that edge is past the middle of a clip it passes, the
   * two trade places (`edit.move` with `reorder`: what lies between slides over to fill the old
   * place, nothing else moves); short of the middle it goes back where it was. Elsewhere (empty
   * space, another track) it lands where it is let go and pushes what is in the way right
   * (`push`). Over a clip it never cuts it. `shift` previews how other clips move.
   */
  const landing = (drag: Extract<Drag, { kind: "move" }>, dx: number, lane: Lane | null) => {
    const c0 = drag.clip;
    const track = lane && lane.track.kind === c0.kind ? lane.track : project.tracks.find((t) => t.id === c0.trackId)!;
    const others = track.clips.filter((c) => !drag.ids.has(c.id));
    const len = c0.end - c0.start;
    const start = c0.start + dx;
    const mid = (c: Clip) => (c.start + c.end) / 2;
    const shift = new Map<string, number>();

    if (track.id === c0.trackId && dx !== 0) {
      const left = dx < 0;
      const edge = left ? start : start + len;
      const passed = left
        ? others.find((c) => c.end <= c0.start && c.start <= edge && edge < c.end)
        : others.find((c) => c.start >= c0.end && c.start < edge && edge <= c.end);
      if (passed) {
        const dest = left
          ? (edge < mid(passed) ? passed.start : passed.end)
          : (edge > mid(passed) ? passed.end - len : passed.start - len);
        if (dest !== c0.start) {
          // Rotate [lo, hi) on the clip's tracks and the tracks of anything linked to what is in it.
          const [lo, hi] = left ? [dest, c0.end] : [c0.start, dest + len];
          const split = left ? c0.start : c0.end;
          const delta = (c: Clip) => (c.start < split ? (left ? len : dest - c0.start) : left ? dest - c0.start : -len);
          const tracks = new Set(project.tracks.filter((t) => t.clips.some((c) => drag.ids.has(c.id))).map((t) => t.id));
          for (let grew = true; grew; ) {
            grew = false;
            const links = new Set<string>();
            for (const t of project.tracks) if (tracks.has(t.id)) for (const c of t.clips) if (c.start >= lo && c.start < hi && c.link) links.add(c.link);
            for (const t of project.tracks) if (!tracks.has(t.id) && t.clips.some((c) => c.link && links.has(c.link))) { tracks.add(t.id); grew = true; }
          }
          for (const t of project.tracks) {
            if (!tracks.has(t.id)) continue;
            for (const c of t.clips) if (!drag.ids.has(c.id) && c.start >= lo && c.start < hi) shift.set(c.id, delta(c));
          }
        }
        return { dest, mode: "reorder" as const, shift };
      }
    }

    // Free placement: never cut a clip the start lands in, push what is in the way.
    const under = others.find((c) => c.start < start && start < c.end);
    const dest = under ? (start < mid(under) ? under.start : under.end) : start;
    const next = Math.min(...others.filter((c) => c.start >= dest).map((c) => c.start));
    const amount = Math.max(0, dest + len - next);
    if (amount > 0 && Number.isFinite(amount)) {
      // The track itself from `dest`; other tracks from the first partner of anything that moved.
      const from = new Map<string, number>([[track.id, dest]]);
      for (let grew = true; grew; ) {
        grew = false;
        const links = new Set<string>();
        for (const t of project.tracks) {
          const f = from.get(t.id);
          if (f != null) for (const c of t.clips) if (c.start >= f && c.link && !drag.ids.has(c.id)) links.add(c.link);
        }
        for (const t of project.tracks) {
          if (t.id === track.id) continue;
          const first = Math.min(...t.clips.filter((c) => c.link && links.has(c.link) && !drag.ids.has(c.id)).map((c) => c.start));
          if (Number.isFinite(first) && (from.get(t.id) ?? Infinity) > first) { from.set(t.id, first); grew = true; }
        }
      }
      for (const t of project.tracks) {
        const f = from.get(t.id);
        if (f != null) for (const c of t.clips) if (c.start >= f && !drag.ids.has(c.id)) shift.set(c.id, amount);
      }
    }
    return { dest, mode: "push" as const, shift };
  };

  /** Apply a drag position; returns the new drag state so a release can use it at once. */
  const applyDrag = (x: number, y: number, drag: Drag): Drag | null => {
    if (drag.kind === "scrub") {
      actions.seek(frameOf(x));
    } else if (drag.kind === "move") {
      const raw = Math.round((x - drag.x0) / ppf);
      const moved = drag.moved || Math.abs(x - drag.x0) > 3 || Math.abs(y - drag.y0) > 6;
      const pts = snapPoints(drag.ids);
      // Snap whichever edge of the clip is closer to a point.
      const [s1, p1] = snap(drag.clip.start + raw, pts);
      const [s2, p2] = snap(drag.clip.end + raw, pts);
      let dx = raw, sp: number | null = null;
      if (p1 != null && (p2 == null || Math.abs(s1 - (drag.clip.start + raw)) <= Math.abs(s2 - (drag.clip.end + raw)))) { dx = s1 - drag.clip.start; sp = p1; }
      else if (p2 != null) { dx = s2 - drag.clip.end; sp = p2; }
      dx = Math.max(dx, -drag.clip.start);
      setSnapAt(moved ? sp : null);
      const lane = laneAt(y) ?? drag.lane;
      const { dest, mode, shift } = landing(drag, dx, lane);
      const next = { ...drag, dx, moved, lane, dest, mode, shift };
      setDrag(next);
      setHoverCursor("grabbing");
      return next;
    } else if (drag.kind === "trim") {
      const raw = Math.round((x - drag.x0) / ppf);
      const edge = drag.side === "in" ? drag.clip.start : drag.clip.end;
      const [s, p] = snap(edge + raw, snapPoints(new Set([drag.clip.id])));
      // A clip can't be pulled past the media it has (or shorter than one frame).
      const [lo, hi] = trimRange(drag.clip, drag.side);
      const dx = Math.max(lo, Math.min(hi, s - edge));
      setSnapAt(dx === s - edge ? p : null);
      const next = { ...drag, dx };
      setDrag(next);
      return next;
    } else if (drag.kind === "trtrim") {
      // Center-aligned transitions grow on both sides, so an edge moves half the length change.
      const align = alignOf(drag.tr);
      const raw = Math.round((x - drag.x0) / ppf) * (drag.side === "out" ? 1 : -1) * (align === "center" ? 2 : 1);
      const orig = drag.tr.inOffset + drag.tr.outOffset;
      const a = findClip(project, drag.tr.outgoing), b = findClip(project, drag.tr.incoming);
      const max = a && b ? Math.max(orig, maxTransition(project, { outgoing: a, incoming: b }, align)) : Infinity;
      const duration = Math.max(align === "center" ? 2 : 1, Math.min(max, orig + raw));
      const next = { ...drag, duration };
      setDrag(next);
      return next;
    } else if (drag.kind === "trmove") {
      const moved = drag.moved || Math.abs(x - drag.x0) > 4 || Math.abs(y - drag.y0) > 6;
      const target = moved ? cutNear(x, y) : null;
      const next = { ...drag, x, y, moved, target: target && !(target.track.id === drag.tr.trackId && target.frame === drag.tr.cut) ? target : null };
      setDrag(next);
      setHoverCursor(moved ? "grabbing" : "grab");
      return next;
    }
    return drag;
  };
  applyRef.current = applyDrag;

  const onPointerUp = () => {
    let d = drag;
    if (pending.current && drag) {
      // Use the last position the pointer reached, not the last frame drawn.
      cancelAnimationFrame(raf.current);
      raf.current = 0;
      d = applyDrag(pending.current.x, pending.current.y, drag) ?? drag;
      pending.current = null;
    }
    setDrag(null);
    setSnapAt(null);
    if (!d) return;
    if (d.kind === "move" && d.moved) {
      const track = d.lane && d.lane.track.kind === d.clip.kind && d.lane.track.id !== d.clip.trackId ? d.lane.track.name : undefined;
      if (d.dest !== d.clip.start || track) {
        // Until the engine answers, draw the clip where it lands, not where it was let go.
        setSettle({ rev: project.revision, d: { ...d, dx: d.dest - d.clip.start } });
        actions.move(d.clip.id, d.dest, track, d.mode);
      }
    } else if (d.kind === "trim" && d.dx !== 0) {
      setSettle({ rev: project.revision, d });
      actions.trim(d.clip.id, d.side, d.dx);
    } else if (d.kind === "trtrim" && d.duration !== d.tr.inOffset + d.tr.outOffset) {
      setSettle({ rev: project.revision, d });
      actions.setTransition(d.tr.id, { duration: d.duration });
    } else if (d.kind === "trmove" && d.moved && d.target) {
      actions.moveTransition(d.tr, d.target);
    }
  };

  // The drop is settled once the project moves on, or if the engine refused it (no new revision).
  useEffect(() => {
    if (!settle) return;
    if (settle.rev !== project.revision) { setSettle(null); return; }
    const t = setTimeout(() => setSettle(null), 4000);
    return () => clearTimeout(t);
  }, [settle, project.revision]);
  useEffect(() => { if (engine.error) setSettle(null); }, [engine.error]);

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      const { x } = local(e);
      const f = (x + scroll) / ppf;
      const next = Math.max(0.02, Math.min(40, ppf * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      setPpf(next);
      setScroll(Math.max(0, f * next - x));
    } else {
      setScroll((s) => clampScroll(s + (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY)));
    }
  };

  // Prevent the page zooming on ctrl+wheel.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const stop = (e: WheelEvent) => (e.ctrlKey || e.metaKey) && e.preventDefault();
    el.addEventListener("wheel", stop, { passive: false });
    return () => el.removeEventListener("wheel", stop);
  }, []);

  // ---------- drop from the media panel ----------
  /**
   * Where a media drop lands. The picture (or, for audio-only media, the sound) goes on the lane under
   * the pointer if it is the right kind, else on the first track of that kind, as the engine does.
   * Over a clip it never cuts it: the front half puts the new clip before it, the back half after it.
   * The engine pushes later clips on that track, and their linked partners, to make room.
   */
  const dropTarget = (x: number, y: number, kind: "video" | "audio") => {
    const lane = laneAt(y);
    const track = lane && lane.track.kind === kind ? lane.track : project.tracks.find((t) => t.kind === kind) ?? null;
    const raw = frameOf(x);
    const over = track?.clips.find((c) => c.start < raw && raw < c.end);
    const frame = over ? (raw - over.start < (over.end - over.start) / 2 ? over.start : over.end) : snap(raw, snapPoints(new Set()))[0];
    return { frame, lane: track ? lanes.find((l) => l.track.id === track.id) ?? null : null };
  };

  const onDragOver = (e: React.DragEvent) => {
    const types = e.dataTransfer.types;
    if (types.includes(TRANSITION_MIME)) {
      e.preventDefault();
      const { x, y } = local(e);
      const cut = cutNear(x, y);
      e.dataTransfer.dropEffect = cut ? "copy" : "none";
      setTrDrop((prev) => (prev?.track.id === cut?.track.id && prev?.frame === cut?.frame ? prev : cut));
      return;
    }
    if (!types.includes("application/x-ve-asset")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const { x, y } = local(e);
    setDropAt(dropTarget(x, y, types.includes("application/x-ve-asset-audio") ? "audio" : "video"));
  };
  const onDrop = (e: React.DragEvent) => {
    const trData = e.dataTransfer.getData(TRANSITION_MIME);
    if (trData) {
      e.preventDefault();
      const cut = trDrop;
      setTrDrop(null);
      if (!cut) return;
      try {
        const { transition, duration } = JSON.parse(trData) as { transition: string; duration?: string };
        actions.addTransition(transition, cut, duration);
      } catch {
        // not ours
      }
      return;
    }
    const id = e.dataTransfer.getData("application/x-ve-asset");
    setDropAt(null);
    if (!id) return;
    e.preventDefault();
    const asset = project.assets.find((a) => a.id === id);
    const { x, y } = local(e);
    const d = dropTarget(x, y, asset?.video ? "video" : "audio");
    actions.insert(id, d.frame, d.lane?.track.name);
  };

  const sel = selected != null;
  const scrollThumbW = Math.max(30, size.w * (size.w / (maxScroll + size.w)));
  const scrollThumbX = maxScroll > 0 ? (scroll / maxScroll) * (size.w - scrollThumbW) : 0;

  return (
    <section className="panel timeline">
      <div className="toolbar">
        <button className="icon-btn on" data-tip="Select"><Icon.pointer /></button>
        <span className="sep" />
        <button className="icon-btn" onClick={actions.undo} disabled={!engine.history.undo.length} data-tip="Undo (Ctrl+Z)"><Icon.undo /></button>
        <button className="icon-btn" onClick={actions.redo} disabled={!engine.history.redo.length} data-tip="Redo (Ctrl+Shift+Z)"><Icon.redo /></button>
        <span className="sep" />
        <button className="icon-btn" onClick={actions.split} disabled={project.duration === 0} data-tip="Split (Ctrl+B)"><Icon.split /></button>
        <button className="icon-btn" onClick={actions.deleteLeft} disabled={project.duration === 0} data-tip="Delete left (Q)"><Icon.delLeft /></button>
        <button className="icon-btn" onClick={actions.deleteRight} disabled={project.duration === 0} data-tip="Delete right (W)"><Icon.delRight /></button>
        <button className="icon-btn" onClick={actions.rippleDelete} disabled={!sel} data-tip="Delete, close gap (Del). Shift+Del leaves a gap"><Icon.trash /></button>
        <span className="sep" />
        <button className="icon-btn" onClick={actions.addMarker} data-tip="Add marker (M)"><Icon.marker /></button>
        <span className="spacer" />
        <span className="muted mono" style={{ fontSize: 12, marginRight: 8 }}>{project.tracks.reduce((n, t) => n + t.clips.length, 0)} clips</span>
        <button className="icon-btn" onClick={fit} data-tip="Fit timeline"><Icon.fit /></button>
        <div className="zoom">
          <button className="icon-btn" onClick={() => setPpf((p) => Math.max(0.02, p / 1.4))}><Icon.zoomOut /></button>
          <input type="range" min={0} max={100} value={Math.round((Math.log(ppf / 0.02) / Math.log(40 / 0.02)) * 100)}
            onChange={(e) => {
              const next = 0.02 * Math.pow(40 / 0.02, Number(e.target.value) / 100);
              const centre = (size.w / 2 + scroll) / ppf;
              setPpf(next);
              setScroll(Math.max(0, centre * next - size.w / 2));
            }} />
          <button className="icon-btn" onClick={() => setPpf((p) => Math.min(40, p * 1.4))}><Icon.zoomIn /></button>
        </div>
      </div>
      <div className="tl-body">
        <div className="tl-heads" style={{ paddingTop: RULER_H + 10 }}>
          {lanes.map((l) => (
            <div key={l.track.id} className="tl-head" style={{ height: l.h, marginBottom: LANE_GAP }}>
              <span className="nm">{l.track.name}</span>
              <span style={{ width: 16, height: 16, display: "grid", placeItems: "center" }}>{l.track.kind === "video" ? <Icon.video /> : <Icon.audio />}</span>
            </div>
          ))}
        </div>
        <div className="tl-canvas-wrap" ref={wrapRef}>
          <canvas
            ref={canvasRef}
            style={{ width: size.w, height: size.h, cursor: hoverCursor }}
            onPointerDown={onPointerDown}
            onContextMenu={onContextMenu}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={onWheel}
            onDragOver={onDragOver}
            onDragLeave={() => { setDropAt(null); setTrDrop(null); }}
            onDrop={onDrop}
            onDoubleClick={(e) => {
              const { x, y } = local(e);
              if (!hit(x, y) && y > RULER_H) fit();
            }}
          />
          {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
          {project.duration === 0 && (
            <div style={{ position: "absolute", left: 24, top: RULER_H + 24, color: "var(--faint)", pointerEvents: "none" }}>
              Drag media here to start
            </div>
          )}
        </div>
      </div>
      <div className="tl-scroll">
        {maxScroll > 0 && (
          <div
            className="thumb"
            style={{ left: scrollThumbX, width: scrollThumbW }}
            onPointerDown={(e) => {
              const x0 = e.clientX, s0 = scroll;
              const k = maxScroll / Math.max(1, size.w - scrollThumbW);
              const mv = (ev: PointerEvent) => setScroll(clampScroll(s0 + (ev.clientX - x0) * k));
              const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
              window.addEventListener("pointermove", mv);
              window.addEventListener("pointerup", up);
            }}
          />
        )}
      </div>
    </section>
  );
}

function drawClip(
  g: CanvasRenderingContext2D,
  c: Clip,
  x1: number,
  x2: number,
  y: number,
  h: number,
  o: {
    selected: boolean;
    linked: boolean;
    ghost: boolean;
    sheet: Sheet | null;
    frameAtX: (x: number) => number;
    fps: number;
  },
) {
  const w = Math.max(1, x2 - x1 - 1);
  const video = c.kind === "video";
  g.save();
  g.globalAlpha = o.ghost ? 0.75 : 1;
  g.beginPath();
  g.roundRect(x1, y, w, h, 4);
  g.clip();
  g.fillStyle = video ? C.video : C.audio;
  g.fillRect(x1, y, w, h);

  const headH = 16;
  if (video && o.sheet && w > 6) {
    // Fixed-aspect tiles; each shows the sheet frame nearest its time.
    const s = o.sheet;
    const th = h - headH;
    const tw = th * (s.cellW / s.cellH);
    for (let x = x1; x < x2; x += tw) {
      const f = o.frameAtX(x + tw / 2);
      const i = Math.max(0, Math.min(s.count - 1, Math.floor((f / s.duration) * s.count)));
      g.drawImage(s.img, s.pad + i * (s.cellW + s.pad), s.pad, s.cellW, s.cellH, x, y + headH, tw, th);
    }
  } else if (!video) {
    // No waveform data from the engine yet: a centre line, not a fake wave.
    g.strokeStyle = "rgba(160, 240, 205, 0.35)";
    g.beginPath();
    g.moveTo(x1, y + h / 2 + 6);
    g.lineTo(x2, y + h / 2 + 6);
    g.stroke();
  }

  g.fillStyle = video ? C.videoHead : C.audioHead;
  g.fillRect(x1, y, w, headH);
  if (w > 30) {
    g.fillStyle = C.clipText;
    g.font = "11px 'Segoe UI', system-ui, sans-serif";
    const speed = c.speed[0] !== c.speed[1] ? `  ${+(c.speed[0] / c.speed[1]).toFixed(2)}x` : "";
    const vol = !video && c.volumeDb !== 0 ? `  ${c.volumeDb > 0 ? "+" : ""}${c.volumeDb} dB` : "";
    const dur = `  ${((c.end - c.start) / o.fps).toFixed(1)}s`;
    g.fillText(fitText(g, c.name + speed + vol + dur, w - 10), x1 + 6, y + headH / 2 + 1);
  }
  g.restore();

  if (o.selected || o.linked) {
    g.strokeStyle = o.selected ? C.sel : C.linked;
    g.lineWidth = o.selected ? 2 : 1;
    g.beginPath();
    g.roundRect(x1 + 1, y + 1, w - 2, h - 2, 4);
    g.stroke();
    g.lineWidth = 1;
    if (o.selected && w > 16) {
      // Trim handles.
      g.fillStyle = C.sel;
      g.fillRect(x1 + 1, y + h / 2 - 8, 3, 16);
      g.fillRect(x1 + w - 4, y + h / 2 - 8, 3, 16);
    }
  }
}

type Box = { x1: number; x2: number; y: number; h: number };

/** A transition: a translucent block over the cut with a bow-tie mark, like CapCut's. */
function drawTransition(g: CanvasRenderingContext2D, b: Box, o: { selected: boolean; ghost: boolean; label: string | null }) {
  const w = b.x2 - b.x1;
  g.save();
  g.globalAlpha = o.ghost ? 0.35 : 1;
  g.fillStyle = "rgba(10, 30, 34, 0.55)";
  g.beginPath();
  g.roundRect(b.x1, b.y, w, b.h, 4);
  g.fill();
  g.fillStyle = C.tr;
  g.fill();
  g.strokeStyle = o.selected ? C.sel : C.trLine;
  g.lineWidth = o.selected ? 2 : 1;
  g.beginPath();
  g.roundRect(b.x1 + 0.5, b.y + 0.5, w - 1, b.h - 1, 4);
  g.stroke();
  // Bow tie in the middle.
  const cx = (b.x1 + b.x2) / 2, cy = b.y + b.h / 2, r = Math.min(6, w / 3, b.h / 3);
  if (r >= 3) {
    g.fillStyle = C.clipText;
    g.beginPath();
    g.moveTo(cx - r, cy - r);
    g.lineTo(cx, cy);
    g.lineTo(cx - r, cy + r);
    g.closePath();
    g.moveTo(cx + r, cy - r);
    g.lineTo(cx, cy);
    g.lineTo(cx + r, cy + r);
    g.closePath();
    g.fill();
  }
  if (o.selected && w > 14) {
    // Length handles.
    g.fillStyle = C.sel;
    g.fillRect(b.x1 + 1, cy - 7, 3, 14);
    g.fillRect(b.x2 - 4, cy - 7, 3, 14);
  }
  g.restore();
  if (o.label) {
    g.save();
    g.font = "11px 'Segoe UI', system-ui, sans-serif";
    const tw = g.measureText(o.label).width + 10;
    const lx = (b.x1 + b.x2) / 2 - tw / 2, ly = b.y - 20;
    g.fillStyle = "rgba(0,0,0,0.8)";
    g.beginPath();
    g.roundRect(lx, ly, tw, 16, 3);
    g.fill();
    g.fillStyle = C.clipText;
    g.textBaseline = "middle";
    g.fillText(o.label, lx + 5, ly + 8.5);
    g.restore();
  }
}

/** Where a dragged transition would land. */
function drawDropCut(g: CanvasRenderingContext2D, b: Box) {
  g.save();
  g.fillStyle = "rgba(28, 207, 217, 0.25)";
  g.strokeStyle = C.drop;
  g.lineWidth = 2;
  g.beginPath();
  g.roundRect(b.x1, b.y, b.x2 - b.x1, b.h, 4);
  g.fill();
  g.stroke();
  g.restore();
}

function fitText(g: CanvasRenderingContext2D, s: string, w: number) {
  if (g.measureText(s).width <= w) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (g.measureText(s.slice(0, mid) + "…").width <= w) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? s.slice(0, lo) + "…" : "";
}

function hexA(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}


