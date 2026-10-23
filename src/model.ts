// A read-only view of the OTIO project for drawing. All UI positions are
// whole frames at the project rate; commands send them back as `f<frame>`,
// so the engine does the exact math and the UI never invents fractions.

export type Rational = [number, number];

export interface Asset {
  id: string;
  url: string;
  name: string;
  kind: string;
  frames: number; // duration at the project rate
  video?: { width: number; height: number; codec: string; rate: Rational; rotation?: number; vfr?: boolean };
  audio?: { codec: string; sample_rate: number; channels: number };
  size: number;
}

export interface Clip {
  id: string;
  name: string;
  trackId: string;
  trackName: string;
  kind: "video" | "audio";
  start: number;
  end: number;
  sourceIn: number; // in project frames, for display
  link?: string;
  speed: Rational;
  volumeDb: number;
  url?: string;
  /** Placement on the canvas (video clips); `null` is the default: fitted, centered, opaque. */
  transform: ClipTransform | null;
}

/** `metadata.ve.clip.transform`; see the engine's `edit.set_transform`. */
export interface ClipTransform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  crop_left: number;
  crop_right: number;
  crop_top: number;
  crop_bottom: number;
  /** Fields animated by keyframes (their value above is the base, used without keys). */
  keyframed: string[];
  /** Field -> keyframes, times in seconds from the clip's start. */
  keys: Record<string, { t: number; v: number; ease: string }[]>;
}

export type TransformField = Exclude<keyof ClipTransform, "keyframed" | "keys">;

export const DEFAULT_TRANSFORM: ClipTransform = {
  x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, crop_left: 0, crop_right: 0, crop_top: 0, crop_bottom: 0, keyframed: [], keys: {},
};

function parseTransform(t: any): ClipTransform | null {
  if (!t || typeof t !== "object") return null;
  const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const D = DEFAULT_TRANSFORM;
  return {
    x: n(t.x, D.x), y: n(t.y, D.y), scale: n(t.scale, D.scale), rotation: n(t.rotation, D.rotation), opacity: n(t.opacity, D.opacity),
    crop_left: n(t.crop_left, 0), crop_right: n(t.crop_right, 0), crop_top: n(t.crop_top, 0), crop_bottom: n(t.crop_bottom, 0),
    keyframed: Object.entries(t.keyframes ?? {}).filter(([, k]) => Array.isArray(k) && k.length > 0).map(([f]) => f),
    keys: Object.fromEntries(
      Object.entries(t.keyframes ?? {})
        .filter(([, k]) => Array.isArray(k) && k.length > 0)
        .map(([f, k]) => [f, (k as any[]).map((x) => ({ t: secs(x.t), v: Number(x.v), ease: x.ease ?? "linear" })).sort((a, b) => a.t - b.t)]),
    ),
  };
}

/** The transform at `local` seconds into the clip, keyframes evaluated like the engine (linear or hold). */
export function transformAt(t: ClipTransform, local: number): ClipTransform {
  const out = { ...t };
  for (const [field, keys] of Object.entries(t.keys)) {
    if (!keys.length) continue;
    let v = keys[keys.length - 1].v;
    if (local <= keys[0].t) v = keys[0].v;
    else {
      for (let i = 0; i + 1 < keys.length; i++) {
        const a = keys[i], b = keys[i + 1];
        if (local < b.t) {
          v = a.ease === "hold" || b.t <= a.t ? a.v : a.v + ((b.v - a.v) * (local - a.t)) / (b.t - a.t);
          break;
        }
      }
    }
    (out as any)[field] = v;
  }
  return out;
}

/** `av_rescale` rounding, as the engine's fit uses. */
const rescale = (a: number, b: number, c: number) => Math.floor((a * b * 2 + c) / (2 * c));

/**
 * Where a video clip's picture is on the canvas at the playhead, in canvas pixels, matching the
 * engine (`ve-render::compose::layout`): fitted and centered with even sizes, then scaled around
 * its center, moved by canvas fractions, cropped and turned. `null` if its size is unknown.
 */
export interface Placement {
  /** Center of the whole (uncropped) picture. */
  cx: number;
  cy: number;
  /** Whole picture size. */
  w: number;
  h: number;
  /** Fitted size before scale (what scale 1 means). */
  baseW: number;
  baseH: number;
  /** Degrees, clockwise. */
  rotation: number;
  t: ClipTransform;
}

