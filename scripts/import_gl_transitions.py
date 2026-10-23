"""Collect the GL Transitions shaders into src/gl/transitions.json, converted for the engine.

    git clone --depth 1 https://github.com/gl-transitions/gl-transitions.git <dir>
    cargo install naga-cli --version 30.0.1
    python -I scripts/import_gl_transitions.py <dir> [--out out.json] [--naga naga] [--check ve]

Each entry keeps the shader's own source and header (author, license) untouched
in `glsl`; the editor's preview cards render that in WebGL. Each entry also gets
`engine`: a transition manifest (id `project.gl-<id>`) plus WGSL for the engine's
`wgsl` runtime and any images its params need, which the editor sends with
`fx.define` the first time a project uses it. Entries that do not convert get
`engine: null` and the reason in `engine_error`.

How a shader converts:

1. Wrap it as GLSL 450: `progress`, `ratio` and the tunable uniforms become
   plain globals, `getFromColor` / `getToColor` and each `sampler2D` become stub
   functions, and a fragment `main` calls `transition`.
2. Translate that to WGSL with naga.
3. Rewrite naga's output into the engine contract: drop the entry point and
   the globals, read `u.progress`, `u.resolution` and `p.<param>` instead, swap
   the stubs for `outgoing(uv)`, `incoming(uv)` and the image functions, and
   add `fn transition(uv)`, which flips y (the engine's uv starts at the top
   left, GL Transitions' at the bottom left).

Colors: the engine hands transitions linear light with premultiplied alpha,
while GL Transitions do their math on sRGB values (as the previews do). The
stubs decode to straight sRGB and the result is encoded back to linear
premultiplied, so engine renders match the previews.

With `--check <ve>` every converted shader is sent to `fx.define` with
`dry_run` against a scratch project (naga validation plus the engine's GPU
test render); failures are reported and kept out of the output.
"""
import argparse
import base64
import json
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

HEADER = re.compile(r"^\s*//\s*(author|license|description|tags)\s*:\s*(.*?)\s*$", re.I)
# `uniform float x; // = 1.0` and `uniform vec3 c /* = vec3(1.0) */;`
UNIFORM = re.compile(r"^\s*uniform\s+(\w+)\s+(\w+)\s*(?:/\*\s*=\s*(.*?)\s*\*/)?\s*;\s*(?://\s*=\s*(.*?))?\s*$")
PARAM_DOC = re.compile(r"^\s*//\s*@param\s+(.*?)\s*$")

VECTORS = {"vec2": 2, "vec3": 3, "vec4": 4, "ivec2": 2}
# Names the engine's wrapper defines or reserves for params.
ENGINE_NAMES = ["u", "p", "src", "outgoing", "incoming", "effect", "transition", "uv"]
# WGSL reserved words and keywords (WGSL spec, plus what naga refuses); a param named
# like one cannot be a struct field.
WGSL_RESERVED = set(
    """alias break case const const_assert continue continuing default diagnostic discard else enable false fn for
    if let loop override requires return struct switch true var while NULL Self abstract active alignas alignof as
    asm asm_fragment async attribute auto await become binding_array cast catch class co_await co_return co_yield
    coherent column_major common compile compile_fragment concept const_cast consteval constexpr constinit crate
    debugger decltype delete demote demote_to_helper do dynamic_cast enum explicit export extends extern external
    fallthrough filter final finally friend from fxgroup get goto groupshared highp impl implements import inline
    instanceof interface layout lowp macro macro_rules match mediump meta mod module move mut mutable namespace new
    nil noexcept noinline nointerpolation non_coherent noncoherent noperspective null nullptr of operator package
    packoffset partition pass patch pixelfragment precise precision premerge priv protected pub public readonly ref
    regardless register reinterpret_cast require resource restrict self set shared sizeof smooth snorm static
    static_assert static_cast std subroutine super target template this thread_local throw trait try type typedef
    typeid typename typeof union unless unorm unsafe unsized use using varying virtual volatile wgsl where with
    writeonly yield""".split()
)


