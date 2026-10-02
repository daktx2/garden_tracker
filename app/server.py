"""Garden Tracker - a tiny, dependency-free garden planner and harvest tracker.

Standard library only (http.server + sqlite3) so it idles at ~15-25 MB RAM.
"""
import csv
import io
import json
import mimetypes
import os
import re
import sqlite3
import sys
from datetime import date, datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

DATA_DIR = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(__file__), "data"))
DB_PATH = os.path.join(DATA_DIR, "garden.db")
STATIC_DIR = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "static"))
PORT = int(os.environ.get("PORT", "8080"))
MAX_DIM = 200  # max garden width/height in feet
MAX_HISTORY = 3_000_000  # max bytes of saved undo/redo history per plan
UNITS = ("lb", "oz", "kg", "g", "count", "bunch")

# Default colors handed out in order to new crops (validated categorical order).
DEFAULT_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4",
                  "#008300", "#4a3aa7", "#e34948", "#7a5c3e", "#5a9bb0",
                  "#a3a13a", "#8c4f9f"]

SCHEMA = """
CREATE TABLE IF NOT EXISTS crops (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    color TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT 'lb'
);
CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    year INTEGER NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plan_cells (
    plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    crop_id INTEGER NOT NULL REFERENCES crops(id) ON DELETE CASCADE,
    variety TEXT NOT NULL DEFAULT '',
    rating INTEGER NOT NULL DEFAULT 0,   -- 1 liked, 0 no rating, -1 disliked, 2 okay
    note TEXT NOT NULL DEFAULT '',
    grp INTEGER NOT NULL DEFAULT 0,      -- label block; 0 = merge with touching squares of same crop
    PRIMARY KEY (plan_id, x, y)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS plan_history (
    plan_id INTEGER PRIMARY KEY REFERENCES plans(id) ON DELETE CASCADE,
    data TEXT NOT NULL                   -- JSON {"undo": [...], "redo": [...]} saved by the planner
);
CREATE TABLE IF NOT EXISTS harvests (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    crop_id INTEGER NOT NULL REFERENCES crops(id),
    amount REAL NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_harvests_date ON harvests(date);
"""


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    with db() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)
        # Migrations for databases created by older versions
        cols = {r[1] for r in conn.execute("PRAGMA table_info(plan_cells)")}
        for col, ddl in (("variety", "TEXT NOT NULL DEFAULT ''"),
                         ("rating", "INTEGER NOT NULL DEFAULT 0"),
                         ("note", "TEXT NOT NULL DEFAULT ''"),
                         ("grp", "INTEGER NOT NULL DEFAULT 0")):
            if col not in cols:
                conn.execute(f"ALTER TABLE plan_cells ADD COLUMN {col} {ddl}")


def now():
    return datetime.now().isoformat(timespec="seconds")


def rows(cursor):
    return [dict(r) for r in cursor.fetchall()]


# ---------- validation helpers ----------

def req_str(body, key, max_len=100, required=True, default=""):
    val = body.get(key, default)
    if val is None:
        val = default
    if not isinstance(val, str):
        raise ApiError(400, f"'{key}' must be text")
    val = val.strip()
    if required and not val:
        raise ApiError(400, f"'{key}' is required")
    if len(val) > max_len:
        raise ApiError(400, f"'{key}' is too long (max {max_len})")
    return val


def req_int(body, key, lo, hi):
    val = body.get(key)
    try:
        val = int(val)
    except (TypeError, ValueError):
        raise ApiError(400, f"'{key}' must be a whole number")
    if not lo <= val <= hi:
        raise ApiError(400, f"'{key}' must be between {lo} and {hi}")
    return val


def req_color(body, key="color"):
    val = req_str(body, key, 7)
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", val):
        raise ApiError(400, "color must look like #a1b2c3")
    return val.lower()


def req_date(body, key="date"):
    val = req_str(body, key, 10)
    try:
        date.fromisoformat(val)
    except ValueError:
        raise ApiError(400, "date must be YYYY-MM-DD")
    return val


def req_amount(body):
    try:
        val = float(body.get("amount"))
    except (TypeError, ValueError):
        raise ApiError(400, "amount must be a number")
    if not 0 < val < 1e6:
        raise ApiError(400, "amount must be greater than 0")
    return round(val, 3)


def req_unit(body):
    val = body.get("unit", "lb")
    if val not in UNITS:
        raise ApiError(400, f"unit must be one of {', '.join(UNITS)}")
    return val


# ---------- API handlers ----------

