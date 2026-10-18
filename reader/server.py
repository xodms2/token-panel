"""Token dashboard for Claude Code sessions.

Reads the session logs Claude Code writes under ~/.claude/projects/ (one .jsonl
per session, subagents under <session>/subagents/), totals tokens and API-price
cost per project and per session (tab), and tells whether each session's prompt
cache is still alive and what rereading the whole session would cost.

Run:  python server.py [port]      then open http://127.0.0.1:8777
      python server.py --once      read new lines, write summary.json, exit
                                   (the token panel runs this when no server is up)
Files are read incrementally (only new bytes each pass) and the totals are kept
in state.pickle, so only the first start reads everything.

Everything it writes goes to ~/.claude/token-panel/ (the Claude config folder
is $CLAUDE_CONFIG_DIR when set), never next to this file, so updating the
plugin keeps each person's cache and settings.
"""
import json
import os
import pickle
import re
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
PROJECTS = CONFIG / "projects"
DATA = CONFIG / "token-panel"
STATE_FILE = DATA / "state.pickle"
SUMMARY_FILE = DATA / "summary.json"
STATE_VERSION = 5
ONCE = "--once" in sys.argv
_args = [a for a in sys.argv[1:] if not a.startswith("--")]
PORT = int(_args[0]) if _args else 8777
RESCAN_SECONDS = 5

# USD per million tokens: input, output, cache read. Writes are 1.25x input
# (5-minute TTL) and 2x input (1-hour TTL). Anthropic list prices as of 2026-10:
# update this table when prices change, or the dollar figures drift.
PRICES = {
    "claude-fable-5-1": (10.0, 50.0, 0.25),
    "claude-mythos-5-1": (10.0, 50.0, 0.25),
    "claude-fable-5": (10.0, 50.0, 1.0),
    "claude-mythos-5": (10.0, 50.0, 1.0),
    "claude-opus-5-5": (4.0, 20.0, 0.20),
    "claude-opus-5": (5.0, 25.0, 0.50),
    "claude-opus-4": (5.0, 25.0, 0.50),
    "claude-sonnet-5-5": (2.0, 10.0, 0.20),
    "claude-sonnet-5": (2.0, 10.0, 0.20),
    "claude-sonnet-4": (3.0, 15.0, 0.30),
    "claude-haiku-5-5": (0.10, 0.50, 0.01),
    "claude-haiku-4": (1.0, 5.0, 0.10),
}
DEFAULT_MODEL = "claude-opus-5-5"
_PREFIXES = sorted(PRICES, key=len, reverse=True)
WEB_SEARCH_USD = 0.01  # per request
TTL_SECONDS = {"5m": 300, "1h": 3600}


def price(model, speed="standard"):
    for p in _PREFIXES:
        if model and model.startswith(p):
            inp, out, read = PRICES[p]
            break
    else:
        inp, out, read = PRICES[DEFAULT_MODEL]
    mult = 2.0 if speed == "fast" else 1.0
    return {"in": inp * mult, "out": out * mult, "read": read * mult,
            "w5": inp * 1.25 * mult, "w1h": inp * 2.0 * mult}


def new_file_rec(path, project, session, is_sub):
    return {
        "path": path, "project": project, "session": session, "is_sub": is_sub,
        "offset": 0, "size": 0, "title": None, "first_prompt": None, "cwd": None,
        "calls": 0, "inp": 0, "out": 0, "cr": 0, "cw5": 0, "cw1h": 0, "cost": 0.0,
        "models": {}, "first_ts": None, "last_ts": None, "last_ctx": 0,
        "last_model": None, "last_ttl": "5m", "last_speed": "standard",
        "last_id": None, "days": {},
    }


