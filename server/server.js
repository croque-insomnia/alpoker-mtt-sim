// server.js — 簡易サーバー。ページの配信と、みんなで遊ぶ部屋（WebSocket）を1つのプロセスで持つ。
//   npm start            … http://localhost:8080 で起動
//   PORT=3000 npm start  … ポートを変える
// 環境変数（すべて省略可）
//   PORT        待ち受けるポート（既定 8080）
//   HOST        待ち受けるアドレス（既定 0.0.0.0）
//   CREATE_KEY  部屋を作るときに必要な合言葉。設定すると、知っている人しか部屋を作れない（身内用に推奨）
//   DATA_DIR    ネームドCPUの記憶・ハンド履歴（hands/）を保存するフォルダ（既定 ./data）
//   MAX_ROOMS   同時に開ける部屋の数（既定 20）
//   ログイン（Discord / Google）の設定は auth.js の先頭を参照（PUBLIC_URL・*_CLIENT_ID など）
// 部屋の進行と入室の受付は room.js（ホストのブラウザで動くものと同じ）。ここは「つなぐ」と「片付ける」だけ。
"use strict";
const http = require("http"),
  fs = require("fs"),
  path = require("path"),
  crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { createHost } = require("../room.js");
const { fileStamp } = require("../engine.js");
const { fileStore } = require("./store.js");
const { openAccounts } = require("./accounts.js");
const { createAuth } = require("./auth.js");

const ROOT = path.join(__dirname, ".."),
  // 配信するファイル（これ以外は 404）
  FILES = { "/": "index.html", "/index.html": "index.html", "/style.css": "style.css", "/account.html": "account.html" };