def list_crops(conn, q, body):
    return rows(conn.execute("""
        SELECT c.*,
               (SELECT COUNT(*) FROM harvests h WHERE h.crop_id = c.id) AS harvest_count,
               (SELECT COUNT(*) FROM plan_cells p WHERE p.crop_id = c.id) AS cell_count
        FROM crops c ORDER BY c.name COLLATE NOCASE"""))


def create_crop(conn, q, body):
    name = req_str(body, "name", 40)
    if "color" in body and body["color"]:
        color = req_color(body)
    else:
        n = conn.execute("SELECT COUNT(*) FROM crops").fetchone()[0]
        color = DEFAULT_COLORS[n % len(DEFAULT_COLORS)]
    unit = req_unit(body)
    try:
        cur = conn.execute("INSERT INTO crops (name, color, unit) VALUES (?, ?, ?)",
                           (name, color, unit))
    except sqlite3.IntegrityError:
        raise ApiError(409, f"A crop named '{name}' already exists")
    return dict(conn.execute("SELECT * FROM crops WHERE id = ?", (cur.lastrowid,)).fetchone())


def update_crop(conn, q, body, crop_id):
    get_or_404(conn, "crops", crop_id)
    name = req_str(body, "name", 40)
    color = req_color(body)
    unit = req_unit(body)
    try:
        conn.execute("UPDATE crops SET name = ?, color = ?, unit = ? WHERE id = ?",
                     (name, color, unit, crop_id))
    except sqlite3.IntegrityError:
        raise ApiError(409, f"A crop named '{name}' already exists")
    return dict(conn.execute("SELECT * FROM crops WHERE id = ?", (crop_id,)).fetchone())


def delete_crop(conn, q, body, crop_id):
    get_or_404(conn, "crops", crop_id)
    n = conn.execute("SELECT COUNT(*) FROM harvests WHERE crop_id = ?", (crop_id,)).fetchone()[0]
    if n:
        raise ApiError(409, f"This crop has {n} harvest entries. Delete those first "
                            "(this protects your harvest history).")
    conn.execute("DELETE FROM crops WHERE id = ?", (crop_id,))
    return {"ok": True}


def get_or_404(conn, table, item_id):
    row = conn.execute(f"SELECT * FROM {table} WHERE id = ?", (item_id,)).fetchone()
    if row is None:
        raise ApiError(404, "Not found")
    return dict(row)


def list_plans(conn, q, body):
    return rows(conn.execute("""
        SELECT id, name, year, width, height, updated_at FROM plans
        ORDER BY year DESC, id DESC"""))


def plan_with_cells(conn, plan_id):
    plan = get_or_404(conn, "plans", plan_id)
    plan["cells"] = [list(r) for r in conn.execute(
        "SELECT x, y, crop_id, variety, rating, note, grp FROM plan_cells WHERE plan_id = ?",
        (plan_id,))]
    return plan


def get_plan(conn, q, body, plan_id):
    plan = plan_with_cells(conn, plan_id)
    row = conn.execute("SELECT data FROM plan_history WHERE plan_id = ?", (plan_id,)).fetchone()
    plan["history"] = json.loads(row[0]) if row else None
    return plan


def save_history(conn, plan_id, history):
    """Store the planner's undo/redo stacks so they survive reloads. The client keeps them
    under the size cap; anything malformed or too big is ignored so the plan still saves."""
    if not (isinstance(history, dict) and isinstance(history.get("undo"), list)
            and isinstance(history.get("redo"), list)):
        return
    data = json.dumps({"undo": history["undo"], "redo": history["redo"]}, separators=(",", ":"))
    if len(data) <= MAX_HISTORY:
        conn.execute("INSERT OR REPLACE INTO plan_history (plan_id, data) VALUES (?, ?)",
                     (plan_id, data))


def create_plan(conn, q, body):
    name = req_str(body, "name", 60)
    year = req_int(body, "year", 1900, 2200)
    width = req_int(body, "width", 1, MAX_DIM)
    height = req_int(body, "height", 1, MAX_DIM)
    ts = now()
    cur = conn.execute(
        "INSERT INTO plans (name, year, width, height, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?)", (name, year, width, height, ts, ts))
    plan_id = cur.lastrowid
    copy_from = body.get("copy_from")
    if copy_from:
        try:
            copy_from = int(copy_from)
        except (TypeError, ValueError):
            raise ApiError(400, "copy_from must be a plan id")
        src = get_or_404(conn, "plans", copy_from)
        # Varieties carry over to the new plan; ratings and notes belong to the old season.
        conn.execute("""
            INSERT INTO plan_cells (plan_id, x, y, crop_id, variety, grp)
            SELECT ?, x, y, crop_id, variety, grp FROM plan_cells
            WHERE plan_id = ? AND x < ? AND y < ?""", (plan_id, src["id"], width, height))
        conn.execute("UPDATE plans SET notes = ? WHERE id = ?", (src["notes"], plan_id))
    return plan_with_cells(conn, plan_id)