def snake(name: str) -> str:
    s = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", name).lower()
    s = re.sub(r"[^a-z0-9_]", "_", s)
    if not re.match(r"[a-z_]", s):
        s = "_" + s
    if s in ENGINE_NAMES or s in WGSL_RESERVED or s.startswith("ve_"):
        s = "gl_" + s
    return s


def numbers(text: str) -> list:
    """Numbers in a GLSL default like `vec2(0.5, 3)`, `0.4`, `10` or `1/3` (as the preview reads them)."""
    text = text.split(";")[0].strip()
    inner = text[text.index("(") + 1 : text.rindex(")")] if "(" in text else text
    out = []
    for part in inner.split(","):
        m = re.match(r"^\s*(-?[\d.]+(?:e-?\d+)?)\s*(?:/\s*(-?[\d.]+))?\s*$", part, re.I)
        if not m:
            out.append(0.0)
            continue
        n = float(m.group(1))
        out.append(n / (float(m.group(2)) or 1.0) if m.group(2) else n)
    return out


def parse(path: Path) -> dict:
    text = path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    meta = {"author": "", "license": "", "description": "", "tags": ""}
    params = []
    doc = None
    for line in text.split("\n"):
        h = HEADER.match(line)
        if h and not meta[h.group(1).lower()]:
            # Usually the first lines; StereoViewer puts its header after the uniforms.
            meta[h.group(1).lower()] = h.group(2).strip()
            continue
        d = PARAM_DOC.match(line)
        if d:
            doc = d.group(1)
            continue
        u = UNIFORM.match(line)
        if u:
            default = (u.group(3) or u.group(4) or "").split(";")[0].strip()
            params.append({"type": u.group(1), "name": u.group(2), "default": default, "doc": doc or ""})
        doc = None if u or not line.strip().startswith("//") else doc
    stem = path.stem
    return {
        "id": stem.lower(),
        "name": re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", stem).replace("_", " ").strip().title() if stem.islower() is False else stem.replace("_", " ").title(),
        "author": meta["author"],
        "license": meta["license"] or "unknown",
        "description": meta["description"],
        "tags": [t.strip() for t in meta["tags"].split(",") if t.strip()],
        "params": params,
        "glsl": text,
    }


# --- default images for sampler2D params ---


def png_gray(size: int, value) -> bytes:
    """An 8-bit grayscale PNG, `value(x, y)` 0..1 per pixel."""
    rows = b"".join(b"\x00" + bytes(max(0, min(255, round(value(x, y) * 255))) for x in range(size)) for y in range(size))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 0, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b"")


def luma_png() -> bytes:
    """Radial: dark in the middle, white in the corners, so a luma wipe opens like an iris."""
    n = 256
    return png_gray(n, lambda x, y: min(1.0, (((x + 0.5) / n - 0.5) ** 2 + ((y + 0.5) / n - 0.5) ** 2) ** 0.5 / 0.7071))


def displacement_png() -> bytes:
    """Smooth value noise (fixed seed, so the file is the same on every run)."""
    import math
    import random

    rnd = random.Random(7)
    g = 8
    grid = [[rnd.random() for _ in range(g + 1)] for _ in range(g + 1)]
    n = 128

    def at(x, y):
        fx, fy = x / n * g, y / n * g
        ix, iy = int(fx), int(fy)
        tx, ty = fx - ix, fy - iy
        sx, sy = tx * tx * (3 - 2 * tx), ty * ty * (3 - 2 * ty)
        a = grid[iy][ix] + (grid[iy][ix + 1] - grid[iy][ix]) * sx
        b = grid[iy + 1][ix] + (grid[iy + 1][ix + 1] - grid[iy + 1][ix]) * sx
        return 0.5 + 0.5 * math.tanh(3 * (a + (b - a) * sy - 0.5))

    return png_gray(n, at)


def image_for(name: str) -> tuple:
    if "displace" in name.lower():
        return "displacement.png", displacement_png()
    return "luma.png", luma_png()


