// 段階3b：ひとり用の記録を受け取る（検め・保存・送り直し）
const test = require("node:test");
const assert = require("node:assert");
const E = require("../engine.js");
const { cleanSync, cleanHand } = require("../server/solo.js");
const { startServer } = require("../server/server.js");
const { openAccounts } = require("../server/accounts.js");

// 本物のひとり用の大会で、ハンドをいくつか作る（あなたは自動でチェック/フォールド）
function soloHands(n = 12) {
  const m = new Map(), store = { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v) };
  const g = { dur: 6e4, lv: 0, entries: 40, lg: [], lvEnd: 0, hist: [] };
  E.soloSetup(g, store);
  const tr = {};
  g.hero.rec = [tr];
  for (let i = 0; i < n && g.T.p.filter((p) => p.stack > 0).length > 1; i++) {
    E.playHand(g, g.T);
    E.bust(g, g.T);
  }
  return { hands: g.hist, stats: tr };
}
const key = "k0123456789abcdef0123";

test("検め：本物のハンドは通り、あなたの席にだけサーバーがアカウント ID を付ける。知らない欄は捨てる", () => {
  const { hands, stats } = soloHands();
  assert.ok(hands.length >= 3);
  const h0 = { ...hands[0], evil: "<script>", seats: hands[0].seats.map((s) => ({ ...s, uid: "someone-else" })) };
  const r = cleanSync({ key, hands: [h0, ...hands.slice(1)], stats: { ...stats, hacked: 1e9 }, entries: 41, re: 1, blindMin: 5, startedAt: 1e12 }, "uMe");
  assert.ok(r.ok, r.error);
  const c = r.ok.hands[0];
  assert.ok(!("evil" in c));
  assert.deepEqual(c.seats.filter((s) => s.uid).map((s) => [s.oid, s.uid]), [["hero", "uMe"]]);
  assert.ok(c.seats.filter((s) => !s.hero).every((s) => s.uid === null));
  assert.ok(!("hacked" in r.ok.stats) && r.ok.stats.hands >= 1);
  assert.deepEqual([r.ok.entries, r.ok.re, r.ok.blindMin, r.ok.over], [41, 1, 5, 0]);
  // 中身（席・行動・ボード・獲得）は変わらない
  for (let i = 0; i < hands.length; i++) {
    const a = r.ok.hands[i], b = hands[i];
    assert.deepEqual(a.acts, b.acts.map((x) => ({ ...x, ai: x.ai ? 1 : 0 })));
    assert.deepEqual([a.bd, a.sd, a.win, a.n, a.lv], [b.bd, b.sd, b.win, b.n, b.lv]);
  }
});

test("検め：おかしなものは通さない", () => {
  const { hands } = soloHands(3);
  const h = hands[0];
  const bad = [
    ["目印がない", { hands: [h] }],
    ["目印が短い", { key: "abc", hands: [h] }],
    ["多すぎる", { key, hands: Array(51).fill(h) }],
    ["札が 52", { key, hands: [{ ...h, bd: [52] }] }],
    ["あなたが2人", { key, hands: [{ ...h, seats: h.seats.map((s) => ({ ...s, hero: 1 })) }] }],
    ["あなたがいない", { key, hands: [{ ...h, seats: h.seats.map((s) => ({ ...s, hero: 0 })) }] }],
    ["知らない行動", { key, hands: [{ ...h, acts: [{ s: 0, i: 0, a: "z", x: 0, to: 0 }] }] }],
    ["席の番号が外", { key, hands: [{ ...h, acts: [{ s: 0, i: 99, a: "f", x: 0, to: 0 }] }] }],
    ["額が文字", { key, hands: [{ ...h, seats: h.seats.map((s) => ({ ...s, st: "1000" })) }] }],
    ["名前が長い", { key, hands: [{ ...h, seats: h.seats.map((s, i) => (i ? s : { ...s, name: "x".repeat(21) })) }] }],
  ];
  for (const [why, b] of bad) assert.ok(cleanSync(b, "u").error, why);
  assert.equal(cleanHand(null, "u"), null);
});

