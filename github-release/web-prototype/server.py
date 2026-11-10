"""無礙智瞳 網頁原型 v0.1 的簡易伺服器（只用 Python 標準函式庫）。

功能：
  - 提供 web/ 底下的網頁
  - /api/config                  讀取路段、動線、障礙類別設定
  - /api/events        GET/POST  共享路況事件（同一個 id 重送只建立一筆）
  - /api/events/<id>/status POST 治理端更新狀態：待確認 → 現地確認 → 已排除

執行：
  python server.py                       # http://localhost:8000
  python server.py --host 0.0.0.0        # 讓同一個 Wi-Fi 的手機連線
  python server.py --host 0.0.0.0 --cert cert.pem --key key.pem   # HTTPS（手機開鏡頭、麥克風需要）

這是展示用原型：沒有帳號、沒有權限控管，請勿放上公開網路。
"""

from __future__ import annotations

import argparse
import json
import re
import ssl
import threading
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
DATA_DIR = ROOT / "data"
EVENTS_FILE = DATA_DIR / "events.json"
CONFIG_FILE = ROOT / "config.json"

STATUSES = ("待確認", "現地確認", "已排除")
SOURCES = ("auto", "manual", "trigger")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
TZ = timezone(timedelta(hours=8))

_lock = threading.Lock()


def now_iso() -> str:
    return datetime.now(TZ).isoformat(timespec="seconds")


def load_config() -> dict:
    return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))


def load_events() -> list[dict]:
    if not EVENTS_FILE.exists():
        return []
    try:
        return json.loads(EVENTS_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []


def save_events(events: list[dict]) -> None:
    DATA_DIR.mkdir(exist_ok=True)
    tmp = EVENTS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(events, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(EVENTS_FILE)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    # 讓 .mjs/.js 一律以 JavaScript 送出
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # ── 工具 ──
    def _json(self, status: int, body) -> None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 64 * 1024:
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None

    # ── 路由 ──
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/config":
            return self._json(HTTPStatus.OK, load_config())
        if path == "/api/events":
            with _lock:
                return self._json(HTTPStatus.OK, load_events())
        if path.startswith("/api/"):
            return self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
        return super().do_GET()

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        body = self._read_json()
        if body is None or not isinstance(body, dict):
            return self._json(HTTPStatus.BAD_REQUEST, {"error": "需要 JSON 內容"})

        if path == "/api/events":
            return self._create_event(body)

        m = re.fullmatch(r"/api/events/([A-Za-z0-9_-]{8,64})/status", path)
        if m:
            return self._update_status(m.group(1), body)

        return self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def _create_event(self, body: dict):
        config = load_config()
        seg_ids = {s["id"] for s in config["segments"]}
        cats = {c["id"]: c for c in config["categories"]}

        event_id = str(body.get("id", ""))
        segment_id = body.get("segmentId")
        category = body.get("category", "other")
        source = body.get("source", "manual")
        summary = str(body.get("summary", ""))[:200]
        observed_at = str(body.get("observedAt") or now_iso())[:40]

        if not ID_RE.match(event_id):
            return self._json(HTTPStatus.BAD_REQUEST, {"error": "id 格式錯誤"})
        if not isinstance(segment_id, str) or segment_id not in seg_ids:
            return self._json(HTTPStatus.BAD_REQUEST, {"error": "未知的路段"})
        if not isinstance(category, str) or category not in cats:
            return self._json(HTTPStatus.BAD_REQUEST, {"error": "未知的障礙類別"})
        if source not in SOURCES:
            return self._json(HTTPStatus.BAD_REQUEST, {"error": "未知的來源"})

        with _lock:
            events = load_events()
            existing = next((e for e in events if e["id"] == event_id), None)
            if existing:  # 重送：只保留一筆
                return self._json(HTTPStatus.OK, {**existing, "duplicate": True})
            created = datetime.now(TZ)
            expires = created + timedelta(hours=float(cats[category]["expireHours"]))
            event = {
                "id": event_id,
                "segmentId": segment_id,
                "category": category,
                "source": source,
                "summary": summary,
                "observedAt": observed_at,
                "createdAt": created.isoformat(timespec="seconds"),
                "expiresAt": expires.isoformat(timespec="seconds"),
                "status": "待確認",
                "history": [{"status": "待確認", "at": created.isoformat(timespec="seconds")}],
            }
            events.append(event)
            save_events(events)
        return self._json(HTTPStatus.CREATED, event)

    def _update_status(self, event_id: str, body: dict):
        status = body.get("status")
        if status not in STATUSES:
            return self._json(HTTPStatus.BAD_REQUEST, {"error": "未知的狀態"})
        with _lock:
            events = load_events()
            event = next((e for e in events if e["id"] == event_id), None)
            if not event:
                return self._json(HTTPStatus.NOT_FOUND, {"error": "找不到事件"})
            current = event["status"]
            if current == status:
                return self._json(HTTPStatus.OK, event)
            if {"待確認": "現地確認", "現地確認": "已排除"}.get(current) != status:
                return self._json(HTTPStatus.CONFLICT, {"error": "狀態變更順序錯誤"})
            event["status"] = status
            event.setdefault("history", []).append({"status": status, "at": now_iso()})
            save_events(events)
        return self._json(HTTPStatus.OK, event)

    def log_message(self, fmt, *args):  # 精簡紀錄
        if self.path.startswith("/api/"):
            super().log_message(fmt, *args)


def lan_ips() -> list[str]:
    """找出可讓手機連線的區域 IP（優先列出對外連線用的那張網卡）。"""
    import socket

    ips: list[str] = []
    try:  # 不會真的送出封包，只是讓系統選出預設網卡
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            ips.append(s.getsockname()[0])
    except OSError:
        pass
    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            if ip not in ips and not ip.startswith("127."):
                ips.append(ip)
    except OSError:
        pass
    return ips or ["<請用 ipconfig 查 Wi-Fi 的 IPv4 位址>"]


def main():
    parser = argparse.ArgumentParser(description="無礙智瞳 網頁原型伺服器")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--cert", help="HTTPS 憑證檔（.pem）")
    parser.add_argument("--key", help="HTTPS 私鑰檔（.pem）")
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    scheme = "http"
    if args.cert and args.key:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(args.cert, args.key)
        server.socket = ctx.wrap_socket(server.socket, server_side=True)
        scheme = "https"
    print("無礙智瞳 原型已啟動（Ctrl+C 結束）")
    print(f"  這台電腦打開：{scheme}://localhost:{args.port}")
    if args.host == "0.0.0.0":
        ips = lan_ips()
        print(f"  手機打開：    {scheme}://{ips[0]}:{args.port}")
        if len(ips) > 1:
            print(f"  （其他網卡 {', '.join(ips[1:])}，通常是虛擬機用的，可忽略）")
        print("  （手機要和電腦連同一個 Wi-Fi 或熱點）")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