# --- GLSL 450 wrapper ---


def glsl_type(t: str) -> str:
    return t


def schema_for(p: dict, image: str | None) -> dict:
    t = p["type"]
    s: dict = {"title": p["name"]}
    if p["doc"]:
        s["description"] = p["doc"]
    n = numbers(p["default"]) if p["default"] else []
    if t == "float":
        s.update({"type": "number", "default": n[0] if n else 0.0, "x-animatable": True})
    elif t == "int":
        s.update({"type": "integer", "default": round(n[0]) if n else 0})
    elif t == "bool":
        s.update({"type": "boolean", "default": bool(re.match(r"\s*(true|1)", p["default"], re.I))})
    elif t in VECTORS:
        size = VECTORS[t]
        vals = [n[i] if i < len(n) else (n[0] if len(n) == 1 else (1.0 if t == "vec4" and i == 3 else 0.0)) for i in range(size)] if n else [0.0] * size
        integer = t.startswith("i")
        s.update(
            {
                "type": "array",
                "items": {"type": "integer" if integer else "number"},
                "minItems": size,
                "maxItems": size,
                "default": [round(v) for v in vals] if integer else vals,
            }
        )
        if not integer:
            s["x-animatable"] = True
    elif t == "sampler2D":
        s.update({"type": "string", "format": "image", "default": image})
    else:
        raise ValueError(f"uniform `{p['name']}`: type {t} has no engine param type")
    return s


def wrap(t: dict) -> tuple:
    """The shader as a GLSL 450 fragment shader naga can read, and the globals it declares in order."""
    out_lines = []
    for line in t["glsl"].split("\n"):
        if UNIFORM.match(line):
            out_lines.append("")  # keep line numbers
            continue
        out_lines.append(line)
    body = "\n".join(out_lines)
    samplers = [p for p in t["params"] if p["type"] == "sampler2D"]
    for s in samplers:
        body = re.sub(r"\btexture(?:2D)?\s*\(\s*" + re.escape(s["name"]) + r"\s*,", f"glt_img_{s['name']}(", body)
        if re.search(r"\b" + re.escape(s["name"]) + r"\b", re.sub(r"//.*", "", body)):
            raise ValueError(f"sampler `{s['name']}` is used other than as texture2D({s['name']}, uv)")
    globals_ = ["progress", "ratio"] + [p["name"] for p in t["params"] if p["type"] != "sampler2D"]
    head = ["#version 450", "float progress;", "float ratio;"]
    for p in t["params"]:
        if p["type"] != "sampler2D":
            head.append(f"{glsl_type(p['type'])} {p['name']};")
    head.append("vec4 getFromColor(vec2 uv) { return vec4(uv, 0.0, 1.0); }")
    head.append("vec4 getToColor(vec2 uv) { return vec4(uv, 1.0, 1.0); }")
    for s in samplers:
        head.append(f"vec4 glt_img_{s['name']}(vec2 uv) {{ return vec4(uv, 0.5, 1.0); }}")
    tail = [
        "layout(location = 0) in vec2 glt_uv;",
        "layout(location = 0) out vec4 glt_color;",
        "void main() { glt_color = transition(glt_uv); }",
    ]
    return "\n".join(head) + "\n" + body + "\n" + "\n".join(tail) + "\n", globals_


# --- naga's WGSL into the engine contract ---


def items(wgsl: str) -> list:
    """Top-level declarations of a WGSL module (naga's output: no comments or strings)."""
    out, cur, depth = [], [], 0
    for ch in wgsl:
        cur.append(ch)
        if ch in "{(":
            depth += 1
        elif ch in "})":
            depth -= 1
            if depth == 0 and ch == "}":
                out.append("".join(cur).strip())
                cur = []
        elif ch == ";" and depth == 0:
            out.append("".join(cur).strip())
            cur = []
    rest = "".join(cur).strip()
    if rest:
        out.append(rest)
    return [i for i in out if i]


