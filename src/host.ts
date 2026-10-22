// What the desktop shell adds over a plain browser tab: starting the daemon,
// folder/file pickers, OS file drops and reading rendered previews from the
// engine cache. In a browser these fall back or are unavailable.

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function daemonUrl(veBin: string, project: string): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("daemon_url", { veBin, project });
}

export async function initProject(veBin: string, path: string, fps: string, size: string): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("init_project", { veBin, path, fps, size });
}

export async function pickFolder(title: string): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({ directory: true, title });
  return typeof r === "string" ? r : null;
}

export async function pickMedia(): Promise<string[]> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({
    multiple: true,
    title: "Import media",
    filters: [
      { name: "Media", extensions: ["mp4", "mov", "mkv", "webm", "m4v", "avi", "mxf", "mp3", "wav", "m4a", "aac", "flac", "ogg"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

/** Calls `cb` with OS paths dropped on the window. Returns an unsubscribe. */
export async function onFileDrop(cb: (paths: string[]) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  return getCurrentWebview().onDragDropEvent((e) => {
    if (e.payload.type === "drop" && e.payload.paths.length) cb(e.payload.paths);
  });
}

/** A URL the webview can load for a file the engine rendered into its cache. */
export async function cacheFileUrl(path: string): Promise<string | null> {
  if (!isTauri) return null;
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return convertFileSrc(path.replace(/^\\\\\?\\/, ""));
}
