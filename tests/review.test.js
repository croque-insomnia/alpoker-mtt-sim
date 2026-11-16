// 段階3d・3e：振り返り（大会・ハンド）と、打ち方の傾向・身内CPUの材料。だれが何を見られるか
const test = require("node:test");
const assert = require("node:assert");
const E = require("../engine.js");
const { startServer } = require("../server/server.js");
const { openAccounts } = require("../server/accounts.js");
const { openRecords } = require("../server/records.js");
const { createRoom } = require("../room.js");
const { fakeClock } = require("./helpers.js");

async function boot(t) {
  const accounts = openAccounts();
  const tmp = await startServer({ PORT: 0, HOST: "127.0.0.1", quiet: 1, DB_FILE: ":memory:", accounts, store: { get: () => null, set() {} } });
  const port = tmp.port;
  await tmp.close();
  const srv = await startServer({ PORT: port, HOST: "127.0.0.1", quiet: 1, DB_FILE: ":memory:", accounts, store: { get: () => null, set() {} }, PUBLIC_URL: `http://127.0.0.1:${port}/` });
  t.after(() => srv.close());
  const origin = `http://127.0.0.1:${port}`, records = openRecords(srv.db);
  const member = (name) => {
    const iv = accounts.createInvite("member");
    const { user } = accounts.loginExternal({ provider: "google", sub: name, name }, { invite: iv.token });
    return { user, sid: accounts.createSession(user.id, "t").token };
  };
  const call = (m, p, o = {}) =>
    fetch(origin + "/" + p, {
      method: o.body ? "POST" : "GET",
      headers: { origin: o.origin || origin, "content-type": "application/json", ...(m ? { cookie: "alp_sid=" + m.sid } : {}) },
      body: o.body && JSON.stringify(o.body),
    }).then(async (r) => ({ status: r.status, headers: r.headers, body: await r.json().catch(() => null) }));
  return { srv, accounts, records, member, call };
}
// 2人のメンバーで「みんなで遊ぶ」大会を進める（stop ハンドで止めれば、続いている大会になる）
function mp(records, a, b, stop = 0) {
  const clock = fakeClock(Date.now()), last = {}, ids = ["a", "b"]; // 「直近30日」を確かめるため、今の時刻から
  let tid;
  const room = createRoom({
    deliver: (id, m) => m.t == "view" && (last[id] = m.v),
    members: () => ids,
    clock,
    onStart: (g) => (tid = records.start(g, { source: "mp" })),
    onHand: (g, H) => records.hand(tid, g, H),
    onRound: (g) => records.update(tid, g),
    onOver: (g) => records.finish(tid, g, "over"),
  });
  room.start([{ id: "a", name: a.user.name, uid: a.user.id }, { id: "b", name: b.user.name, uid: b.user.id }], 1);
  const g = room.state();
  let n = 0;
  while (n++ < 5e5 && !g.over && clock.step()) {
    for (const id of ids) {
      const v = last[id];
      if (v && v.req && !v._d) (v._d = 1), room.msg(id, { t: "act", a: { t: v.req.toCall > v.req.stack / 2 ? "f" : "c" } });
      else if (v && v.ask && !v._d) (v._d = 1), room.msg(id, { t: "re", y: true });
    }
    if (stop && g.hist.length >= stop) break;
  }
  return { g, tid };
}

test("ブラウザは同じサイトの GET に Origin を付けないので、付いていなくても読める。別のサイトと分かるものは断る", async (t) => {
  const { srv, member } = await boot(t);
  const k = member("Kaina"), base = `http://127.0.0.1:${srv.port}/api/review/tournaments`;
  const get = (h) => fetch(base, { headers: { cookie: "alp_sid=" + k.sid, ...h } }).then((r) => r.status);
  assert.equal(await get({}), 200, "Origin なし（ふつうのブラウザの GET）");
  assert.equal(await get({ "sec-fetch-site": "same-origin" }), 200);
  assert.equal(await get({ "sec-fetch-site": "cross-site" }), 401);
  assert.equal(await get({ "sec-fetch-site": "same-site" }), 401, "同じドメインの別のサブドメインも断る");
  assert.equal(await get({ origin: "https://evil.example" }), 401);
});