// ログインしている人のブラウザ役
async function boot(t) {
  const accounts = openAccounts();
  const tmp = await startServer({ PORT: 0, HOST: "127.0.0.1", quiet: 1, DB_FILE: ":memory:", accounts, store: { get: () => null, set() {} } });
  const port = tmp.port;
  await tmp.close();
  const srv = await startServer({
    PORT: port, HOST: "127.0.0.1", quiet: 1, DB_FILE: ":memory:", accounts, store: { get: () => null, set() {} }, PUBLIC_URL: `http://127.0.0.1:${port}/`,
  });
  t.after(() => srv.close());
  const origin = `http://127.0.0.1:${port}`;
  const member = (name) => {
    const iv = accounts.createInvite("member");
    const { user } = accounts.loginExternal({ provider: "google", sub: name, name }, { invite: iv.token });
    return { user, sid: accounts.createSession(user.id, "t").token };
  };
  const sync = (m, body, o = {}) =>
    fetch(origin + "/api/solo/sync", {
      method: "POST",
      headers: { "content-type": "application/json", origin: o.origin || origin, ...(m ? { cookie: "alp_sid=" + m.sid } : {}) },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const q = (sql, ...a) => srv.db.prepare(sql).all(...a);
  return { srv, member, sync, q };
}

test("保存：ログインしている人の分だけ。送り直しても増えない。終わったら締める", async (t) => {
  const { member, sync, q } = await boot(t);
  const kaina = member("Kaina"), croque = member("Croque");
  const { hands, stats } = soloHands(10);
  const body = { key, blindMin: 5, startedAt: 1e12, entries: 40, re: 0, stats, hands: hands.slice(0, 4) };
  assert.equal((await sync(null, body)).status, 401, "ログインしていない");
  assert.equal((await sync(kaina, body, { origin: "https://evil.example" })).status, 401, "別のサイトのページから");
  let r = await sync(kaina, body);
  assert.deepEqual([r.status, r.saved], [200, 4]);
  r = await sync(kaina, body);
  assert.equal(r.saved, 0, "同じものは増えない");
  r = await sync(kaina, { ...body, hands: hands.slice(4), entries: 42, re: 1, over: 1, place: 7 });
  assert.equal(r.saved, hands.length - 4);
  const T = q("SELECT * FROM tournaments WHERE source = 'solo'");
  assert.equal(T.length, 1);
  assert.deepEqual([T[0].owner_uid, T[0].client_key, T[0].finished, T[0].entries, T[0].blind_min, T[0].started_at], [kaina.user.id, key, 1, 42, 5, 1e12]);
  const e = q("SELECT * FROM entries WHERE tournament_id = ?", T[0].id)[0];
  assert.deepEqual([e.oid, e.uid, e.name, e.place, e.rebuys], ["hero", kaina.user.id, "Kaina", 7, 1]);
  assert.deepEqual(JSON.parse(e.stats), stats);
  assert.equal(q("SELECT COUNT(*) n FROM hands WHERE tournament_id = ?", T[0].id)[0].n, hands.length);
  assert.equal(q("SELECT COUNT(*) n FROM hand_players WHERE uid = ?", kaina.user.id)[0].n, hands.length);
  const saved = JSON.parse(q("SELECT data FROM hands WHERE tournament_id = ? AND n = 1", T[0].id)[0].data);
  assert.equal(saved.seats.find((s) => s.hero).uid, kaina.user.id);
  // 同じ目印でも、別の人なら別の大会
  await sync(croque, body);
  assert.equal(q("SELECT COUNT(*) n FROM tournaments WHERE source = 'solo'")[0].n, 2);
  // おかしなものは 400
  assert.equal((await sync(kaina, { ...body, hands: [{ ...hands[0], bd: [99] }] })).status, 400);
});

test("保存：アカウントごとに1分あたりの回数を制限する", async (t) => {
  const { member, sync } = await boot(t);
  const kaina = member("Kaina");
  let last;
  for (let i = 0; i < 62; i++) last = await sync(kaina, { key, hands: [] });
  assert.equal(last.status, 429);
});
