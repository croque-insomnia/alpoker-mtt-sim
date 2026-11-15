// 簡易サーバー（server/server.js）を実際に立てて、WebSocket でつなぐ
const test = require("node:test");
const assert = require("node:assert");
const WebSocket = require("ws");
const { startServer } = require("../server/server.js");
const { wsLink, joinRoom } = require("../net.js");

const until = async (f, ms = 3000) => {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const mem = () => {
  const m = new Map();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v) };
};
async function boot(t, opt = {}) {
  const srv = await startServer({ PORT: 0, HOST: "127.0.0.1", CREATE_KEY: "key", quiet: 1, store: mem(), ...opt });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port}/`;
  const link = wsLink(base, WebSocket);
  const create = (body) =>
    fetch(base + "api/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  return { srv, base, link, create };
}
function client(link, room, o) {
  const c = { ev: [], views: [] };
  c.last = (k) => c.ev.filter((e) => e[0] == k).pop();
  c.j = joinRoom(link, room, o, {
    joined: (m) => c.ev.push(["joined", m]),
    roster: (r) => c.ev.push(["roster", r]),
    msg: (m) => (c.ev.push(["msg", m]), m.t == "view" && c.views.push(m.v)),
    error: (why, fatal) => c.ev.push(["error", why, fatal]),
    closed: (why) => c.ev.push(["closed", why]),
  });
  return c;
}

test("ページを配信し、それ以外のファイルは出さない", async (t) => {
  const { base } = await boot(t);
  const get = (p) => fetch(base + p).then(async (r) => [r.status, r.headers.get("content-type"), await r.text()]);
  const [s1, ty, html] = await get("");
  assert.equal(s1, 200);
  assert.match(ty, /text\/html/);
  assert.match(html, /engine\.js/);
  assert.equal((await get("engine.js"))[0], 200);
  for (const p of ["server/server.js", "package.json", "..%2Fpackage.json", "tests/server.test.js", "data/store.json"])
    assert.equal((await get(p))[0], 404, p);
  const hello = await fetch(base + "api/hello").then((r) => r.json());
  assert.deepEqual(hello, { server: 1, needKey: true });
});

test("部屋を作るには合言葉とパスワードが要る", async (t) => {
  const { create } = await boot(t);
  assert.equal((await create({ pw: "pw" })).status, 403);
  assert.equal((await create({ pw: "", key: "key" })).status, 400);
  const r = await create({ pw: "pw", key: "key" });
  assert.equal(r.status, 200);
  assert.match(r.room, /^alp-/);
  assert.ok(r.adm.length > 10);
});

test("部屋を作った人だけが開始・退出を操作でき、全員に画面が届く", async (t) => {
  const { srv, link, create } = await boot(t);
  const { room, adm } = await create({ pw: "pw", key: "key" });
  const A = client(link, room, { name: "A", pw: "pw", role: "player", adm });
  await until(() => A.last("joined"));
  assert.equal(A.last("joined")[1].admin, 1);
  const B = client(link, room, { name: "B", pw: "pw", role: "player", adm: "guess" });
  await until(() => B.last("joined"));
  assert.equal(B.last("joined")[1].admin, 0, "違う合言葉では管理できない");
  const C = client(link, room, { name: "C", pw: "pw", role: "player" });
  await until(() => C.last("joined") && A.last("roster")[1].length == 3);
  // 管理できない人の開始は無視される
  B.j.send({ t: "admin", a: "start", dur: 1 });
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!srv.rooms.get(room).host.room.started());
  // 管理できない人の退出操作も無視される
  B.j.send({ t: "admin", a: "kick", id: A.last("joined")[1].id });
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!A.last("error"));
  // 作った人が開始
  A.j.send({ t: "admin", a: "start", dur: 1 });
  await until(() => A.views.length && B.views.length && C.views.length);
  assert.ok(A.ev.some((e) => e[0] == "msg" && e[1].t == "start"));
  assert.equal(A.views.at(-1).spec, 0);
  // 作った人が C を退出させる
  A.j.send({ t: "admin", a: "kick", id: C.last("joined")[1].id });
  await until(() => C.last("error"));
  assert.deepEqual(C.last("error").slice(1), ["ホストにより退出させられました", 1]);
  [A, B].forEach((c) => c.j.leave());
});

test("切れても合言葉で同じ席に戻れる", async (t) => {
  const { srv, link, create } = await boot(t);
  const { room, adm } = await create({ pw: "pw", key: "key" });
  // 切断を起こすため、WebSocket をつかんでおく
  const socks = [];
  class WS extends WebSocket {
    constructor(...a) {
      super(...a);
      socks.push(this);
    }
  }
  const link2 = wsLink(`http://127.0.0.1:${srv.port}/`, WS);
  const A = client(link2, room, { name: "A", pw: "pw", role: "player", adm });
  await until(() => A.last("joined"));
  A.j.send({ t: "admin", a: "start", dur: 5 });
  await until(() => A.views.length);
  const tok = A.last("joined")[1].tok;
  const me = () => srv.rooms.get(room).host.room.state().P.find((p) => p.name == "A");
  socks[0].terminate(); // 回線が突然切れた
  await until(() => A.last("closed"));
  await until(() => me().away == 1);
  const A2 = client(link, room, { name: "x", pw: "pw", role: "player", tok });
  await until(() => A2.last("joined"));
  assert.equal(A2.last("joined")[1].name, "A");
  assert.equal(A2.last("joined")[1].admin, 1, "作った人の権限も戻る");
  assert.equal(me().away, 0);
  await until(() => A2.views.length);
  assert.equal(A2.views.at(-1).spec, 0);
  A2.j.leave();
});