test("ログインしていない・別のサイトからは使えない", async (t) => {
  const { member, call } = await boot(t);
  const k = member("Kaina");
  for (const p of ["api/review/tournaments", "api/style", "api/style/members"]) {
    assert.equal((await call(null, p)).status, 401, p);
    assert.equal((await call(k, p, { origin: "https://evil.example" })).status, 401, p + "（別のサイト）");
  }
});

test("振り返り：参加した大会だけ。続いている大会は自分のハンド・自分の手札と公開された手札だけ、終わったら全員分", async (t) => {
  const { member, call, records } = await boot(t);
  const k = member("Kaina"), c = member("Croque"), x = member("Other");
  const done = mp(records, k, c);
  const live = mp(records, k, c, 6);
  const list = (await call(k, "api/review/tournaments")).body.tournaments;
  assert.deepEqual(list.map((r) => r.id).sort(), [done.tid, live.tid].sort());
  const d = list.find((r) => r.id == done.tid);
  assert.equal(d.finished, 1);
  assert.equal(d.hands, done.g.hist.filter((H) => H.seats.some((s) => s.uid == k.user.id)).length);
  assert.equal((await call(x, "api/review/tournaments")).body.tournaments.length, 0);
  // 参加していない大会は見られない
  assert.equal((await call(x, "api/review/hands?t=" + done.tid)).status, 404);
  // 終わった大会：全ハンド・全員の手札。アカウント ID は出さない
  const D = (await call(k, "api/review/hands?t=" + done.tid)).body;
  assert.equal(D.running, 0);
  assert.equal(D.hands.length, done.g.hist.length);
  assert.ok(D.hands.every((H) => H.seats.every((s) => s.h)));
  assert.ok(!JSON.stringify(D.hands).includes(k.user.id) && !JSON.stringify(D.hands).includes('"uid"'));
  // 続いている大会：自分が配られたハンドだけ。他の人の非公開の手札は null
  const L = (await call(k, "api/review/hands?t=" + live.tid)).body;
  assert.equal(L.running, 1);
  const myOid = L.tournament.oid;
  assert.ok(L.hands.length > 0 && L.hands.every((H) => H.seats.some((s) => s.oid == myOid)));
  assert.ok(L.hands.every((H) => H.seats.every((s) => s.oid == myOid || s.shown || s.h === null)));
});

test("傾向：自分のは見られる。他の人のは「身内CPU化に使ってよい」にした人だけ", async (t) => {
  const { member, call, records, accounts } = await boot(t);
  const k = member("Kaina"), c = member("Croque");
  const done = mp(records, k, c);
  const mine = (await call(k, "api/style")).body;
  assert.equal(mine.user.name, "Kaina");
  const P = done.g.P.find((p) => p.uid == k.user.id);
  assert.equal(mine.mp.counts.hands, P.rec[0].hands, "対人のハンド数が記録と一致");
  assert.equal(mine.all.rows.length, E.ME_ROWS.length);
  assert.equal(mine.solo.counts.hands || 0, 0);
  // Croque はまだ使ってよいにしていない
  assert.equal((await call(k, "api/style?u=" + c.user.id)).status, 403);
  assert.deepEqual((await call(k, "api/style/members")).body.members, []);
  // 使ってよいにする（本人の操作）
  const r = await call(c, "api/me/share", { body: { on: true } });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.share, 1);
  assert.deepEqual((await call(k, "api/style/members")).body.members.map((m) => m.name), ["Croque"]);
  assert.equal((await call(k, "api/style?u=" + c.user.id)).status, 200);
  // 止めたアカウントは出さない
  accounts.setDisabled(c.user.id, true);
  assert.equal((await call(k, "api/style?u=" + c.user.id)).status, 403);
  assert.deepEqual((await call(k, "api/style/members")).body.members, []);
});

