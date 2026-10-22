// Per-machine UI conveniences (recent projects, panel sizes). Never project data.
export function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`ve.${key}`);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(`ve.${key}`, JSON.stringify(value));
  } catch {
    // storage unavailable; fine
  }
}