def update_plan(conn, q, body, plan_id):
    get_or_404(conn, "plans", plan_id)
    name = req_str(body, "name", 60)
    year = req_int(body, "year", 1900, 2200)
    width = req_int(body, "width", 1, MAX_DIM)
    height = req_int(body, "height", 1, MAX_DIM)
    notes = req_str(body, "notes", 5000, required=False)
    conn.execute("UPDATE plans SET name=?, year=?, width=?, height=?, notes=?, updated_at=? "
                 "WHERE id=?", (name, year, width, height, notes, now(), plan_id))
    if "cells" in body:
        cells = body["cells"]
        if not isinstance(cells, list):
            raise ApiError(400, "cells must be a list")
        valid_crops = {r[0] for r in conn.execute("SELECT id FROM crops")}
        clean = []
        for c in cells:
            try:
                x, y, crop_id = int(c[0]), int(c[1]), int(c[2])
                variety = str(c[3] if len(c) > 3 and c[3] else "").strip()[:80]
                rating = int(c[4]) if len(c) > 4 and c[4] else 0
                note = str(c[5] if len(c) > 5 and c[5] else "")[:2000]
                grp = int(c[6]) if len(c) > 6 and c[6] else 0
            except (TypeError, ValueError, IndexError):
                raise ApiError(400, "each cell must be [x, y, crop_id, variety, rating, note, group]")
            if rating not in (-1, 0, 1, 2):
                rating = 0
            if not 0 <= grp < 2**31:
                grp = 0
            if 0 <= x < width and 0 <= y < height and crop_id in valid_crops:
                clean.append((plan_id, x, y, crop_id, variety, rating, note, grp))
        conn.execute("DELETE FROM plan_cells WHERE plan_id = ?", (plan_id,))
        conn.executemany("INSERT OR REPLACE INTO plan_cells "
                         "(plan_id, x, y, crop_id, variety, rating, note, grp) "
                         "VALUES (?, ?, ?, ?, ?, ?, ?, ?)", clean)
    else:
        conn.execute("DELETE FROM plan_cells WHERE plan_id = ? AND (x >= ? OR y >= ?)",
                     (plan_id, width, height))
    if "history" in body:
        save_history(conn, plan_id, body["history"])
    return plan_with_cells(conn, plan_id)


def delete_plan(conn, q, body, plan_id):
    get_or_404(conn, "plans", plan_id)
    conn.execute("DELETE FROM plans WHERE id = ?", (plan_id,))
    return {"ok": True}


def harvest_query(q):
    year = q.get("year", [None])[0]
    sql = """SELECT h.id, h.date, h.crop_id, h.amount, h.notes,
                    c.name AS crop, c.color, c.unit
             FROM harvests h JOIN crops c ON c.id = h.crop_id"""
    args = ()
    if year:
        if not year.isdigit():
            raise ApiError(400, "year must be a number")
        sql += " WHERE h.date >= ? AND h.date <= ?"
        args = (f"{year}-01-01", f"{year}-12-31")
    return sql + " ORDER BY h.date DESC, h.id DESC", args


def list_harvests(conn, q, body):
    sql, args = harvest_query(q)
    return rows(conn.execute(sql, args))


def harvest_years(conn, q, body):
    return [int(r[0]) for r in conn.execute(
        "SELECT DISTINCT substr(date, 1, 4) FROM harvests ORDER BY 1 DESC")]


def harvest_body(conn, body):
    d = req_date(body)
    crop_id = req_int(body, "crop_id", 1, 10**9)
    get_or_404(conn, "crops", crop_id)
    return d, crop_id, req_amount(body), req_str(body, "notes", 500, required=False)


def create_harvest(conn, q, body):
    d, crop_id, amount, notes = harvest_body(conn, body)
    cur = conn.execute("INSERT INTO harvests (date, crop_id, amount, notes, created_at) "
                       "VALUES (?, ?, ?, ?, ?)", (d, crop_id, amount, notes, now()))
    return {"id": cur.lastrowid}


