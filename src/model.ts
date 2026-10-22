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
}

export interface Track {
  id: string;
  name: string;
  kind: "video" | "audio";
  clips: Clip[];
  end: number;
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
    const track: Track = { id, name: t.name, kind, clips: [], end: 0 };
    let pos = 0; // seconds; rounded per item so long timelines don't drift
    for (const item of t.children ?? []) {
      const schema: string = item.OTIO_SCHEMA ?? "";
      if (schema.startsWith("Transition")) continue; // takes no time in OTIO
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
        });
      }
      pos += dur;
    }
    track.end = toFrames(pos);
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
