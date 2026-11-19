// スポット：問題の作り方（成り立たない場面を出さない）と、回答の決まり（答えるまで見えない・1人1回・他の人の答えた問題を優先）
const test = require("node:test");
const assert = require("node:assert");
const { startServer } = require("../server/server.js");
const { openAccounts } = require("../server/accounts.js");
const { makePreflop, spotKey, cleanAnswer, HAND_POOL, ORDER } = require("../server/spots.js");

// 再現できる乱数
const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

test("問題：成り立たない場面を作らない（BB のオープン・BB の 3bet 対応・10BB の 3bet 対応）", () => {
  const R = rng(7);
  const seen = new Set();
  for (let i = 0; i < 3000; i++) {
    const s = makePreflop(R);
    seen.add(s.scenario + s.hero.position);
    assert.ok(!(s.scenario == "open" && s.hero.position == "BB"));
    assert.ok(!(s.scenario == "vs3bet" && s.hero.position == "BB"));
    assert.ok(!(s.scenario == "vs3bet" && s.hero.stack_bb == 10));
    assert.ok(s.hero.position != "BTN", "BTN は出題しない");
    assert.ok(HAND_POOL.includes(s.hero.cls));
    // 手札は2枚、別のカードで、手の種類と合う
    const [a, b] = s.hero.hand;
    assert.ok(a !== b && a >= 0 && a < 52 && b >= 0 && b < 52);
    const suited = Math.floor(a / 13) == Math.floor(b / 13);
    if (s.hero.cls.length == 3) assert.equal(suited, s.hero.cls[2] == "s", s.hero.cls);
    // 流れ：自分より前の人は全員出てくる。オープン・3bet の人は、オールインにならない持ち点
    const hi = ORDER.indexOf(s.hero.position);
    assert.deepEqual(s.actions.slice(0, hi).map((x) => x.pos), ORDER.slice(0, hi));
    for (const x of s.actions.filter((x) => x.action == "raise" && x.pos != s.hero.position)) {
      const st = s.seats.find((y) => y.pos == x.pos).stack_bb;
      assert.ok(st > x.to_bb + s.ante_bb, `${x.pos} の持ち点 ${st} > ${x.to_bb}`);
    }
    // 額のつじつま
    assert.ok(s.to_call_bb >= 0 && s.min_raise_bb > s.facing_bb && s.max_bb > 0);
    if (s.scenario == "vs3bet") assert.ok(s.actions.some((x) => x.pos == s.hero.position && x.action == "raise"));
  }
  // 出るはずの組み合わせは、全部出る
  for (const k of ["openUTG", "openCO", "openSB", "vsopenCO", "vsopenSB", "vsopenBB", "vs3betUTG", "vs3betCO", "vs3betSB"]) assert.ok(seen.has(k), k);
});

test("同じ問題の目印：スートと相手の細かい持ち点が違っても同じ。手や深さが違えば別", () => {
  const a = makePreflop(rng(1), { scenario: "open", pos: "CO", stack: 16, hand: "A5s" });
  const b = makePreflop(rng(2), { scenario: "open", pos: "CO", stack: 16, hand: "A5s" });
  const c = makePreflop(rng(1), { scenario: "open", pos: "CO", stack: 20, hand: "A5s" });
  assert.equal(spotKey(a), spotKey(b));
  assert.notEqual(spotKey(a), spotKey(c));
});

test("回答の中身：コメント必須・行動・レイズ額の範囲", () => {
  const s = makePreflop(rng(3), { scenario: "vsopen", pos: "BB", stack: 25, hand: "KJo" });
  assert.ok(cleanAnswer({ action: "call", comment: "  " }, s).error);
  assert.ok(cleanAnswer({ action: "check", comment: "x" }, s).error);
  assert.ok(cleanAnswer({ action: "raise", size: s.facing_bb, comment: "x" }, s).error);
  assert.ok(cleanAnswer({ action: "raise", size: s.max_bb, comment: "x" }, s).error);
  assert.ok(cleanAnswer({ action: "fold", comment: "x".repeat(501) }, s).error);
  assert.deepEqual(cleanAnswer({ action: "raise", size: s.min_raise_bb + 0.04, comment: " 3bet で取る \r\n" }, s).ok, { action: "raise", size_bb: +(s.min_raise_bb + 0.04).toFixed(1), comment: "3bet で取る" });
  assert.equal(cleanAnswer({ action: "call", size: 99, comment: "x" }, s).ok.size_bb, null);
});