test("身内CPUの材料：ひとり用のエクスポートと同じ形。合算・対人・対CPU を選べる", async (t) => {
  const { member, call, records } = await boot(t);
  const k = member("Kaina"), c = member("Croque");
  mp(records, k, c);
  // ひとり用の大会も入れる
  const m = new Map(), store = { get: (x) => m.get(x) ?? null, set: (x, v) => m.set(x, v) };
  const s = { dur: 6e4, lv: 1, entries: 40, lg: [], lvEnd: 0, hist: [] };
  E.soloSetup(s, store);
  s.hero.rec = [{}];
  for (let i = 0; i < 20 && s.T.p.filter((p) => p.stack > 0).length > 1; i++) (E.playHand(s, s.T), E.bust(s, s.T));
  records.solo(k.user, { key: "s".repeat(20), hands: s.hist.map((H) => ({ ...H, seats: H.seats.map((x) => ({ ...x, uid: x.hero ? k.user.id : null })) })), stats: {}, entries: 40, re: 0 });
  const get = async (src) => {
    const r = await call(k, "api/style/profile?src=" + src);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-disposition"), /attachment/);
    return r.body;
  };
  const all = await get("all"), mpP = await get("mp"), solo = await get("solo");
  for (const p of [all, mpP, solo]) {
    assert.equal(p.format, "alpoker-profile");
    assert.equal(p.version, 1);
    assert.equal(p.name, "Kaina");
    assert.deepEqual(Object.keys(p.keys), Object.keys(E.REC_KEYS));
    assert.ok(p.summary["VPIP（参加率）"] != null);
    assert.ok(p.pos && p.depth);
  }
  assert.equal(all.all.hands, mpP.all.hands + solo.all.hands);
  assert.equal(solo.all.hands, s.hist.length);
  assert.deepEqual([all.source, mpP.source, solo.source, all.tournaments, mpP.tournaments, solo.tournaments], ["all", "mp", "solo", 2, 1, 1]);
  assert.equal(all.recent.hands, all.all.hands, "直近30日（いま作ったので全部）");
  // 他の人の材料も、使ってよいにしていなければ書き出せない
  assert.equal((await call(c, "api/style/profile?u=" + k.user.id)).status, 403);
});

test("他の人の傾向には、続いている大会を数えない（大会中に隠れている手札が漏れないように）。応答に部屋を作った人の ID を出さない", async (t) => {
  const { accounts, records, member, call } = await boot(t);
  const a = member("Aki"), b = member("Ben");
  accounts.setShare(b.user.id, true);
  const run = mp(records, a, b, 6); // 続いている大会
  assert.ok(!run.g.over && run.g.hist.length >= 6);
  // 自分の傾向には入る。他の人から見ると入らない
  assert.ok((await call(b, "api/style")).body.all.counts.hands > 0);
  const seen = (await call(a, "api/style?u=" + b.user.id)).body;
  assert.equal(seen.all.counts.hands || 0, 0, "続いている大会は数えない");
  const prof = (await call(a, "api/style/profile?u=" + b.user.id)).body;
  assert.equal(prof.all.hands || 0, 0);
  // 終われば数える
  records.finish(run.tid, run.g, "closed");
  assert.ok((await call(a, "api/style?u=" + b.user.id)).body.all.counts.hands > 0, "閉じた大会は数える");
  // 振り返りの大会の行は、画面に要るものだけ
  const h = (await call(a, "api/review/hands?t=" + run.tid)).body;
  assert.deepEqual(Object.keys(h.tournament).sort(), ["blind_min", "closed", "entries", "finished", "finished_at", "id", "oid", "source", "started_at"]);
});

test("傾向の since は、実際に数えた範囲（日の単位に切り下げたもの）を返す。材料の大会の数も、数えたハンドと同じ条件で", async (t) => {
  const { accounts, records, member, call } = await boot(t);
  const a = member("Ayu"), b = member("Bo");
  accounts.setShare(b.user.id, true);
  const since = Date.now() - 30 * 864e5;
  const r = (await call(a, "api/style?since=" + since)).body;
  assert.equal(r.since, Math.floor(since / 864e5) * 864e5);
  const run = mp(records, a, b, 4); // 続いている大会
  assert.ok(!run.g.over);
  assert.equal((await call(a, "api/style/profile?u=" + b.user.id)).body.tournaments, 0, "他の人から見ると、続いている大会は数えない");
  assert.equal((await call(b, "api/style/profile")).body.tournaments, 1, "自分なら数える");
});
