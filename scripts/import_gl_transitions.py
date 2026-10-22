"""Collect the GL Transitions shaders into ui/src/gl/transitions.json for the editor's preview cards.

    git clone --depth 1 https://github.com/gl-transitions/gl-transitions.git <dir>
    python -I scripts/import_gl_transitions.py <dir> [out.json]

Each entry keeps the shader's own source and header (author, license) untouched.
The output is data only: the preview renders the original GLSL in WebGL. The
engine's WGSL versions are a separate step.
"""
import json
import re
import sys
from pathlib import Path

HEADER = re.compile(r"^\s*//\s*(author|license|description|tags)\s*:\s*(.*?)\s*$", re.I)
UNIFORM = re.compile(r"^\s*uniform\s+(\w+)\s+(\w+)\s*;\s*(?://\s*=\s*(.*?))?\s*$")
PARAM_DOC = re.compile(r"^\s*//\s*@param\s+(.*?)\s*$")


def parse(path: Path) -> dict:
    text = path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    meta = {"author": "", "license": "", "description": "", "tags": ""}
    params = []
    doc = None
    for line in text.split("\n"):
        h = HEADER.match(line)
        if h and not params:
            meta[h.group(1).lower()] = h.group(2).strip()
            continue
        d = PARAM_DOC.match(line)
        if d:
            doc = d.group(1)
            continue
        u = UNIFORM.match(line)
        if u:
            params.append({"type": u.group(1), "name": u.group(2), "default": (u.group(3) or "").strip(), "doc": doc or ""})
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


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    repo = Path(sys.argv[1])
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parent.parent / "src" / "gl" / "transitions.json"
    files = sorted((repo / "transitions").glob("*.glsl"), key=lambda p: p.stem.lower())
    if not files:
        print(f"no .glsl files under {repo / 'transitions'}")
        return 1
    license_file = next(iter(repo.glob("LICENSE*")), None)
    items = [parse(f) for f in files]
    ids = [i["id"] for i in items]
    assert len(ids) == len(set(ids)), "duplicate ids after lowercasing"
    doc = {
        "source": "https://github.com/gl-transitions/gl-transitions",
        "note": "Each shader keeps its own author and license; see its header in `glsl`.",
        "repo_license": license_file.read_text(encoding="utf-8", errors="replace") if license_file else "",
        "transitions": items,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    licenses = {}
    for i in items:
        licenses[i["license"]] = licenses.get(i["license"], 0) + 1
    print(f"{len(items)} transitions -> {out}")
    print("licenses:", licenses)
    print("param types:", sorted({p['type'] for i in items for p in i['params']}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