def ident_sub(text: str, names: dict) -> str:
    """Replace whole identifiers (not fields after a dot)."""
    if not names:
        return text
    pat = re.compile(r"(?<![\w.])(" + "|".join(re.escape(n) for n in sorted(names, key=len, reverse=True)) + r")(?!\w)")
    return pat.sub(lambda m: names[m.group(1)], text)


HELPERS = """
// Engine colors are linear light, premultiplied; GL Transitions work on straight sRGB.
fn glt_to_srgb(c: vec3<f32>) -> vec3<f32> {
    let x = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
    return select(1.055 * pow(x, vec3<f32>(1.0 / 2.4)) - 0.055, x * 12.92, x <= vec3<f32>(0.0031308));
}
fn glt_to_linear(c: vec3<f32>) -> vec3<f32> {
    let x = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
    return select(pow((x + 0.055) / 1.055, vec3<f32>(2.4)), x / 12.92, x <= vec3<f32>(0.04045));
}
fn glt_dec(c: vec4<f32>) -> vec4<f32> {
    let a = clamp(c.a, 0.0, 1.0);
    return vec4<f32>(glt_to_srgb(c.rgb / max(a, 1e-6)), a);
}
fn glt_enc(c: vec4<f32>) -> vec4<f32> {
    let a = clamp(c.a, 0.0, 1.0);
    return vec4<f32>(glt_to_linear(c.rgb) * a, a);
}
// GL Transitions put uv (0, 0) at the bottom left, the engine at the top left.
fn glt_flip(uv: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(uv.x, 1.0 - uv.y);
}
fn getFromColor(uv: vec2<f32>) -> vec4<f32> {
    return glt_dec(outgoing(glt_flip(uv)));
}
fn getToColor(uv: vec2<f32>) -> vec4<f32> {
    return glt_dec(incoming(glt_flip(uv)));
}
"""


def rewrite(wgsl: str, t: dict, globals_: list, pnames: dict) -> str:
    """naga's WGSL for the wrapped shader, rewritten to the engine's transition contract."""
    types = {p["name"]: p["type"] for p in t["params"]}
    samplers = [p["name"] for p in t["params"] if p["type"] == "sampler2D"]
    decls = []
    kept = []
    for it in items(wgsl):
        head = it.split("{")[0]
        if re.match(r"struct\s+FragmentOutput\b", it) or re.match(r"@fragment\s+fn\s+main\b", it) or re.match(r"fn\s+main_1\s*\(", it):
            continue
        m = re.match(r"var<private>\s+(\w+)\s*:", it)
        if m and re.match(r"glt_(uv|color)(_\d+)?$", m.group(1)):
            continue
        if m and len(decls) < len(globals_):
            decls.append(m.group(1))
            continue
        fm = re.match(r"fn\s+(\w+)\s*\(", head)
        if fm and (fm.group(1) in ("getFromColor", "getToColor") or fm.group(1).startswith("glt_img_")):
            continue
        kept.append(it)
    if len(decls) != len(globals_):
        raise ValueError("naga output: could not find every global")
    names = {}
    for glsl_name, wgsl_name in zip(globals_, decls):
        if not re.fullmatch(re.escape(glsl_name) + r"(_\d+)?_?", wgsl_name):
            raise ValueError(f"naga output: global `{wgsl_name}` is not `{glsl_name}`")
        if glsl_name == "progress":
            names[wgsl_name] = "u.progress"
        elif glsl_name == "ratio":
            names[wgsl_name] = "(u.resolution.x / u.resolution.y)"
        else:
            ty, pn = types[glsl_name], pnames[glsl_name]
            names[wgsl_name] = {
                "int": f"i32(p.{pn})",
                "bool": f"(p.{pn} > 0.5)",
                "ivec2": f"vec2<i32>(p.{pn})",
            }.get(ty, f"p.{pn}")
    # Names the engine's wrapper defines (and image functions) must not be shadowed or redefined.
    clash = {n: f"glt_{n}" for n in ENGINE_NAMES + [pnames[s] for s in samplers]}
    clash["transition"] = "glt_main"
    out = []
    for it in kept:
        if it.startswith("struct "):
            # Field names stay; only the struct's uses elsewhere matter.
            out.append(it)
            continue
        it = ident_sub(it, clash)
        it = ident_sub(it, names)
        out.append(it)
    helpers = HELPERS
    for s in samplers:
        helpers += f"fn glt_img_{s}(uv: vec2<f32>) -> vec4<f32> {{\n    return {pnames[s]}(glt_flip(uv));\n}}\n"
    code = "\n\n".join(x if x.endswith("}") or x.endswith(";") else x + ";" for x in out)
    entry = "\nfn transition(uv: vec2<f32>) -> vec4<f32> {\n    return glt_enc(glt_main(glt_flip(uv)));\n}\n"
    return helpers + "\n" + code + "\n" + entry