test("ない部屋に入ろうとすると、入り直しても無駄な失敗として伝わる", async (t) => {
  const { link } = await boot(t);
  const A = client(link, "alp-nope", { name: "A", pw: "pw" });
  await until(() => A.last("error"));
  assert.match(A.last("error")[1], /部屋が見つかりません/);
  assert.equal(A.last("error")[2], 1);
});

test("サーバーが止まっていれば、入り直せる失敗として伝わる", async () => {
  const link = wsLink("http://127.0.0.1:9/", WebSocket);
  const A = client(link, "alp-x", { name: "A", pw: "pw" });
  await until(() => A.last("error"));
  assert.deepEqual(A.last("error").slice(1), ["サーバーに接続できません", undefined]);
});

test("誰もいなくなった部屋は片付ける", async (t) => {
  const { srv, link, create } = await boot(t, { tickMs: 20, idleMs: 60 });
  const { room, adm } = await create({ pw: "pw", key: "key" });
  const A = client(link, room, { name: "A", pw: "pw", role: "player", adm });
  await until(() => A.last("joined"));
  A.j.send({ t: "admin", a: "start", dur: 5 });
  await until(() => A.views.length);
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(srv.rooms.has(room), "人がいる間は残る");
  A.j.leave();
  await until(() => !srv.rooms.has(room), 2000);
});

test("合言葉を設定しなければ、誰でも部屋を作れる", async (t) => {
  const { create, base } = await boot(t, { CREATE_KEY: "" });
  assert.equal((await create({ pw: "pw" })).status, 200);
  assert.equal((await fetch(base + "api/hello").then((r) => r.json())).needKey, false);
});

test("大会のハンド履歴をファイルに残す", async (t) => {
  const os = require("os"), fs = require("fs"), path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { srv } = await boot(t, { DATA_DIR: dir });
  const g = { entries: 41, P: [{ hero: 1, name: "A", place: 3, re: 1 }, { name: "cpu" }], hist: [{ n: 1 }, { n: 2 }] };
  srv.saveHands("alp-test", g);
  await until(() => fs.existsSync(path.join(dir, "hands")) && fs.readdirSync(path.join(dir, "hands")).length == 1);
  const f = fs.readdirSync(path.join(dir, "hands"))[0];
  assert.match(f, /^\d{8}-\d{4}-alp-test\.json$/);
  await until(() => fs.statSync(path.join(dir, "hands", f)).size > 0);
  const body = JSON.parse(fs.readFileSync(path.join(dir, "hands", f), "utf8"));
  assert.equal(body.format, "alpoker-hands");
  assert.deepEqual(body.players, [{ name: "A", place: 3, re: 1 }]);
  assert.equal(body.hands.length, 2);
});