class Store:
    def __init__(self):
        self.lock = threading.Lock()
        self.files = {}
        self.seen = set()  # message ids already counted, across all files
        self.scanning = True
        self.scan_done = 0
        self.scan_total = 0
        self.last_scan = 0.0
        self._load()

    def _load(self):
        try:
            with open(STATE_FILE, "rb") as f:
                data = pickle.load(f)
            if data.get("version") == STATE_VERSION:
                self.files = data["files"]
                self.seen = data["seen"]
        except Exception:
            self.files = {}

    def _save(self):
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = STATE_FILE.with_suffix(".tmp")
        with self.lock:
            blob = pickle.dumps({"version": STATE_VERSION, "files": self.files,
                                 "seen": self.seen})
        tmp.write_bytes(blob)
        os.replace(tmp, STATE_FILE)

    def discover(self):
        found = []
        if not PROJECTS.exists():
            return found
        for proj in PROJECTS.iterdir():
            if not proj.is_dir():
                continue
            for f in proj.glob("*.jsonl"):
                found.append((str(f), proj.name, f.stem, False))
            for f in proj.glob("*/subagents/*.jsonl"):
                found.append((str(f), proj.name, f.parent.parent.name, True))
        return found

    def scan(self):
        found = self.discover()
        work = []
        for path, project, session, is_sub in found:
            try:
                size = os.path.getsize(path)
            except OSError:
                continue
            rec = self.files.get(path)
            if rec is None or size < rec["offset"]:
                rec = new_file_rec(path, project, session, is_sub)
                with self.lock:
                    self.files[path] = rec
            if size > rec["offset"]:
                work.append((rec, size))
        self.scan_total = sum(size - rec["offset"] for rec, size in work)
        self.scan_done = 0
        changed = bool(work)
        # Oldest files first: a resumed or forked session copies earlier replies
        # into its new file, and the copy must not be counted a second time.
        for rec, size in sorted(work, key=lambda w: os.path.getctime(w[0]["path"])):
            self._read_file(rec)
        self.last_scan = time.time()
        if changed or self.scanning:
            self.scanning = False
            self._save()
        self._write_summary()

    def _write_summary(self):
        """A small file the token-panel mod reads: totals and the recent tabs."""
        snap = self.snapshot()
        now = snap["now"]
        today = datetime.now().strftime("%Y-%m-%d")
        week = {datetime.fromtimestamp(now - i * 86400).strftime("%Y-%m-%d") for i in range(7)}
        tot = {"today": 0.0, "week": 0.0, "today_tokens": 0}
        for s in snap["sessions"]:
            for day, (c, t) in s["days"].items():
                if day == today:
                    tot["today"] += c
                    tot["today_tokens"] += t
                if day in week:
                    tot["week"] += c
        keep = ("id", "title", "first_prompt", "project_label", "last_ts", "ttl_seconds",
                "last_ttl", "last_ctx", "reread_warm", "reread_cold", "cost", "calls",
                "last_model")
        recent = sorted((s for s in snap["sessions"] if s["last_ts"] and now - s["last_ts"] < 14 * 86400),
                        key=lambda s: -s["last_ts"])[:40]
        out = {"written": now, **tot, "sessions": [{k: s[k] for k in keep} for s in recent]}
        SUMMARY_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = SUMMARY_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(out), encoding="utf-8")
        os.replace(tmp, SUMMARY_FILE)

    def _read_file(self, rec):
        try:
            f = open(rec["path"], "rb")
        except OSError:
            return
        with f:
            f.seek(rec["offset"])
            pos = rec["offset"]
            processed = 0
            for line in f:
                if not line.endswith(b"\n"):
                    break  # still being written; read it next pass
                pos += len(line)
                processed += len(line)
                try:
                    self._line(rec, line)
                except Exception:
                    pass
                if processed > 8_000_000:
                    self.scan_done += processed
                    processed = 0
                    rec["offset"] = pos
            self.scan_done += processed
            rec["offset"] = pos
            rec["size"] = pos

    def _line(self, rec, line):
        if b'"usage"' in line and b'"assistant"' in line:
            d = json.loads(line)
            if d.get("type") != "assistant":
                return
            m = d.get("message") or {}
            u = m.get("usage")
            model = m.get("model") or ""
            if not u or model.startswith("<"):
                return
            mid = m.get("id") or d.get("requestId")
            if mid:
                if mid in self.seen:
                    return  # logged once per content block, and copied on resume
                self.seen.add(mid)
            self._usage(rec, d, m, u, model)
        elif b'"custom-title"' in line or b'"ai-title"' in line:
            d = json.loads(line)
            t = d.get("customTitle") or d.get("aiTitle")
            if t and (d.get("type") == "custom-title" or not rec["title"]):
                rec["title"] = t
        elif rec["first_prompt"] is None and b'"type":"user"' in line and len(line) < 50_000:
            d = json.loads(line)
            if d.get("type") == "user" and not d.get("isSidechain") and not d.get("isMeta"):
                c = (d.get("message") or {}).get("content")
                if isinstance(c, list):
                    c = next((b.get("text") for b in c
                              if isinstance(b, dict) and b.get("type") == "text"), None)
                if isinstance(c, str) and c.strip() and not c.lstrip().startswith("<"):
                    rec["first_prompt"] = " ".join(c.split())[:120]
                if not rec["cwd"]:
                    rec["cwd"] = d.get("cwd")
                if d.get("cwd"):
                    rec.setdefault("cwds", set()).add(d["cwd"])

    def _usage(self, rec, d, m, u, model):
        speed = u.get("speed") or "standard"
        inp = u.get("input_tokens") or 0
        out = u.get("output_tokens") or 0
        cr = u.get("cache_read_input_tokens") or 0
        cw = u.get("cache_creation_input_tokens") or 0
        cc = u.get("cache_creation") or {}
        w1h = cc.get("ephemeral_1h_input_tokens") or 0
        w5 = cc.get("ephemeral_5m_input_tokens") or 0
        if cw and not (w1h or w5):
            w5 = cw
        searches = (u.get("server_tool_use") or {}).get("web_search_requests") or 0
        p = price(model, speed)
        cost = (inp * p["in"] + out * p["out"] + cr * p["read"]
                + w5 * p["w5"] + w1h * p["w1h"]) / 1e6 + searches * WEB_SEARCH_USD

        ts = d.get("timestamp")
        epoch = None
        if ts:
            epoch = datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
        rec["calls"] += 1
        rec["inp"] += inp
        rec["out"] += out
        rec["cr"] += cr
        rec["cw5"] += w5
        rec["cw1h"] += w1h
        rec["cost"] += cost
        rec["models"][model] = rec["models"].get(model, 0) + cost
        rec["cwd"] = d.get("cwd") or rec["cwd"]  # latest: a tab can move folders
        if rec["cwd"]:
            rec.setdefault("cwds", set()).add(rec["cwd"])
        if epoch:
            if rec["first_ts"] is None or epoch < rec["first_ts"]:
                rec["first_ts"] = epoch
            if rec["last_ts"] is None or epoch >= rec["last_ts"]:
                rec["last_ts"] = epoch
                rec["last_ctx"] = inp + cr + cw
                rec["last_model"] = model
                rec["last_speed"] = speed
                if w1h:
                    rec["last_ttl"] = "1h"
                elif w5:
                    rec["last_ttl"] = "5m"
            day = datetime.fromtimestamp(epoch).strftime("%Y-%m-%d")
            dd = rec["days"].setdefault(day, [0.0, 0])
            dd[0] += cost
            dd[1] += inp + out + cr + w5 + w1h

    # ---- the view the page reads ----
    def snapshot(self):
        with self.lock:
            files = list(self.files.values())
        sessions = {}
        for r in files:
            key = (r["project"], r["session"])
            s = sessions.get(key)
            if s is None:
                s = sessions[key] = {
                    "id": r["session"], "project": r["project"], "title": None,
                    "first_prompt": None, "cwd": None, "calls": 0, "inp": 0,
                    "out": 0, "cr": 0, "cw5": 0, "cw1h": 0, "cost": 0.0,
                    "sub_cost": 0.0, "subagents": 0, "models": {},
                    "first_ts": None, "last_ts": None, "last_ctx": 0,
                    "last_model": None, "last_ttl": "5m", "last_speed": "standard",
                    "days": {},
                }
            for k in ("calls", "inp", "out", "cr", "cw5", "cw1h", "cost"):
                s[k] += r[k]
            for mdl, c in r["models"].items():
                s["models"][mdl] = s["models"].get(mdl, 0) + c
            for day, (c, t) in r["days"].items():
                dd = s["days"].setdefault(day, [0.0, 0])
                dd[0] += c
                dd[1] += t
            if r["first_ts"] and (s["first_ts"] is None or r["first_ts"] < s["first_ts"]):
                s["first_ts"] = r["first_ts"]
            s["cwd"] = s["cwd"] or r["cwd"]
            s.setdefault("_cwds", set()).update(r.get("cwds", ()))
            if r["is_sub"]:
                s["sub_cost"] += r["cost"]
                s["subagents"] += 1
                if r["last_ts"] and (s["last_ts"] is None or r["last_ts"] > s["last_ts"]) and not s.get("_main"):
                    s["last_ts"] = r["last_ts"]
            else:
                s["_main"] = True
                s["title"] = r["title"]
                s["first_prompt"] = r["first_prompt"]
                s["cwd"] = r["cwd"] or s["cwd"]
                # The cache that matters for the tab is the main thread's.
                s["last_ts"] = r["last_ts"]
                s["last_ctx"] = r["last_ctx"]
                s["last_model"] = r["last_model"]
                s["last_ttl"] = r["last_ttl"]
                s["last_speed"] = r["last_speed"]
        out = []
        for s in sessions.values():
            s.pop("_main", None)
            if not s["calls"]:
                continue
            p = price(s["last_model"], s["last_speed"])
            ctx = s["last_ctx"]
            s["reread_warm"] = ctx * p["read"] / 1e6
            s["reread_cold"] = ctx * (p["w1h"] if s["last_ttl"] == "1h" else p["w5"]) / 1e6
            s["ttl_seconds"] = TTL_SECONDS[s["last_ttl"]]
            out.append(s)
        # One name per project folder: the folder path it was named after
        # (Claude Code names it by the path with every other character as "-").
        roots = {}
        for s in out:
            for c in s.pop("_cwds", ()):
                if re.sub(r"[^A-Za-z0-9]", "-", c) == s["project"]:
                    roots[s["project"]] = c
        for s in out:
            s["project_label"] = project_label(s["project"], roots.get(s["project"], s["cwd"]))
        return {
            "now": time.time(),
            "scanning": self.scanning,
            "scan_done": self.scan_done,
            "scan_total": self.scan_total,
            "last_scan": self.last_scan,
            "sessions": out,
            "prices": {k: price(k) for k in PRICES},
        }


def project_label(folder, cwd):
    if "scratch-workspaces" in folder:
        parts = folder.split("-scratch-")
        return "Scratch " + (parts[-1][:10] if len(parts) > 1 else "")
    if cwd:
        return Path(cwd).name
    return folder.split("-")[-1]


STORE = Store()


def scanner():
    while True:
        try:
            STORE.scan()
        except Exception as e:  # keep the loop alive
            print("scan error:", e, file=sys.stderr)
        time.sleep(RESCAN_SECONDS)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(HERE / "web"), **kw)

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith("/api/data"):
            body = json.dumps(STORE.snapshot()).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


if __name__ == "__main__":
    if ONCE:
        STORE.scan()
        sys.exit(0)
    threading.Thread(target=scanner, daemon=True).start()
    print(f"Token dashboard on http://127.0.0.1:{PORT}  (reading {PROJECTS})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