LEGAL = re.compile(r"author\s*:|license|copyright", re.I)


def header_comment(glsl: str) -> str:
    """The comments the WGSL must carry: the leading header, plus every other comment
    block naming an author, license or copyright (naga drops comments, and BSD
    licenses require keeping the notice). Block comments become `//` lines."""
    blocks, cur, in_block = [], [], False
    for line in glsl.split("\n"):
        t = line.strip()
        if in_block:
            cur.append(line.rstrip())
            if "*/" in t:
                blocks.append(cur)
                cur, in_block = [], False
            continue
        if t.startswith("/*"):
            if cur:
                blocks.append(cur)
            cur, in_block = [line.rstrip()], "*/" not in t
            if not in_block:
                blocks.append(cur)
                cur = []
            continue
        if t.startswith("//"):
            cur.append(line.rstrip())
            continue
        if cur:
            blocks.append(cur)
            cur = []
        if t:
            blocks.append(None)  # code: ends the leading header
    if cur:
        blocks.append(cur)
    keep = []
    leading = True
    for b in blocks:
        if b is None:
            leading = False
            continue
        if leading or any(LEGAL.search(x) for x in b):
            keep.append(b)
    out = []
    for b in keep:
        if out:
            out.append("//")
        for x in b:
            x = x.rstrip()
            if x.lstrip().startswith("//"):
                out.append(x.lstrip())
            else:
                x = x.replace("/*", "").replace("*/", "").rstrip()
                out.append(("// " + x.strip()) if x.strip() else "//")
    while out and out[-1] == "//":
        out.pop()
    return "\n".join(out)


def convert(t: dict, naga: str, work: Path) -> dict:
    pnames = {}
    for p in t["params"]:
        pn = snake(p["name"])
        if pn in pnames.values():
            raise ValueError(f"params `{p['name']}` and another both become `{pn}`")
        pnames[p["name"]] = pn
    files = {}
    props = {}
    for p in t["params"]:
        image = None
        if p["type"] == "sampler2D":
            fname, data = image_for(p["name"])
            files[fname] = base64.b64encode(data).decode()
            image = fname
        props[pnames[p["name"]]] = schema_for(p, image)
    src, globals_ = wrap(t)
    gl = work / f"{t['id']}.frag.glsl"
    out = work / f"{t['id']}.wgsl"
    gl.write_text(src, encoding="utf-8")
    r = subprocess.run([naga, "--input-kind", "glsl", "--shader-stage", "frag", str(gl), str(out)], capture_output=True, text=True)
    if r.returncode != 0:
        msg = (r.stderr or r.stdout).strip()
        raise ValueError("naga: " + "\n".join(msg.splitlines()[:12]))
    body = rewrite(out.read_text(encoding="utf-8"), t, globals_, pnames)
    note = "// Converted from the GL Transitions GLSL to WGSL for the ve engine with naga\n// (snapcut-pro scripts/import_gl_transitions.py). Original header above."
    wgsl = header_comment(t["glsl"]) + "\n//\n" + note + "\n" + body
    credit = ", ".join(x for x in [t["author"] and f"by {t['author']}", f"license {t['license']}", "GL Transitions"] if x)
    manifest = {
        "id": f"project.gl-{t['id']}",
        "version": "1.0.0",
        "kind": "transition",
        "runtime": "wgsl",
        "name": t["name"],
        "description": (t["description"] + " " if t["description"] else "") + f"({credit})",
        "shader": "transition.wgsl",
        "params": {"type": "object", "properties": props},
    }
    return {"manifest": manifest, "wgsl": wgsl, "files": files}


