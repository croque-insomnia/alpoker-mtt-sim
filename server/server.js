// server.js — 簡易サーバー。ページの配信と、みんなで遊ぶ部屋（WebSocket）を1つのプロセスで持つ。
//   npm start            … http://localhost:8080 で起動
//   PORT=3000 npm start  … ポートを変える
// 環境変数（すべて省略可）
//   PORT        待ち受けるポート（既定 8080）
//   HOST        待ち受けるアドレス（既定 0.0.0.0）
//   CREATE_KEY  部屋を作るときに必要な合言葉。設定すると、知っている人しか部屋を作れない（身内用に推奨）
//   DATA_DIR    ネームドCPUの記憶などを保存するフォルダ（既定 ./data）
//   MAX_ROOMS   同時に開ける部屋の数（既定 20）
// 部屋の進行と入室の受付は room.js（ホストのブラウザで動くものと同じ）。ここは「つなぐ」と「片付ける」だけ。
"use strict";
const http = require("http"),
  fs = require("fs"),
  path = require("path"),
  crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { createHost } = require("../room.js");
const { fileStore } = require("./store.js");

const ROOT = path.join(__dirname, ".."),
  // 配信するファイル（これ以外は 404）
  FILES = { "/": "index.html", "/index.html": "index.html", "/style.css": "style.css" };
for (const f of ["engine.js", "room.js", "net.js", "game.js", "mp.js"]) FILES["/" + f] = f;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const IDLE_MS = 10 * 60e3, // 誰もいない部屋を片付けるまでの時間
  PING_MS = 25e3, // 生きているかの確認の間隔（スマホのスリープなどで切れた接続を見つける）
  MAX_MSG = 16 * 1024; // 1通の大きさの上限

function startServer(opt = {}) {
  const env = { ...process.env, ...opt },
    port = env.PORT == null ? 8080 : +env.PORT,
    createKey = env.CREATE_KEY || "",
    maxRooms = +env.MAX_ROOMS || 20,
    idleMs = opt.idleMs || IDLE_MS,
    store = opt.store || fileStore(path.resolve(env.DATA_DIR || path.join(ROOT, "data"), "store.json")),
    log = opt.quiet ? () => {} : (...a) => console.log(new Date().toISOString(), ...a);
  const rooms = new Map(); // 部屋ID -> { host, socks: Map(接続id -> ws), empty: 誰もいなくなった時刻 }
  const rid = () => "alp-" + crypto.randomBytes(4).toString("hex").slice(0, 6);
  const secret = () => crypto.randomBytes(12).toString("base64url");

  function makeRoom(password) {
    let id;
    do id = rid();
    while (rooms.has(id));
    const socks = new Map(), adm = secret();
    const host = createHost({
      password,
      roomId: id,
      adminKey: adm,
      send: (cid, m) => {
        const ws = socks.get(cid);
        ws && ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
      },
      close: (cid) => {
        const ws = socks.get(cid);
        socks.delete(cid);
        ws && ws.close();
      },
      store,
    });
    rooms.set(id, { host, socks, empty: Date.now() });
    log("room open", id, "rooms:", rooms.size);
    return { room: id, adm };
  }
  function closeRoom(id, why) {
    const r = rooms.get(id);
    if (!r) return;
    rooms.delete(id);
    r.host.stop();
    r.socks.forEach((ws) => ws.close());
    log("room closed", id, why, "rooms:", rooms.size);
  }

  // ---- HTTP：ページの配信と部屋の作成 ----
  const json = (res, code, obj) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(obj));
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/hello" && req.method === "GET")
      return json(res, 200, { server: 1, needKey: !!createKey });
    if (url.pathname === "/api/rooms" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => {
        body += c;
        if (body.length > 4096) req.destroy();
      });
      req.on("end", () => {
        let m;
        try {
          m = JSON.parse(body);
        } catch (e) {
          return json(res, 400, { why: "送信内容が読めません" });
        }
        const pw = typeof m.pw == "string" ? m.pw : "";
        if (createKey && m.key !== createKey) return json(res, 403, { why: "部屋を作る合言葉が違います" });
        if (!pw || pw.length > 64) return json(res, 400, { why: "パスワードを入力してください（64文字まで）" });
        if (rooms.size >= maxRooms) return json(res, 503, { why: "部屋がいっぱいです。しばらくしてから作ってください" });
        json(res, 200, makeRoom(pw));
      });
      return;
    }
    const f = req.method === "GET" && FILES[url.pathname];
    if (!f) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return res.end("not found");
    }
    fs.readFile(path.join(ROOT, f), (err, buf) => {
      if (err) {
        res.writeHead(500);
        return res.end();
      }
      // 更新がすぐ届くように、毎回確認させる
      res.writeHead(200, { "content-type": TYPES[path.extname(f)], "cache-control": "no-cache" });
      res.end(buf);
    });
  });

  // ---- WebSocket：/ws?room=部屋ID ----
  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: MAX_MSG });
  let seq = 0;
  wss.on("connection", (ws, req) => {
    const id = new URL(req.url, "http://x").searchParams.get("room") || "",
      r = rooms.get(id),
      cid = "s" + ++seq + "-" + crypto.randomBytes(3).toString("hex");
    if (!r) {
      ws.send(JSON.stringify({ t: "no", why: "部屋が見つかりません（閉じられたか、サーバーが再起動しました）" }));
      return ws.close();
    }
    r.socks.set(cid, ws);
    ws.alive = true;
    ws.on("pong", () => (ws.alive = true));
    ws.on("message", (buf) => {
      let m;
      try {
        m = JSON.parse(buf);
      } catch (e) {
        return;
      }
      if (m && typeof m == "object") r.host.data(cid, m);
    });
    ws.on("close", () => {
      if (r.socks.get(cid) !== ws) return; // こちらから閉じた接続
      r.socks.delete(cid);
      r.host.closed(cid);
      if (r.host.empty()) r.empty = Date.now();
    });
    ws.on("error", () => {});
  });

  // 切れているのに気づけない接続を落とす・空き部屋を片付ける
  const timer = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.alive) return ws.terminate();
      ws.alive = false;
      ws.ping();
    });
    const now = Date.now();
    for (const [id, r] of rooms) {
      if (!r.host.empty()) r.empty = 0;
      else if (!r.empty) r.empty = now;
      else if (now - r.empty > idleMs) closeRoom(id, "idle");
    }
  }, opt.tickMs || PING_MS);

  return new Promise((resolve) => {
    server.listen(port, env.HOST || "0.0.0.0", () => {
      const addr = server.address();
      log(`listening on http://localhost:${addr.port}` + (createKey ? "（部屋の作成に合言葉が必要）" : ""));
      resolve({
        port: addr.port,
        rooms,
        close: () =>
          new Promise((r) => {
            clearInterval(timer);
            for (const id of [...rooms.keys()]) closeRoom(id, "shutdown");
            wss.close();
            server.close(() => r());
            store.flush && store.flush();
          }),
      });
    });
  });
}

if (require.main === module) {
  startServer().then((s) => {
    const stop = () => s.close().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}
module.exports = { startServer };
