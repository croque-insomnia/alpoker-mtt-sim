// 入室の手順（net.js の joinRoom）を、メモリ上の link と createHost でつないで確かめる。
// PeerJS の代わりに別の link を差し込めること自体の確認も兼ねる
const test = require("node:test");
const assert = require("node:assert");
const { joinRoom, JOIN_MS } = require("../net.js");
const { createHost } = require("../room.js");
const { memoryLink, flush, fakeClock } = require("./helpers.js");

async function openRoom() {
  const link = memoryLink();
  let host, roomId;
  const l = link.listen({
    ready: (id) => {
      roomId = id;
      // 部屋の時計は早送り用のもの（進めないので、大会は勝手に進まない）
      host = createHost({ password: "pw", roomId: id, send: l.send, close: l.close, local: { id, name: "Host", deliver: () => {} }, clock: fakeClock() });
    },
    data: (id, m) => host.data(id, m),
    closed: (id) => host.closed(id),
  });
  await flush();
  return { link, host: () => host, roomId };
}
function client() {
  const ev = [];
  const cb = {
    joined: (m) => ev.push(["joined", m]),
    roster: (r) => ev.push(["roster", r]),
    msg: (m) => ev.push(["msg", m]),
    error: (why, fatal) => ev.push(["error", why, fatal]),
    closed: (why) => ev.push(["closed", why]),
  };
  return { ev, cb, last: (k) => ev.filter((e) => e[0] == k).pop() };
}

test("入室できる・パスワード違いは入り直しても無駄な失敗として伝わる", async () => {
  const r = await openRoom();
  const a = client();
  const ja = joinRoom(r.link, r.roomId, { name: "A", pw: "pw", role: "player" }, a.cb);
  await flush();
  assert.equal(a.last("joined")[1].name, "A");
  assert.equal(a.last("roster")[1].length, 2);
  const b = client();
  joinRoom(r.link, r.roomId, { name: "B", pw: "x" }, b.cb);
  await flush();
  assert.deepEqual(b.last("error").slice(1), ["パスワードが違います", 1]);
  ja.leave();
});

test("部屋がないときは、入り直せる失敗として伝わる", async () => {
  const link = memoryLink();
  const a = client();
  joinRoom(link, "nope", { name: "A", pw: "pw" }, a.cb);
  await flush();
  assert.deepEqual(a.last("error").slice(1), ["部屋が見つかりません", undefined]);
});

test("切れたら closed が届き、合言葉で同じ席に戻れる", async () => {
  const r = await openRoom();
  const a = client();
  let conn;
  const dial = r.link.dial;
  r.link.dial = (room, cb) => (conn = dial(room, cb)); // 切断を起こすために接続をつかんでおく
  joinRoom(r.link, r.roomId, { name: "A", pw: "pw", role: "player" }, a.cb);
  await flush();
  const tok = a.last("joined")[1].tok;
  r.host().start(5);
  await flush();
  assert.equal(a.last("msg")[1].t, "view");
  conn.drop();
  await flush();
  assert.equal(a.last("closed")[1], "ホストとの接続が切れました");
  const me = r.host().room.state().P.find((p) => p.name == "A");
  assert.equal(me.away, 1);
  const a2 = client();
  joinRoom(r.link, r.roomId, { name: "whatever", pw: "pw", role: "player", tok }, a2.cb);
  await flush();
  assert.equal(a2.last("joined")[1].name, "A");
  assert.equal(me.away, 0);
  assert.equal(a2.last("msg")[1].v.spec, 0, "観戦ではなくプレイヤーとして戻る");
});

test("退出させられたら、入り直しても無駄な失敗として伝わる", async () => {
  const r = await openRoom();
  const a = client();
  joinRoom(r.link, r.roomId, { name: "A", pw: "pw" }, a.cb);
  await flush();
  const id = a.last("joined")[1].id;
  r.host().kick(id);
  await flush();
  assert.deepEqual(a.last("error").slice(1), ["ホストにより退出させられました", 1]);
  assert.ok(!a.last("closed"), "closed は重ねて届かない");
});

test("応答がなければタイムアウトする", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let destroyed = 0;
  const silent = { dial: () => ({ send() {}, close() {}, destroy: () => destroyed++ }) };
  const a = client();
  joinRoom(silent, "x", { name: "A", pw: "pw" }, a.cb);
  t.mock.timers.tick(JOIN_MS - 1);
  assert.equal(a.ev.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(a.last("error").slice(1), ["接続できませんでした（タイムアウト）", undefined]);
  assert.equal(destroyed, 1);
});

test("leave した後のイベントは届かない", async () => {
  const r = await openRoom();
  const a = client();
  const j = joinRoom(r.link, r.roomId, { name: "A", pw: "pw" }, a.cb);
  j.leave();
  await flush();
  assert.equal(a.ev.length, 0);
});
