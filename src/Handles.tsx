// Move, resize and rotate video clips right in the player.
//
// Click the picture to select the top clip under the pointer; drag it to
// move, drag a corner to resize (around its center), drag the knob above
// it to rotate (Shift: 15° steps). Moves snap to the canvas center and
// edges. Only the outline moves while dragging; the edit is one
// `edit.set_transform` call when the pointer is let go, and the frame
// re-renders then.

import { useRef, useState } from "react";
import type { Actions } from "./Editor";
import { Clip, corners, hitsPlacement, Placement, placement, Project, TransformField } from "./model";

/** Screen pixels within which a move snaps to a guide. */
const SNAP_PX = 8;
/** How far the rotation knob sits above the picture, in screen pixels. */
const KNOB_PX = 26;

type Drag =
  | { kind: "move"; clip: Clip; pl: Placement; x0: number; y0: number; dx: number; dy: number; guides: Guide[] }
  | { kind: "scale"; clip: Clip; pl: Placement; d0: number; scale: number }
  | { kind: "rotate"; clip: Clip; pl: Placement; a0: number; rotation: number };

type Guide = { axis: "x" | "y"; at: number };

export function Handles({ project, playhead, selected, actions, w, h }: { project: Project; playhead: number; selected: string | null; actions: Actions; w: number; h: number }) {
  const ref = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const k = w / project.width; // screen px per canvas px

  // Clips on the picture at the playhead, top layer first.
  const layers: { clip: Clip; pl: Placement }[] = [];
  const videos = project.tracks.filter((t) => t.kind === "video" && t.enabled);
  for (let i = videos.length - 1; i >= 0; i--) {
    const c = videos[i].clips.find((c) => c.start <= playhead && playhead < c.end);
    const pl = c && placement(project, c, playhead);
    if (c && pl) layers.push({ clip: c, pl });
  }
  const sel = layers.find((l) => l.clip.id === selected) ?? null;

  const canvasPoint = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / k, (e.clientY - r.top) / k] as const;
  };
  const keyed = (c: Clip, f: TransformField) => c.transform?.keyframed.includes(f) ?? false;

  /** The placement while dragging (what the outline shows). */
  const live = (l: { clip: Clip; pl: Placement }): Placement => {
    if (!drag || drag.clip.id !== l.clip.id) return l.pl;
    const pl = drag.pl;
    if (drag.kind === "move") return { ...pl, cx: pl.cx + drag.dx, cy: pl.cy + drag.dy };
    if (drag.kind === "scale") {
      const f = drag.scale / pl.t.scale;
      return { ...pl, w: pl.w * f, h: pl.h * f, t: { ...pl.t, scale: drag.scale } };
    }
    return { ...pl, rotation: drag.rotation };
  };

  const begin = (e: React.PointerEvent, d: Drag) => {
    e.stopPropagation();
    e.preventDefault();
    ref.current!.setPointerCapture(e.pointerId);
    setDrag(d);
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const [x, y] = canvasPoint(e);
    const hit = layers.find((l) => hitsPlacement(l.pl, x, y));
    if (!hit) { actions.select(null); return; }
    actions.select(hit.clip.id);
    if (keyed(hit.clip, "x") || keyed(hit.clip, "y")) return;
    begin(e, { kind: "move", clip: hit.clip, pl: hit.pl, x0: x, y0: y, dx: 0, dy: 0, guides: [] });
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const [x, y] = canvasPoint(e);
    const pl = drag.pl;
    if (drag.kind === "move") {
      let dx = x - drag.x0, dy = y - drag.y0;
      const guides: Guide[] = [];
      if (!e.altKey) {
        // Snap the picture's center or its visible edges to the canvas center and edges.
        const tol = SNAP_PX / k;
        const cs = corners({ ...pl, cx: pl.cx + dx, cy: pl.cy + dy });
        const xs = cs.map((c) => c[0]), ys = cs.map((c) => c[1]);
        const snapAxis = (axis: "x" | "y", vals: number[], targets: number[]) => {
          let best: [number, number] | null = null;
          for (const v of vals) for (const t of targets) if (Math.abs(t - v) <= tol && (!best || Math.abs(t - v) < Math.abs(best[0]))) best = [t - v, t];
          if (best) guides.push({ axis, at: best[1] });
          return best ? best[0] : 0;
        };
        dx += snapAxis("x", [pl.cx + dx, Math.min(...xs), Math.max(...xs)], [project.width / 2, 0, project.width]);
        dy += snapAxis("y", [pl.cy + dy, Math.min(...ys), Math.max(...ys)], [project.height / 2, 0, project.height]);
      }
      setDrag({ ...drag, dx, dy, guides });
    } else if (drag.kind === "scale") {
      const d = Math.hypot(x - pl.cx, y - pl.cy);
      const scale = Math.max(0.02, Math.min(20, (pl.t.scale * d) / Math.max(1, drag.d0)));
      setDrag({ ...drag, scale: Math.round(scale * 1000) / 1000 });
    } else {
      const a = (Math.atan2(y - pl.cy, x - pl.cx) * 180) / Math.PI;
      let rot = pl.t.rotation + (a - drag.a0);
      rot = ((((rot + 180) % 360) + 360) % 360) - 180;
      if (e.shiftKey) rot = Math.round(rot / 15) * 15;
      else for (const s of [-180, -90, 0, 90, 180]) if (Math.abs(rot - s) < 3) rot = s;
      setDrag({ ...drag, rotation: Math.round(rot * 10) / 10 });
    }
  };

  const onUp = () => {
    const d = drag;
    setDrag(null);
    if (!d) return;
    const r4 = (v: number) => Math.round(v * 10000) / 10000;
    if (d.kind === "move" && (d.dx !== 0 || d.dy !== 0)) {
      actions.setTransform(d.clip.id, { x: r4(d.pl.t.x + d.dx / project.width), y: r4(d.pl.t.y + d.dy / project.height) });
    } else if (d.kind === "scale" && d.scale !== d.pl.t.scale) {
      actions.setTransform(d.clip.id, { scale: d.scale });
    } else if (d.kind === "rotate" && d.rotation !== d.pl.t.rotation) {
      actions.setTransform(d.clip.id, { rotation: d.rotation });
    }
  };

  const outline = sel ? live(sel) : null;
  const pts = outline ? corners(outline).map(([x, y]) => [x * k, y * k] as const) : [];
  // The knob sits above the middle of the top edge, pointing away from the center.
  const knob = (() => {
    if (!outline || pts.length < 4) return null;
    const mx = (pts[0][0] + pts[1][0]) / 2, my = (pts[0][1] + pts[1][1]) / 2;
    const r = (outline.rotation * Math.PI) / 180;
    return { mx, my, x: mx + Math.sin(r) * KNOB_PX, y: my - Math.cos(r) * KNOB_PX };
  })();
  const label = drag?.kind === "scale" ? `${Math.round(drag.scale * 100)}%` : drag?.kind === "rotate" ? `${drag.rotation}°` : null;

  return (
    <svg
      ref={ref}
      className="handles"
      width={w}
      height={h}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      style={{ cursor: drag?.kind === "move" ? "grabbing" : "default" }}
    >
      {drag?.kind === "move" &&
        drag.guides.map((g, i) =>
          g.axis === "x"
            ? <line key={i} className="guide" x1={g.at * k} x2={g.at * k} y1={0} y2={h} />
            : <line key={i} className="guide" x1={0} x2={w} y1={g.at * k} y2={g.at * k} />,
        )}
      {sel && outline && (
        <g>
          <polygon className="outline" points={pts.map((p) => p.join(",")).join(" ")} style={{ cursor: keyed(sel.clip, "x") || keyed(sel.clip, "y") ? "not-allowed" : "move" }} />
          {knob && !keyed(sel.clip, "rotation") && (
            <>
              <line className="outline" x1={knob.mx} y1={knob.my} x2={knob.x} y2={knob.y} />
              <circle
                className="knob"
                cx={knob.x}
                cy={knob.y}
                r={6}
                onPointerDown={(e) => {
                  const [x, y] = canvasPoint(e);
                  begin(e, { kind: "rotate", clip: sel.clip, pl: sel.pl, a0: (Math.atan2(y - sel.pl.cy, x - sel.pl.cx) * 180) / Math.PI, rotation: sel.pl.t.rotation });
                }}
              />
            </>
          )}
          {!keyed(sel.clip, "scale") &&
            pts.map(([x, y], i) => (
              <rect
                key={i}
                className="corner"
                x={x - 5}
                y={y - 5}
                width={10}
                height={10}
                style={{ cursor: i % 2 === 0 ? "nwse-resize" : "nesw-resize" }}
                onPointerDown={(e) => {
                  const [px, py] = canvasPoint(e);
                  begin(e, { kind: "scale", clip: sel.clip, pl: sel.pl, d0: Math.hypot(px - sel.pl.cx, py - sel.pl.cy), scale: sel.pl.t.scale });
                }}
              />
            ))}
          {label && knob && <text className="hlabel" x={knob.x + 12} y={knob.y + 4}>{label}</text>}
        </g>
      )}
    </svg>
  );
}