def update_harvest(conn, q, body, harvest_id):
    get_or_404(conn, "harvests", harvest_id)
    d, crop_id, amount, notes = harvest_body(conn, body)
    conn.execute("UPDATE harvests SET date=?, crop_id=?, amount=?, notes=? WHERE id=?",
                 (d, crop_id, amount, notes, harvest_id))
    return {"id": harvest_id}


def delete_harvest(conn, q, body, harvest_id):
    get_or_404(conn, "harvests", harvest_id)
    conn.execute("DELETE FROM harvests WHERE id = ?", (harvest_id,))
    return {"ok": True}


ROUTES = [
    ("GET", r"/api/crops", list_crops),
    ("POST", r"/api/crops", create_crop),
    ("PUT", r"/api/crops/(\d+)", update_crop),
    ("DELETE", r"/api/crops/(\d+)", delete_crop),
    ("GET", r"/api/plans", list_plans),
    ("POST", r"/api/plans", create_plan),
    ("GET", r"/api/plans/(\d+)", get_plan),
    ("PUT", r"/api/plans/(\d+)", update_plan),
    ("DELETE", r"/api/plans/(\d+)", delete_plan),
    ("GET", r"/api/harvests", list_harvests),
    ("POST", r"/api/harvests", create_harvest),
    ("PUT", r"/api/harvests/(\d+)", update_harvest),
    ("DELETE", r"/api/harvests/(\d+)", delete_harvest),
    ("GET", r"/api/harvest-years", harvest_years),
]
ROUTES = [(m, re.compile(p + r"$"), fn) for m, p, fn in ROUTES]


class Handler(BaseHTTPRequestHandler):
    server_version = "GardenTracker/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("ACCESS_LOG"):
            super().log_message(fmt, *args)

    def send_bytes(self, status, data, ctype, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def send_json(self, status, obj):
        self.send_bytes(status, json.dumps(obj).encode(), "application/json",
                        {"Cache-Control": "no-store"})

    def do_GET(self):
        self.dispatch("GET")

    def do_HEAD(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def dispatch(self, method):
        url = urlparse(self.path)
        try:
            if url.path.startswith("/api/"):
                self.handle_api(method, url)
            elif method == "GET":
                self.serve_static(url.path)
            else:
                raise ApiError(405, "Method not allowed")
        except ApiError as e:
            self.close_connection = True  # request body may be unread
            self.send_json(e.status, {"error": e.message})
        except Exception as e:  # noqa: BLE001 - last-resort error reporting
            print(f"Error handling {method} {self.path}: {e!r}", file=sys.stderr)
            self.close_connection = True
            self.send_json(500, {"error": "Server error"})

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 5_000_000:
            raise ApiError(413, "Request too large")
        if not length:
            return {}
        try:
            body = json.loads(self.rfile.read(length))
        except json.JSONDecodeError:
            raise ApiError(400, "Invalid JSON")
        if not isinstance(body, dict):
            raise ApiError(400, "Expected a JSON object")
        return body

    def handle_api(self, method, url):
        q = parse_qs(url.query)
        if method == "GET" and url.path == "/api/export/harvests.csv":
            return self.export_csv(q)
        for m, pattern, fn in ROUTES:
            match = pattern.match(url.path)
            if match and m == method:
                body = self.read_body() if method in ("POST", "PUT") else {}
                args = [int(a) for a in match.groups()]
                conn = db()
                try:
                    with conn:
                        result = fn(conn, q, body, *args)
                finally:
                    conn.close()
                return self.send_json(201 if method == "POST" else 200, result)
        raise ApiError(404, "Unknown API route")

    def export_csv(self, q):
        sql, args = harvest_query(q)
        conn = db()
        try:
            data = rows(conn.execute(sql, args))
        finally:
            conn.close()
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["date", "crop", "amount", "unit", "notes"])
        for r in reversed(data):
            w.writerow([r["date"], r["crop"], r["amount"], r["unit"], r["notes"]])
        year = q.get("year", ["all"])[0]
        self.send_bytes(200, buf.getvalue().encode("utf-8"), "text/csv; charset=utf-8", {
            "Content-Disposition": f'attachment; filename="harvests-{year}.csv"'})

    def serve_static(self, path):
        if path == "/":
            path = "/index.html"
        full = os.path.realpath(os.path.join(STATIC_DIR, path.lstrip("/")))
        if not full.startswith(STATIC_DIR + os.sep) or not os.path.isfile(full):
            raise ApiError(404, "Not found")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        with open(full, "rb") as f:
            self.send_bytes(200, f.read(), ctype, {"Cache-Control": "no-cache"})


def main():
    init_db()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    print(f"Garden Tracker listening on port {PORT}, data in {DATA_DIR}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
