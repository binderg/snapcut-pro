// Live previews of GL Transitions shaders for the transition cards. One shared WebGL
// context renders into a small offscreen canvas; a card copies the result into its own
// 2D canvas. Shaders compile on first hover, and a shader that fails to compile just
// gets no preview. The previews run the original GLSL; the engine's own renders are
// separate and use WGSL.

export interface GlParam {
  type: string;
  name: string;
  default: string;
  doc: string;
}

export interface GlTransition {
  id: string;
  name: string;
  author: string;
  license: string;
  description: string;
  tags: string[];
  params: GlParam[];
  glsl: string;
}

export const W = 320;
export const H = 180;

/** Two stand-in pictures with clear shapes, so wipes, zooms and curls are easy to read. */
function scene(kind: "a" | "b"): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const sky = g.createLinearGradient(0, 0, 0, H);
  if (kind === "a") { sky.addColorStop(0, "#ff7a45"); sky.addColorStop(0.6, "#ffc46b"); sky.addColorStop(1, "#ffe3a1"); }
  else { sky.addColorStop(0, "#0b1f4a"); sky.addColorStop(0.6, "#1f6fb2"); sky.addColorStop(1, "#7fd6e8"); }
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  g.fillStyle = kind === "a" ? "#fff3c4" : "#f4f7ff";
  g.beginPath();
  g.arc(kind === "a" ? 232 : 90, 56, 26, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = kind === "a" ? "#a23b2a" : "#0e3b57";
  g.beginPath();
  g.moveTo(0, H);
  for (let x = 0; x <= W; x += 20) g.lineTo(x, H - 46 - 30 * Math.abs(Math.sin(x * (kind === "a" ? 0.031 : 0.019) + 1)));
  g.lineTo(W, H);
  g.closePath();
  g.fill();
  g.fillStyle = kind === "a" ? "#5a1f1a" : "#082a3d";
  g.fillRect(0, H - 22, W, 22);
  g.fillStyle = "rgba(255,255,255,0.9)";
  g.font = "bold 44px system-ui, sans-serif";
  g.textAlign = "center";
  g.fillText(kind === "a" ? "A" : "B", W / 2, 92);
  return c;
}

/** A grey pattern for transitions that take a texture of their own (luma, displacement). */
function auxScene(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(64, 64, 4, 64, 64, 90);
  r.addColorStop(0, "#fff");
  r.addColorStop(1, "#000");
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  g.globalAlpha = 0.25;
  for (let i = 0; i < 400; i++) {
    g.fillStyle = i % 2 ? "#fff" : "#000";
    g.fillRect(Math.random() * 128, Math.random() * 128, 3, 3);
  }
  return c;
}

let sceneA: HTMLCanvasElement | null = null;
export function sceneImage(): HTMLCanvasElement {
  return (sceneA ??= scene("a"));
}

const VERT = `attribute vec2 position; varying vec2 _uv;
void main(){ gl_Position = vec4(position, 0.0, 1.0); _uv = vec2(0.5) * (position + vec2(1.0)); }`;

const prelude = `precision highp float;
uniform sampler2D from, to;
uniform float progress, ratio;
varying vec2 _uv;
vec4 getFromColor(vec2 uv){ return texture2D(from, vec2(uv.x, 1.0 - uv.y)); }
vec4 getToColor(vec2 uv){ return texture2D(to, vec2(uv.x, 1.0 - uv.y)); }
`;

interface Program {
  prog: WebGLProgram;
  progressLoc: WebGLUniformLocation | null;
}

class Renderer {
  canvas = document.createElement("canvas");
  gl: WebGLRenderingContext;
  programs = new Map<string, Program | null>();
  tex: WebGLTexture[] = [];

  constructor() {
    this.canvas.width = W;
    this.canvas.height = H;
    const gl = this.canvas.getContext("webgl", { premultipliedAlpha: false, antialias: false });
    if (!gl) throw new Error("WebGL is not available");
    this.gl = gl;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    for (const src of [scene("a"), scene("b"), auxScene()]) this.tex.push(this.texture(src));
    gl.viewport(0, 0, W, H);
  }