async function boot(t) {
  const accounts = openAccounts();
  const srv = await startServer({ PORT: 0, HOST: "127.0.0.1", quiet: 1, DB_FILE: ":memory:", accounts, store: { get: () => null, set() {} } });
  t.after(() => srv.close());
  const origin = `http://127.0.0.1:${srv.port}`;
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
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  return { member, call };
}

test("回答：答えるまで他の人の答えは見えない。1人1回で直せない。次の問題は他の人が答えたものから", async (t) => {
  const { member, call } = await boot(t);
  const k = member("Kaina"), c = member("Croque"), m = member("Mio");
  // ログインしていないと使えない
  assert.equal((await call(null, "api/spots")).status, 401);
  assert.equal((await call(null, "api/spots/answer", { body: { id: 1, action: "fold", comment: "x" } })).status, 401);
  // 最初の「次の問題」で作られる
  const id = (await call(k, "api/spots/next")).body.id;
  assert.ok(id > 0);
  const one = await call(k, "api/spots/one?id=" + id);
  assert.equal(one.body.answered, 0);
  assert.equal(one.body.answers, undefined);
  // 別のサイトからの回答は断る
  assert.equal((await call(k, "api/spots/answer", { body: { id, action: "fold", comment: "x" }, origin: "https://evil.example" })).status, 401);
  assert.equal((await call(k, "api/spots/answer", { body: { id, action: "fold", comment: "" } })).status, 400);
  assert.equal((await call(k, "api/spots/answer", { body: { id, action: "fold", comment: "弱い" } })).status, 200);
  // 2回目は断る（直せない）
  assert.equal((await call(k, "api/spots/answer", { body: { id, action: "allin", comment: "やっぱり" } })).status, 409);
  const after = await call(k, "api/spots/one?id=" + id);
  assert.equal(after.body.answered, 1);
  assert.deepEqual(after.body.answers.map((a) => [a.name, a.action, a.comment, a.me]), [["Kaina", "fold", "弱い", 1]]);
  assert.ok(!("uid" in after.body.answers[0]), "アカウント ID は出さない");
  // Croque が答えていないうちは、Kaina の答えは見えない。次の問題は Kaina が答えたもの
  const cv = await call(c, "api/spots/one?id=" + id);
  assert.equal(cv.body.answers, undefined);
  assert.equal(cv.body.count, 1);
  // 新しい問題も1つ作っておく（Kaina の「次」：答えていないものがないので作られる）
  const id2 = (await call(k, "api/spots/next")).body.id;
  assert.notEqual(id2, id);
  assert.equal((await call(c, "api/spots/next")).body.id, id, "他の人が答えた問題を先に");
  assert.equal((await call(c, "api/spots/answer", { body: { id, action: "allin", comment: "押す" } })).status, 200);
  const cv2 = await call(c, "api/spots/one?id=" + id);
  assert.deepEqual(cv2.body.answers.map((a) => [a.name, a.me]), [["Kaina", 0], ["Croque", 1]]);
  // 一覧：自分の答えと人数
  const L = (await call(m, "api/spots")).body.spots;
  assert.deepEqual(L.map((s) => [s.id, s.answers, s.mine]), [[id2, 0, null], [id, 2, null]]);
  const Lk = (await call(k, "api/spots")).body.spots;
  assert.equal(Lk.find((s) => s.id == id).mine, "fold");
  // ない問題
  assert.equal((await call(k, "api/spots/one?id=999")).status, 404);
  assert.equal((await call(k, "api/spots/answer", { body: { id: 999, action: "fold", comment: "x" } })).status, 404);
});