export function placement(p: Project, c: Clip, frame: number): Placement | null {
  const a = p.assets.find((x) => x.url === c.url)?.video;
  if (!a) return null;
  const turned = Math.abs(a.rotation ?? 0) % 180 === 90;
  const [sw0, sh0] = turned ? [a.height, a.width] : [a.width, a.height];
  const cw = p.width, ch = p.height;
  const sw = Math.max(2, Math.floor(Math.min(rescale(ch, sw0, sh0), cw) / 2) * 2);
  const sh = Math.max(2, Math.floor(Math.min(rescale(cw, sh0, sw0), ch) / 2) * 2);
  const x = Math.floor((cw - sw) / 2) & ~1, y = Math.floor((ch - sh) / 2) & ~1;
  const t = transformAt(c.transform ?? DEFAULT_TRANSFORM, (frame - c.start) / p.fps);
  return { cx: x + sw / 2 + t.x * cw, cy: y + sh / 2 + t.y * ch, w: sw * t.scale, h: sh * t.scale, baseW: sw, baseH: sh, rotation: t.rotation, t };
}

/** The four visible corners (crop applied) of a placement: top left, top right, bottom right, bottom left. */
export function corners(pl: Placement): [number, number][] {
  const { t } = pl;
  const x0 = -pl.w / 2 + t.crop_left * pl.w, x1 = pl.w / 2 - t.crop_right * pl.w;
  const y0 = -pl.h / 2 + t.crop_top * pl.h, y1 = pl.h / 2 - t.crop_bottom * pl.h;
  const r = (pl.rotation * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  return ([[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as [number, number][]).map(([x, y]) => [pl.cx + x * cos - y * sin, pl.cy + x * sin + y * cos]);
}

/** Whether canvas point (px, py) is on the visible picture. */
export function hitsPlacement(pl: Placement, px: number, py: number): boolean {
  const r = (-pl.rotation * Math.PI) / 180;
  const dx = px - pl.cx, dy = py - pl.cy;
  const x = dx * Math.cos(r) - dy * Math.sin(r), y = dx * Math.sin(r) + dy * Math.cos(r);
  const { t } = pl;
  return x >= -pl.w / 2 + t.crop_left * pl.w && x <= pl.w / 2 - t.crop_right * pl.w && y >= -pl.h / 2 + t.crop_top * pl.h && y <= pl.h / 2 - t.crop_bottom * pl.h;
}

export interface Track {
  id: string;
  name: string;
  kind: "video" | "audio";
  clips: Clip[];
  transitions: Transition[];
  end: number;
  /** False when hidden (video) or muted (audio): renders skip it. */
  enabled: boolean;
}

/** An OTIO Transition on a cut: it reaches `inOffset` frames before the cut and `outOffset` after. */
export interface Transition {
  id: string;
  /** Engine reference, e.g. `core.transition/wipe@1`. */
  kind: string;
  params: Record<string, unknown>;
  trackId: string;
  trackName: string;
  cut: number;
  inOffset: number;
  outOffset: number;
  start: number;
  end: number;
  outgoing: string;
  incoming: string;
}

export type Align = "center" | "start" | "end";

/** The alignment the engine infers from the offsets (same rule as `transition.set`). */
export const alignOf = (t: { inOffset: number; outOffset: number }): Align =>
  t.inOffset === 0 ? "start" : t.outOffset === 0 ? "end" : "center";

/** `(inOffset, outOffset)` for a duration, split like the engine does (center: the shorter half before the cut). */
export function offsetsFor(duration: number, align: Align): [number, number] {
  const d = Math.max(1, Math.round(duration));
  if (align === "start") return [0, d];
  if (align === "end") return [d, 0];
  const half = Math.floor(d / 2);
  return [half, d - half];
}

export interface Marker {
  id: string;
  name: string;
  color: string;
  comment: string;
  start: number;
  duration: number;
  source: string;
}

export interface Project {
  name: string;
  revision: number;
  fps: number;
  rate: Rational;
  width: number;
  height: number;
  sampleRate: number;
  tracks: Track[];
  markers: Marker[];
  assets: Asset[];
  duration: number;
}

interface RT {
  value: number;
  rate: number;
}

const secs = (t: RT | null | undefined) => (t && t.rate ? t.value / t.rate : 0);

export function parseProject(doc: { revision: number; timeline: any }): Project {
  const tl = doc.timeline;
  const ve = tl.metadata?.ve ?? {};
  const out = ve.project?.output ?? {};
  const rate: Rational = out.rate ?? [30, 1];
  const fps = rate[0] / rate[1];
  const toFrames = (s: number) => Math.round(s * fps);

  const assets: Asset[] = (ve.assets ?? []).map((a: any) => ({
    id: a.id,
    url: a.url,
    name: decodeURIComponent(String(a.url).split("/").pop() ?? a.id),
    kind: a.kind,
    frames: toFrames(secs(a.media?.duration)),
    video: a.media?.video ?? undefined,
    audio: a.media?.audio ?? undefined,
    size: a.media?.size_bytes ?? 0,
  }));

  const tracks: Track[] = [];
  for (const t of tl.tracks?.children ?? []) {
    if (t.OTIO_SCHEMA?.startsWith("Track") !== true) continue;
    const kind = t.kind === "Audio" ? "audio" : "video";
    const id = t.metadata?.ve?.track?.id ?? t.name;
    const track: Track = { id, name: t.name, kind, clips: [], transitions: [], end: 0, enabled: t.enabled !== false };
    let pos = 0; // seconds; rounded per item so long timelines don't drift
    for (const item of t.children ?? []) {
      const schema: string = item.OTIO_SCHEMA ?? "";
      if (schema.startsWith("Transition")) {
        // Takes no time in OTIO; it sits between the outgoing and incoming clip.
        const m = item.metadata?.ve?.transition ?? {};
        const cut = toFrames(pos);
        const inOffset = toFrames(secs(item.in_offset));
        const outOffset = toFrames(secs(item.out_offset));
        track.transitions.push({
          id: m.id ?? `${id}:tr${track.transitions.length}`,
          kind: m.transition ?? "core.transition/dissolve@1",
          params: m.params ?? {},
          trackId: id,
          trackName: t.name,
          cut,
          inOffset,
          outOffset,
          start: cut - inOffset,
          end: cut + outOffset,
          outgoing: track.clips[track.clips.length - 1]?.id ?? "",
          incoming: "",
        });
        continue;
      }
      const dur = secs(item.source_range?.duration);
      if (schema.startsWith("Clip")) {
        const m = item.metadata?.ve?.clip ?? {};
        const ref = item.media_references?.[item.active_media_reference_key ?? "DEFAULT_MEDIA"];
        track.clips.push({
          id: m.id ?? `${id}:${track.clips.length}`,
          name: item.name ?? "",
          trackId: id,
          trackName: t.name,
          kind,
          start: toFrames(pos),
          end: toFrames(pos + dur),
          sourceIn: toFrames(secs(item.source_range?.start_time)),
          link: m.link ?? undefined,
          speed: m.speed ?? [1, 1],
          volumeDb: m.volume_db ?? 0,
          url: ref?.target_url,
          transform: kind === "video" ? parseTransform(m.transform) : null,
        });
      }
      pos += dur;
    }
    track.end = toFrames(pos);
    for (const tr of track.transitions) tr.incoming = track.clips.find((c) => c.start === tr.cut)?.id ?? "";
    tracks.push(track);
  }

  const markers: Marker[] = (tl.tracks?.markers ?? []).map((m: any) => ({
    id: m.metadata?.ve?.marker?.id ?? m.name,
    name: m.name ?? "",
    color: String(m.color ?? "RED").toLowerCase(),
    comment: m.comment ?? "",
    start: toFrames(secs(m.marked_range?.start_time)),
    duration: toFrames(secs(m.marked_range?.duration)),
    source: m.metadata?.ve?.marker?.source ?? "user",
  }));

  return {
    name: tl.name ?? "untitled",
    revision: doc.revision,
    fps,
    rate,
    width: out.width ?? 1920,
    height: out.height ?? 1080,
    sampleRate: out.sample_rate ?? 48000,
    tracks,
    markers,
    assets,
    duration: Math.max(0, ...tracks.map((t) => t.end)),
  };
}

/** `HH:MM:SS:FF` for display. Non-drop-frame; fine for a UI readout. */
export function timecode(frame: number, fps: number): string {
  const nominal = Math.round(fps);
  const f = Math.max(0, Math.round(frame));
  const ff = f % nominal;
  const totalSecs = Math.floor(f / nominal);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(totalSecs / 3600))}:${p(Math.floor(totalSecs / 60) % 60)}:${p(totalSecs % 60)}:${p(ff)}`;
}

/** `00:12` / `1:02:03` for the ruler. */
export function shortTime(frame: number, fps: number): string {
  const s = Math.floor(frame / fps);
  const p = (n: number) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${p(Math.floor(s / 60))}:${p(s % 60)}`;
}

export const at = (frame: number) => `f${Math.max(0, Math.round(frame))}`;
export const delta = (frames: number) => `${frames >= 0 ? "+" : "-"}${Math.abs(Math.round(frames))}f`;

export function allClips(p: Project): Clip[] {
  return p.tracks.flatMap((t) => t.clips);
}

export function findClip(p: Project | null, id: string | null): Clip | null {
  if (!p || !id) return null;
  return allClips(p).find((c) => c.id === id) ?? null;
}

export function findTransition(p: Project | null, id: string | null): Transition | null {
  if (!p || !id) return null;
  for (const t of p.tracks) for (const tr of t.transitions) if (tr.id === id) return tr;
  return null;
}

/** A cut between two touching clips on a video track, where a transition can go. */
export interface Cut {
  track: Track;
  frame: number;
  outgoing: Clip;
  incoming: Clip;
  transition: Transition | null;
}

export function cutsOf(track: Track): Cut[] {
  if (track.kind !== "video") return [];
  const out: Cut[] = [];
  const cs = [...track.clips].sort((a, b) => a.start - b.start);
  for (let i = 0; i + 1 < cs.length; i++) {
    if (cs[i].end !== cs[i + 1].start) continue;
    const frame = cs[i].end;
    out.push({ track, frame, outgoing: cs[i], incoming: cs[i + 1], transition: track.transitions.find((t) => t.cut === frame) ?? null });
  }
  return out;
}

/**
 * Longest transition (frames) the clips around a cut allow for an alignment: the part before
 * the cut needs incoming media before its in point, the part after needs outgoing media past
 * its out point, and neither may be longer than its clip. The engine checks again exactly.
 */
export function maxTransition(p: Project, cut: { outgoing: Clip; incoming: Clip }, align: Align): number {
  const a = cut.outgoing, b = cut.incoming;
  const speed = (c: Clip) => c.speed[0] / c.speed[1] || 1;
  const asset = p.assets.find((x) => x.url === a.url);
  const aDur = a.end - a.start, bDur = b.end - b.start;
  const post = asset && asset.frames > 0 ? Math.floor((asset.frames - (a.sourceIn + aDur * speed(a))) / speed(a)) : Infinity;
  const pre = Math.floor(b.sourceIn / speed(b));
  const before = Math.max(0, Math.min(aDur, pre)); // inOffset limit
  const after = Math.max(0, Math.min(bDur, post)); // outOffset limit
  if (align === "start") return after;
  if (align === "end") return before;
  return Math.max(0, Math.min(2 * before + 1, 2 * after));
}

/** Shortest transition worth putting on a cut; below this the clips have no room for one. */
export const MIN_TRANSITION = 3;

/**
 * Fit a wanted length onto a cut: the preferred alignment if the clips' spare media allows,
 * else whichever alignment allows the longest. Null when no alignment has room for even
 * MIN_TRANSITION frames (typically untrimmed clips placed back to back).
 */
export function fitTransition(p: Project, cut: Cut, frames: number, prefer: Align = "center"): { duration: number; align: Align } | null {
  const want = Math.max(1, Math.round(frames));
  const room = (["center", "start", "end"] as Align[]).map((align) => ({ align, max: maxTransition(p, cut, align) }));
  const pref = room.find((r) => r.align === prefer)!;
  const pick = pref.max >= Math.min(want, MIN_TRANSITION) ? pref : room.reduce((a, b) => (b.max > a.max ? b : a));
  if (pick.max < Math.min(want, MIN_TRANSITION)) return null;
  return { duration: Math.min(want, pick.max), align: pick.align };
}

/** Why a cut has no room for a transition, in words for the user. */
export function noRoomMessage(cut: Cut): string {
  const a = cut.outgoing.name || cut.outgoing.id, b = cut.incoming.name || cut.incoming.id;
  return `No room for a transition between ${a} and ${b}. A transition plays both clips at once, so it needs spare footage: ${a} past its end or ${b} before its start. Trim a few frames off the end of ${a} or the start of ${b}, then try again.`;
}

/** The cut a click on a transition card means: at the end of the selected video clip, else at the playhead. */
export function cutFor(p: Project, selected: Clip | null, playhead: number): Cut | null {
  const cuts = p.tracks.filter((t) => t.kind === "video").flatMap(cutsOf);
  if (selected?.kind === "video") {
    const c = cuts.find((c) => c.outgoing.id === selected.id) ?? cuts.find((c) => c.incoming.id === selected.id);
    if (c) return c;
  }
  if (!cuts.length) return null;
  return cuts.reduce((a, b) => (Math.abs(b.frame - playhead) < Math.abs(a.frame - playhead) ? b : a));
}

/** Clips that move with `clip` (same `link`), including itself. */
export function linkedIds(p: Project, clip: Clip): Set<string> {
  if (!clip.link) return new Set([clip.id]);
  return new Set(allClips(p).filter((c) => c.link === clip.link).map((c) => c.id));
}

export function fileName(url: string): string {
  return decodeURIComponent(url.split("/").pop() ?? url);
}

export function filePath(url: string): string {
  // file:///C:/x/y.mp4 -> C:/x/y.mp4 ; file:///home/x -> /home/x
  const p = decodeURIComponent(url.replace(/^file:\/\//, ""));
  return /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p;
}
