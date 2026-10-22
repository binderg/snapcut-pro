// The viewer. Paused: shows `render.frame` at the playhead (cached per
// revision, newest request wins, so scrubbing stays responsive). Playing in
// the desktop app: renders short `render.range_preview` MP4 chunks ahead of
// the playhead and plays them back to back. In a browser it steps frames.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Engine } from "./engine";
import { at, Project, timecode } from "./model";
import { cacheFileUrl, isTauri } from "./host";
import { Icon } from "./icons";

const CHUNK_SECS = 8;

interface Chunk {
  from: number;
  to: number;
  src: string;
}

export function Player(props: {
  project: Project;
  engine: Engine;
  playhead: number;
  playing: boolean;
  setPlaying: (p: boolean | ((x: boolean) => boolean)) => void;
  seek: (f: number) => void;
}) {
  const { project, engine, playhead, playing, setPlaying, seek } = props;
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [box, setBox] = useState({ w: 640, h: 360 });
  const [img, setImg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [slow, setSlow] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const cache = useRef(new Map<string, string>());
  const want = useRef("");
  const chunk = useRef<Chunk | null>(null);
  const next = useRef<Promise<Chunk | null> | null>(null);
  const [videoOn, setVideoOn] = useState(false);
  const fps = project.fps;
  const empty = project.duration === 0;

  // Only show the "rendering" badge if it takes a moment; short loads would just make it blink.
  useEffect(() => {
    if (!loading && !buffering) { setSlow(false); return; }
    const t = setTimeout(() => setSlow(true), 350);
    return () => clearTimeout(t);
  }, [loading, buffering]);

  // Fit the canvas aspect into the stage.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const W = el.clientWidth - 24, H = el.clientHeight - 24;
      const a = project.width / project.height;
      const w = Math.max(1, Math.min(W, H * a));
      setBox({ w, h: w / a });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [project.width, project.height]);

  const renderWidth = [320, 640, 960, 1280].find((w) => w >= box.w * Math.min(devicePixelRatio, 2)) ?? 1280;

  // Frames at the playhead.
  useEffect(() => {
    if (empty || videoOn) return;
    const frame = Math.min(playhead, project.duration - 1);
    const key = `${project.revision}:${renderWidth}:${frame}`;
    want.current = key;
    const hit = cache.current.get(key);
    if (hit) {
      setImg(hit);
      setLoading(false);
      return;
    }
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r: any = await engine.query("render.frame", { at: at(frame), width: renderWidth, format: "jpeg" });
        const url = `data:${r.mime};base64,${r.data}`;
        cache.current.set(key, url);
        if (cache.current.size > 300) cache.current.delete(cache.current.keys().next().value!);
        if (want.current === key) setImg(url);
      } catch {
        // a failed frame is not worth a toast while scrubbing
      } finally {
        if (want.current === key) setLoading(false);
      }
    }, playing ? 0 : 40);
    return () => clearTimeout(t);
  }, [playhead, project.revision, renderWidth, empty, videoOn]); // eslint-disable-line react-hooks/exhaustive-deps

  // Playback.
  const renderChunk = async (from: number): Promise<Chunk | null> => {
    const to = Math.min(from + Math.round(CHUNK_SECS * fps), project.duration);
    if (to <= from) return null;
    const r: any = await engine.query("render.range_preview", { from: at(from), to: at(to), width: Math.min(renderWidth, 960) });
    const src = await cacheFileUrl(r.path);
    return src ? { from, to, src } : null;
  };

  const startChunk = (c: Chunk) => {
    chunk.current = c;
    next.current = null;
    const v = videoRef.current!;
    v.src = c.src;
    v.play().catch(() => {});
    setVideoOn(true);
    setBuffering(false);
  };

  useEffect(() => {
    if (!playing) {
      videoRef.current?.pause();
      setVideoOn(false);
      chunk.current = null;
      next.current = null;
      return;
    }
    if (empty) {
      setPlaying(false);
      return;
    }
    const from = playhead >= project.duration - 1 ? 0 : playhead;
    let cancelled = false;

    if (!isTauri) {
      // Browser: advance the playhead in real time; frames follow as they arrive.
      const t0 = performance.now();
      let raf = 0;
      const tick = () => {
        const f = from + Math.floor(((performance.now() - t0) / 1000) * fps);
        if (f >= project.duration) { seek(project.duration); setPlaying(false); return; }
        seek(f);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }

    setBuffering(true);
    renderChunk(from).then(
      (c) => {
        if (cancelled) return;
        if (c) startChunk(c);
        else setPlaying(false);
      },
      (e) => {
        if (cancelled) return;
        setPlaying(false);
        setBuffering(false);
        console.error(e);
      },
    );
    return () => { cancelled = true; };
  }, [playing, project.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  const onTime = () => {
    const v = videoRef.current, c = chunk.current;
    if (!v || !c || !playing) return;
    seek(c.from + Math.floor(v.currentTime * fps));
    const left = v.duration - v.currentTime;
    if (!next.current && c.to < project.duration && left < CHUNK_SECS / 2) {
      next.current = renderChunk(c.to).catch(() => null);
    }
  };

  const onEnded = async () => {
    const c = chunk.current;
    if (!c || !playing) return;
    if (c.to >= project.duration) {
      seek(project.duration);
      setPlaying(false);
      return;
    }
    setBuffering(true);
    const n = await (next.current ?? renderChunk(c.to).catch(() => null));
    if (n && chunk.current === c) startChunk(n);
    else setPlaying(false);
  };

  return (
    <section className="panel">
      <div className="panel-head">Player</div>
      <div className="player-stage" ref={stageRef}>
        <div className="player-frame" style={{ width: box.w, height: box.h }}>
          {img && !videoOn && <img src={img} alt="" draggable={false} />}
          <video ref={videoRef} style={{ visibility: videoOn ? "visible" : "hidden" }} onTimeUpdate={onTime} onEnded={onEnded} playsInline />
          {empty && (
            <div className="player-empty">
              <div>
                <div style={{ fontSize: 15, color: "var(--muted)" }}>Empty timeline</div>
                <div className="note">Drag media from the left onto the timeline.</div>
              </div>
            </div>
          )}
        </div>
        {slow && (loading || buffering) && (
          <div className="player-badge"><span className="spinner" />{buffering ? "Rendering preview…" : "Rendering frame"}</div>
        )}
      </div>
      <div className="player-bar">
        <span className="tc mono"><b>{timecode(playhead, fps)}</b> <span className="faint">/ {timecode(project.duration, fps)}</span></span>
        <div className="hstack" style={{ gap: 2 }}>
          <button className="icon-btn" onClick={() => seek(0)} data-tip="Start (Home)"><Icon.prev /></button>
          <button className="icon-btn" onClick={() => setPlaying((p) => !p)} disabled={empty} data-tip="Play/Pause (Space)">
            {playing ? <Icon.pause /> : <Icon.play />}
          </button>
          <button className="icon-btn" onClick={() => seek(project.duration)} data-tip="End (End)"><Icon.next /></button>
        </div>
        <div className="right muted" style={{ fontSize: 12 }}>
          {project.width}x{project.height}
        </div>
      </div>
    </section>
  );
}
