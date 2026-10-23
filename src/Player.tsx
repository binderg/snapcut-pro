// The viewer. Paused: shows `render.frame` at the playhead (newest request
// wins, so scrubbing stays responsive). Playing in the desktop app: plays
// `render.range_preview` MP4 chunks back to back. Chunks sit on a fixed grid
// and use the same width as the paused frames, so the engine can build them
// from frames it has already rendered ahead, and hands back the same file
// at once when nothing in a chunk changed. In a browser it steps frames.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Engine } from "./engine";
import { Asset, at, Project, timecode } from "./model";
import { cacheFileUrl, isTauri, mediaFileUrl } from "./host";
import { useThumbnail } from "./LeftPanel";
import { Icon } from "./icons";
import { Handles } from "./Handles";
import type { Actions } from "./Editor";

const CHUNK_SECS = 4;

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
  selected: string | null;
  actions: Actions;
  /** An asset to show instead of the timeline (picked in the media panel). */
  source: Asset | null;
}) {
  const { project, engine, playhead, playing, setPlaying, seek, selected, actions, source } = props;
  const stageRef = useRef<HTMLDivElement>(null);
  // Two videos: one shows the current chunk while the other loads the next,
  // so a chunk switch never shows an emptied (black) element.
  const videoA = useRef<HTMLVideoElement>(null);
  const videoB = useRef<HTMLVideoElement>(null);
  const videos = [videoA, videoB];
  const srcs = useRef<(string | null)[]>([null, null]);
  const [front, setFront] = useState(0);
  const frontRef = useRef(0);
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
    if (empty || videoOn || source) return;
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
  }, [playhead, project.revision, renderWidth, empty, videoOn, source]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tell the engine where we are, so it renders ahead into its frame cache
  // (frames an edit just changed first). Older engines without it: ignore.
  const hinted = useRef(true);
  useEffect(() => {
    if (empty || !hinted.current) return;
    const t = setTimeout(() => {
      // In the desktop app playback uses chunks, which the engine then builds ahead too.
      const chunk = isTauri ? { chunk_frames: Math.max(1, Math.round(CHUNK_SECS * fps)) } : {};
      engine.query("ui.cache_hint", { at: at(Math.min(playhead, project.duration - 1)), width: renderWidth, format: "jpeg", ...chunk }).catch((e) => {
        if (/method not found/i.test(String(e?.message ?? e))) hinted.current = false;
      });
    }, playing ? 1000 : 250);
    return () => clearTimeout(t);
  }, [playhead, renderWidth, project.revision, empty]); // eslint-disable-line react-hooks/exhaustive-deps

  // Playback. The chunk holding `frame`, from its grid start; one request per
  // chunk at a time, so pausing and playing again waits for the same render.
  const inflight = useRef(new Map<string, Promise<Chunk | null>>());
  const startOffset = useRef(0);
  const chunkLen = Math.max(1, Math.round(CHUNK_SECS * fps));
  const renderChunk = (frame: number): Promise<Chunk | null> => {
    const from = Math.floor(frame / chunkLen) * chunkLen;
    const to = Math.min(from + chunkLen, project.duration);
    if (to <= from) return Promise.resolve(null);
    const key = `${project.revision}:${renderWidth}:${from}`;
    const pending = inflight.current.get(key);
    if (pending) return pending;
    const job = (async () => {
      try {
        const r: any = await engine.query("render.range_preview", { from: at(from), to: at(to), width: renderWidth });
        const src = await cacheFileUrl(r.path);
        return src ? { from, to, src } : null;
      } finally {
        inflight.current.delete(key);
      }
    })();
    inflight.current.set(key, job);
    return job;
  };

  // Point the hidden video at `src` (no-op if it already has it).
  const load = (i: number, src: string) => {
    if (srcs.current[i] === src) return;
    srcs.current[i] = src;
    videos[i].current!.src = src;
  };

  const startChunk = (c: Chunk, frame = c.from) => {
    chunk.current = c;
    next.current = c.to < project.duration ? renderChunk(c.to).catch(() => null) : null;
    // Load into the hidden video; the visible one (or the still) stays up
    // until this one has the right frame.
    const b = 1 - frontRef.current;
    const v = videos[b].current!;
    load(b, c.src);
    // Starting mid-chunk: seek once the file is open, and ignore its time until then.
    const target = (frame - c.from) / fps;
    startOffset.current = target;
    const reveal = () => {
      if (chunk.current !== c) return;
      const old = videos[frontRef.current].current;
      frontRef.current = b;
      setFront(b);
      if (old && old !== v) old.pause();
      setVideoOn(true);
      setBuffering(false);
      // Preload the next chunk into the video we just hid.
      const p = next.current;
      p?.then((n) => {
        if (n && chunk.current === c) load(1 - b, n.src);
      });
    };
    const ready = () => {
      if (chunk.current !== c) return;
      if (Math.abs(v.currentTime - target) > 0.5 / fps) {
        v.addEventListener("seeked", reveal, { once: true });
        v.currentTime = target;
      } else if (v.readyState >= 2) {
        reveal();
      } else {
        v.addEventListener("loadeddata", reveal, { once: true });
      }
    };
    if (v.readyState >= 1) ready();
    else v.addEventListener("loadedmetadata", ready, { once: true });
    v.play().catch(() => {});
  };

  useEffect(() => {
    if (!playing || source) {
      videoA.current?.pause();
      videoB.current?.pause();
      setVideoOn(false);
      setBuffering(false);
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
        if (c) startChunk(c, from);
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
  }, [playing, project.revision, source]); // eslint-disable-line react-hooks/exhaustive-deps

  // Source mode: `playing` plays the picked asset instead of the timeline.
  const srcRef = useRef<HTMLVideoElement>(null);
  const [srcTime, setSrcTime] = useState(0);
  useEffect(() => setSrcTime(0), [source?.id]);
  useEffect(() => {
    const v = srcRef.current;
    if (!source || !v) return;
    if (playing) {
      if (v.ended) v.currentTime = 0;
      v.play().catch(() => setPlaying(false));
    } else {
      v.pause();
    }
  }, [playing, source?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const srcSeek = (t: number) => {
    const v = srcRef.current;
    if (v) v.currentTime = t;
    setSrcTime(t);
  };
  const srcDur = source ? source.frames / fps : 0;

  // Events from the hidden video (loading or finished) are ignored.
  const onTime = (i: number) => {
    const v = videos[i].current, c = chunk.current;
    if (i !== frontRef.current || !v || !c || !playing) return;
    if (v.seeking || v.currentTime + 0.05 < startOffset.current) return;
    startOffset.current = 0;
    seek(c.from + Math.floor(v.currentTime * fps));
    const left = v.duration - v.currentTime;
    if (!next.current && c.to < project.duration && left < CHUNK_SECS / 2) {
      next.current = renderChunk(c.to).catch(() => null);
    }
  };

  const onEnded = async (i: number) => {
    const c = chunk.current;
    if (i !== frontRef.current || !c || !playing) return;
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
      <div className="panel-head">{source ? <>Source <span className="faint">· {source.name}</span></> : "Player"}</div>
      <div className="player-stage" ref={stageRef}>
        <div className="player-frame" style={{ width: box.w, height: box.h }}>
          {img && !videoOn && !source && <img src={img} alt="" draggable={false} />}
          {videos.map((ref, i) => (
            <video
              key={i}
              ref={ref}
              preload="auto"
              style={{ visibility: videoOn && front === i ? "visible" : "hidden" }}
              onTimeUpdate={() => onTime(i)}
              onEnded={() => onEnded(i)}
              playsInline
            />
          ))}
          {source && (
            <SourceMedia key={source.id} asset={source} engine={engine} videoRef={srcRef} onTime={setSrcTime} onEnded={() => setPlaying(false)} />
          )}
          {!empty && !videoOn && !playing && !source && (
            <Handles project={project} playhead={Math.min(playhead, project.duration - 1)} selected={selected} actions={actions} w={box.w} h={box.h} />
          )}
          {empty && !source && (
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
      {source && (
        <input className="src-scrub" type="range" min={0} max={srcDur} step={1 / fps} value={Math.min(srcTime, srcDur)}
          onChange={(e) => srcSeek(Number(e.target.value))} />
      )}
      {source ? (
        <div className="player-bar">
          <span className="tc mono"><b>{timecode(Math.floor(srcTime * fps), fps)}</b> <span className="faint">/ {timecode(source.frames, fps)}</span></span>
          <div className="hstack" style={{ gap: 2 }}>
            <button className="icon-btn" onClick={() => srcSeek(0)} data-tip="Start"><Icon.prev /></button>
            <button className="icon-btn" onClick={() => setPlaying((p) => !p)} data-tip="Play/Pause (Space)">
              {playing ? <Icon.pause /> : <Icon.play />}
            </button>
            <button className="icon-btn" onClick={() => srcSeek(srcDur)} data-tip="End"><Icon.next /></button>
          </div>
          <div className="right muted" style={{ fontSize: 12 }}>
            {source.video ? `${source.video.width}x${source.video.height}` : "audio"}
          </div>
        </div>
      ) : (
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
      )}
    </section>
  );
}

/** The picked asset, played straight from its file. Formats the webview
 * can't decode (or a plain browser) show the poster frame and a note. */
function SourceMedia({ asset, engine, videoRef, onTime, onEnded }: {
  asset: Asset;
  engine: Engine;
  videoRef: React.RefObject<HTMLVideoElement>;
  onTime: (t: number) => void;
  onEnded: () => void;
}) {
  const thumb = useThumbnail(engine, asset);
  const [url, setUrl] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    mediaFileUrl(asset.url).then(
      (u) => { if (live) u ? setUrl(u) : setFailed(true); },
      () => { if (live) setFailed(true); },
    );
    return () => { live = false; };
  }, [asset.url]);
  const showVideo = !!asset.video && ready && !failed;
  return (
    <>
      {!showVideo && thumb && <img src={thumb} alt="" draggable={false} />}
      {!asset.video && <div className="player-empty"><Icon.audio /></div>}
      <video
        ref={videoRef}
        src={url ?? undefined}
        preload="auto"
        playsInline
        style={{ visibility: showVideo ? "visible" : "hidden" }}
        onLoadedData={() => setReady(true)}
        onError={() => setFailed(true)}
        onTimeUpdate={(e) => onTime(e.currentTarget.currentTime)}
        onEnded={onEnded}
      />
      {failed && <div className="player-badge">{isTauri ? "Can't preview this format here" : "Source preview plays in the desktop app"}</div>}
    </>
  );
}