for (const f of ["engine.js", "room.js", "net.js", "game.js", "mp.js", "account.js"]) FILES["/" + f] = f;
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
    dataDir = path.resolve(env.DATA_DIR || path.join(ROOT, "data")),
    store = opt.store || fileStore(path.join(dataDir, "store.json")),
    log = opt.quiet ? () => {} : (...a) => console.log(new Date().toISOString(), ...a),
    accounts = opt.accounts || openAccounts(path.join(dataDir, "accounts.json")),
    auth = createAuth({ env, accounts, log, fetch: opt.fetch, providers: opt.providers });
  const rooms = new Map(); // 部屋ID -> { host, socks: Map(接続id -> ws), empty: 誰もいなくなった時刻 }
  const rid = () => "alp-" + crypto.randomBytes(4).toString("hex").slice(0, 6);
  const secret = () => crypto.randomBytes(12).toString("base64url");

  // 部屋を作る。o.ownerUid: 作った人のアカウント（ログインして作ったとき） / o.guests: ゲストも入れるか / o.password: ゲスト用のパスワード
  // ログインせずに作ったとき（CREATE_KEY）は、作った人の合言葉（adm）を返す。その人が開始・退出を操作できる
  function makeRoom(o) {
    let id;
    do id = rid();
    while (rooms.has(id));
    const socks = new Map(), users = new Map(), adm = o.ownerUid ? null : secret();
    const host = createHost({
      password: o.password,
      roomId: id,
      adminKey: adm,
      ownerUid: o.ownerUid,
      guests: o.guests,
      userOf: (cid) => users.get(cid) || null,
      reservedName: (n) => accounts.nameTaken(n),
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
      onOver: (g) => saveHands(id, g),
    });
    rooms.set(id, { host, socks, users, empty: Date.now() });
    log("room open", id, o.ownerUid ? "by " + o.ownerUid : "(key)", o.guests ? "guests ok" : "members only", "rooms:", rooms.size);
    return adm ? { room: id, adm } : { room: id };
  }
  // 大会が終わったら（途中で部屋を閉じるときも）、ハンド履歴をファイルに残す（DATA_DIR/hands/日時-部屋ID.json）
  // 終了の直前でも書き終わるように、同期で書く
  function saveHands(id, g) {
    const d = new Date(),
      file = path.join(dataDir, "hands", `${fileStamp(d)}-${id}.json`),
      // version 2：参加者とハンドの各席にアカウントの ID（uid。ゲストは null）、参加者に打ち方の記録（stats）を入れる
      body = {
        format: "alpoker-hands",
        version: 2,
        room: id,
        finishedAt: d.toISOString(),
        finished: !!g.over, // false: 途中で部屋が閉じた
        entries: g.entries,
        players: g.P.filter((p) => p.hero).map((p) => ({ uid: p.uid || null, name: p.name, place: p.place || 0, re: p.re, stats: (p.rec && p.rec[0]) || {} })),
        hands: g.hist,
      };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(body));
      log("hands saved", file, g.hist.length);
    } catch (e) {
      log("hands: 保存できません", e.message);
    }
  }
  function closeRoom(id, why) {
    const r = rooms.get(id);
    if (!r) return;
    rooms.delete(id);
    r.host.stop();
    // 大会の途中で閉じるときも、そこまでのハンド履歴を残す
    const g = r.host.room.state();
    if (g && !g.over && g.hist.length) saveHands(id, g);
    r.socks.forEach((ws) => ws.close());
    log("room closed", id, why, "rooms:", rooms.size);
  }

  // ---- HTTP：ページの配信と部屋の作成 ----
  const json = (res, code, obj) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(obj));
  };
  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://x");
    } catch (e) {
      // 読めない URL（"//" など）。ここで投げるとプロセスごと落ちる
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      return res.end("bad request");
    }
    if (url.pathname === "/api/hello" && req.method === "GET")
      return json(res, 200, { server: 1, needKey: !!createKey, auth: auth.enabled() ? 1 : 0 });
    try {
      if (await auth.handle(req, res, url)) return;
    } catch (e) {
      log("auth error", e.stack || e.message);
      if (!res.headersSent) json(res, 500, { why: "サーバーの中で問題が起きました" });
      return;
    }
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
        if (pw.length > 64) return json(res, 400, { why: "パスワードは64文字までにしてください" });
        // ログインしている人（このサイトのページから）は、合言葉なしで作れる。ゲストを入れるときだけパスワードが要る
        const u = auth.sameOrigin(req) && auth.userFromReq(req);
        if (u) {
          const guests = !!m.guests;
          if (guests && !pw) return json(res, 400, { why: "ゲストも入れるときは、ゲスト用のパスワードを決めてください" });
          if (rooms.size >= maxRooms) return json(res, 503, { why: "部屋がいっぱいです。しばらくしてから作ってください" });
          return json(res, 200, makeRoom({ ownerUid: u.id, guests, password: guests ? pw : null }));
        }
        // ログインしていない人：これまでどおり、部屋を作る合言葉とパスワード
        if (createKey && m.key !== createKey) return json(res, 403, { why: "部屋を作る合言葉が違います" });
        if (!pw) return json(res, 400, { why: "パスワードを入力してください（64文字まで）" });
        if (rooms.size >= maxRooms) return json(res, 503, { why: "部屋がいっぱいです。しばらくしてから作ってください" });
        json(res, 200, makeRoom({ guests: true, password: pw }));
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
      // 更新がすぐ届くように、毎回確認させる。招待の合言葉が入った URL が、外へのリンクで漏れないようにする
      res.writeHead(200, {
        "content-type": TYPES[path.extname(f)],
        "cache-control": "no-cache",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
      });
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
    // ログインしている人か。別のサイトのページからの接続は、Cookie が付いていてもゲストとして扱う（なりすまし防止）
    const u = auth.sameOrigin(req) && auth.userFromReq(req);
    if (u) r.users.set(cid, { id: u.id, name: u.name, role: u.role });
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
      r.users.delete(cid);
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

  // 期限切れのセッション・招待を1時間ごとに掃除する
  const sweeper = setInterval(() => accounts.sweep(), 36e5);
  // 管理用の口：ADMIN_PORT を設定したときだけ開く（"auto" は空いているポート。テスト用）
  const adminPort = env.ADMIN_PORT === "auto" ? 0 : +env.ADMIN_PORT || null;
  return new Promise((resolve) => {
    server.listen(port, env.HOST || "0.0.0.0", async () => {
      const addr = server.address();
      log(`listening on http://localhost:${addr.port}` + (createKey ? "（部屋の作成に合言葉が必要）" : ""));
      const local = adminPort != null ? await auth.startLocalAdmin(adminPort) : null;
      if (local) log(`admin port: 127.0.0.1:${local.address().port}`);
      if (auth.enabled()) log("login:", auth.providers().join(", "));
      if (auth.enabled() && !accounts.hasAdmin()) log("管理者がまだいません。VPS 上で npm run admin -- invite admin を実行して、招待リンクから入ってください");
      resolve({
        adminPort: local && local.address().port,
        accounts,
        port: addr.port,
        rooms,
        saveHands, // テスト用
        close: () =>
          new Promise((r) => {
            clearInterval(timer);
            clearInterval(sweeper);
            local && local.close();
            accounts.flush();
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
