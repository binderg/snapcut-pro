// In-app drag and drop on pointer events. HTML5 drag events never reach the
// page in the Tauri window (it has `dragDropEnabled` on for OS file drops,
// and on Windows that swallows them), so cards dragged to the timeline track
// the pointer themselves: a ghost follows it and drop targets get
// over/leave/drop calls with client coordinates.

export type Payload =
  | { kind: "asset"; id: string }
  | { kind: "transition"; transition: string; duration?: string };

export interface DropTarget {
  el: () => HTMLElement | null;
  over: (p: Payload, clientX: number, clientY: number) => void;
  leave: () => void;
  drop: (p: Payload, clientX: number, clientY: number) => void;
}

const targets = new Set<DropTarget>();

export function addDropTarget(t: DropTarget): () => void {
  targets.add(t);
  return () => targets.delete(t);
}

const inside = (el: HTMLElement | null, x: number, y: number) => {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return x >= r.left && x < r.right && y >= r.top && y < r.bottom;
};

/** True for a moment after a drag ends, so the card's click handler can ignore it. */
let justDragged = false;
export const wasDrag = () => justDragged;

/**
 * Call from a card's onPointerDown. The drag starts once the pointer moves a few
 * pixels; a plain click stays a click.
 */
export function beginDrag(e: React.PointerEvent, payload: Payload, label: string) {
  if (e.button !== 0) return;
  const x0 = e.clientX, y0 = e.clientY;
  let ghost: HTMLDivElement | null = null;
  let current: DropTarget | null = null;

  const move = (ev: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      ghost = document.createElement("div");
      ghost.className = "drag-ghost";
      ghost.textContent = label;
      document.body.appendChild(ghost);
      document.body.classList.add("dragging");
    }
    ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 12}px)`;
    const t = [...targets].find((t) => inside(t.el(), ev.clientX, ev.clientY)) ?? null;
    if (current && current !== t) current.leave();
    current = t;
    t?.over(payload, ev.clientX, ev.clientY);
    ghost.classList.toggle("ok", !!t);
  };
  const end = (ev: PointerEvent, drop: boolean) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", esc);
    if (!ghost) return;
    ghost.remove();
    document.body.classList.remove("dragging");
    justDragged = true;
    setTimeout(() => (justDragged = false), 0);
    if (current) {
      if (drop) current.drop(payload, ev.clientX, ev.clientY);
      else current.leave();
    }
  };
  const up = (ev: PointerEvent) => end(ev, true);
  const cancel = (ev: PointerEvent) => end(ev, false);
  const esc = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") end(new PointerEvent("pointercancel"), false);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", esc);
}