  texture(src: HTMLCanvasElement): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  compile(t: GlTransition): Program | null {
    const gl = this.gl;
    const make = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vs = make(gl.VERTEX_SHADER, VERT);
    const fs = make(gl.FRAGMENT_SHADER, `${prelude}\n${t.glsl}\nvoid main(){ gl_FragColor = transition(_uv); }`);
    if (!vs || !fs) return null;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    const pos = gl.getAttribLocation(prog, "position");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(gl.getUniformLocation(prog, "from"), 0);
    gl.uniform1i(gl.getUniformLocation(prog, "to"), 1);
    gl.uniform1f(gl.getUniformLocation(prog, "ratio"), W / H);
    let unit = 2;
    for (const p of t.params) {
      const loc = gl.getUniformLocation(prog, p.name);
      if (loc) setUniform(gl, loc, p, unit) && unit++;
    }
    return { prog, progressLoc: gl.getUniformLocation(prog, "progress") };
  }

  /** Draw one frame; null if the shader does not compile here. */
  draw(t: GlTransition, progress: number): HTMLCanvasElement | null {
    const gl = this.gl;
    let p = this.programs.get(t.id);
    if (p === undefined) {
      p = this.compile(t);
      this.programs.set(t.id, p);
    }
    if (!p) return null;
    gl.useProgram(p.prog);
    const pos = gl.getAttribLocation(p.prog, "position");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[0]);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[1]);
    for (let u = 2; u < 6; u++) {
      gl.activeTexture(gl.TEXTURE0 + u);
      gl.bindTexture(gl.TEXTURE_2D, this.tex[2]);
    }
    gl.uniform1f(p.progressLoc, Math.max(0, Math.min(1, progress)));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return this.canvas;
  }
}

/** Numbers in a GLSL default like `vec2(0.5, 3)`, `0.4`, `10` or `1/3`. */
function numbers(def: string): number[] {
  const inner = def.includes("(") ? def.slice(def.indexOf("(") + 1, def.lastIndexOf(")")) : def;
  return inner.split(",").map((part) => {
    const m = part.match(/^\s*(-?[\d.]+(?:e-?\d+)?)\s*(?:\/\s*(-?[\d.]+))?\s*$/i);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    return m[2] ? n / (parseFloat(m[2]) || 1) : n;
  });
}

/** Set a tunable uniform to the default from its `// = value` comment. Returns true if it used a texture unit. */
function setUniform(gl: WebGLRenderingContext, loc: WebGLUniformLocation, p: GlParam, unit: number): boolean {
  const n = numbers(p.default);
  const v = (i: number, d = 0) => (Number.isFinite(n[i]) ? n[i] : d);
  switch (p.type) {
    case "float": gl.uniform1f(loc, v(0)); break;
    case "int": gl.uniform1i(loc, Math.round(v(0))); break;
    case "bool": gl.uniform1i(loc, /true|1/i.test(p.default) ? 1 : 0); break;
    case "vec2": gl.uniform2f(loc, v(0), n.length > 1 ? v(1) : v(0)); break;
    case "vec3": gl.uniform3f(loc, v(0), n.length > 1 ? v(1) : v(0), n.length > 2 ? v(2) : v(0)); break;
    case "vec4": gl.uniform4f(loc, v(0), n.length > 1 ? v(1) : v(0), n.length > 2 ? v(2) : v(0), n.length > 3 ? v(3, 1) : v(0)); break;
    case "ivec2": gl.uniform2i(loc, Math.round(v(0)), Math.round(n.length > 1 ? v(1) : v(0))); break;
    case "sampler2D": gl.uniform1i(loc, unit); return true;
    default: break;
  }
  return false;
}

let renderer: Renderer | null | undefined;

/** The shared renderer, or null when WebGL is unavailable. */
export function getRenderer(): Renderer | null {
  if (renderer === undefined) {
    try { renderer = new Renderer(); } catch { renderer = null; }
  }
  return renderer;
}

/** Small stand-ins for the engine's own transitions, which have no GLSL source. */
const e = (body: string, uniforms = "") => `${uniforms}\nvec4 transition(vec2 uv){ ${body} }`;
export const ENGINE_PREVIEWS: Record<string, string> = {
  "core.transition/dissolve": e("return mix(getFromColor(uv), getToColor(uv), progress);"),
  "core.transition/dip": e("vec4 k = vec4(0.0, 0.0, 0.0, 1.0); return progress < 0.5 ? mix(getFromColor(uv), k, progress * 2.0) : mix(k, getToColor(uv), (progress - 0.5) * 2.0);"),
  "core.transition/wipe": e("float s = 0.05; float edge = progress * (1.0 + s); return mix(getToColor(uv), getFromColor(uv), smoothstep(edge - s, edge, uv.x));"),
  "core.transition/slide": e("return uv.x < progress ? getToColor(vec2(uv.x + 1.0 - progress, uv.y)) : getFromColor(vec2(uv.x - progress, uv.y));"),
};