# --- checking against the engine ---


def check_all(ve: str, entries: list, work: Path) -> dict:
    """fx.define dry runs against a scratch project. Returns id -> error for failures."""
    proj = work / "check-project"
    r = subprocess.run([ve, "init", str(proj), "--fps", "30", "--size", "1280x720"], capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"ve init failed: {r.stderr or r.stdout}")
    failures = {}
    try:
        for t in entries:
            e = t["engine"]
            if not e:
                continue
            params = json.dumps({"manifest": e["manifest"], "source": e["wgsl"], "files": e["files"], "dry_run": True})
            r = subprocess.run([ve, "--project", str(proj), "--json", "call", "fx.define", params], capture_output=True, text=True)
            if r.returncode != 0:
                failures[t["id"]] = (r.stderr.strip() or r.stdout.strip())[:2000]
    finally:
        subprocess.run([ve, "--project", str(proj), "daemon", "stop"], capture_output=True, text=True)
    return failures


def main() -> int:
    ap = argparse.ArgumentParser(description="Import and convert GL Transitions.")
    ap.add_argument("repo", type=Path)
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parent.parent / "src" / "gl" / "transitions.json")
    ap.add_argument("--naga", default="naga")
    ap.add_argument("--check", metavar="VE", help="ve binary: validate every converted shader with fx.define dry_run")
    ap.add_argument("--keep", type=Path, help="keep the naga input and output here (debugging)")
    a = ap.parse_args()
    if not shutil.which(a.naga) and not Path(a.naga).is_file():
        print(f"naga not found ({a.naga}); cargo install naga-cli --version 30.0.1")
        return 2
    files = sorted((a.repo / "transitions").glob("*.glsl"), key=lambda p: p.stem.lower())
    if not files:
        print(f"no .glsl files under {a.repo / 'transitions'}")
        return 1
    license_file = next(iter(a.repo.glob("LICENSE*")), None)
    items_ = [parse(f) for f in files]
    ids = [i["id"] for i in items_]
    assert len(ids) == len(set(ids)), "duplicate ids after lowercasing"
    tmp = tempfile.TemporaryDirectory()
    work = a.keep or Path(tmp.name)
    work.mkdir(parents=True, exist_ok=True)
    errors = {}
    for t in items_:
        try:
            t["engine"] = convert(t, a.naga, work)
        except ValueError as e:
            t["engine"] = None
            errors[t["id"]] = str(e)
    if a.check:
        for k, v in check_all(a.check, items_, work).items():
            errors[k] = "fx.define: " + v
            next(t for t in items_ if t["id"] == k)["engine"] = None
    for t in items_:
        if t["id"] in errors:
            t["engine_error"] = errors[t["id"]]
    doc = {
        "source": "https://github.com/gl-transitions/gl-transitions",
        "note": "Each shader keeps its own author and license; see its header in `glsl` (copied into the WGSL too).",
        "repo_license": license_file.read_text(encoding="utf-8", errors="replace") if license_file else "",
        "transitions": items_,
    }
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    licenses = {}
    for i in items_:
        licenses[i["license"]] = licenses.get(i["license"], 0) + 1
    ok = sum(1 for t in items_ if t["engine"])
    print(f"{len(items_)} transitions -> {a.out}")
    print(f"converted: {ok}{' (checked with fx.define)' if a.check else ' (not checked; pass --check ve)'}")
    print("licenses:", licenses)
    print("param types:", sorted({p['type'] for i in items_ for p in i['params']}))
    for k, v in errors.items():
        print(f"FAILED {k}: {v.splitlines()[0] if v else ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
