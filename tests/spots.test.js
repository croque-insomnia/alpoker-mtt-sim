// スポット：問題の作り方（成り立たない場面を出さない）と、回答の決まり（答えるまで見えない・1人1回・他の人の答えた問題を優先）
const test = require("node:test");
const assert = require("node:assert");
const { startServer } = require("../server/server.js");
const { openAccounts } = require("../server/accounts.js");
const { makePreflop, makePostflop, spotKey, cleanAnswer, isFacing, openSpots, hasLimp, BAD, HAND_POOL, ORDER } = require("../server/spots.js");
const { openDb } = require("../server/db.js");
const E = require("../engine.js");

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
    const ord = s.seats.map((x) => x.pos), hi = ord.indexOf(s.hero.position);
    assert.equal(ord.length, s.table_size);
    assert.deepEqual(ord, ORDER.slice(ORDER.length - ord.length), "席は 5-Max の後ろから");
    assert.deepEqual(s.actions.slice(0, hi).map((x) => x.pos), ord.slice(0, hi));
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

test("ポストフロップ：同じシードなら同じ場面（配札も CPU の動きも）。乱数の差し替えは外に漏れない", () => {
  let found = 0;
  for (let seed = 1; seed < 3000 && found < 20; seed++) {
    const a = makePostflop(seed);
    if (!a) continue;
    found++;
    assert.deepEqual(makePostflop(seed), a, "seed " + seed);
    assert.equal(spotKey(a), spotKey(makePostflop(seed)));
  }
  assert.ok(found >= 20, "シードのうち、場面になるものがある: " + found);
  // withRandom のあとは、ふだんの乱数に戻っている（同じシードでも、外のシャッフルは毎回違う）
  const x = JSON.stringify(E.shf([...Array(52).keys()])), y = JSON.stringify(E.shf([...Array(52).keys()]));
  assert.notEqual(x, y);
});

test("ポストフロップ：場面のつじつま（ボード・手札・持ち点とポット・行動の流れ・自明な場面を出さない）", () => {
  const streets = {};
  let facing = 0, n = 0;
  for (let seed = 5000; seed < 12000; seed++) {
    const s = makePostflop(seed);
    if (!s) continue;
    n++;
    streets[s.street] = (streets[s.street] || 0) + 1;
    assert.equal(s.board.length, { flop: 3, turn: 4, river: 5 }[s.street]);
    const cards = s.board.concat(s.hero.hand);
    assert.equal(new Set(cards).size, cards.length, "カードが重ならない");
    // 出た額の合計 = ポット（0.1 単位の丸め分だけずれてよい）
    const out = s.seats.reduce((t, x) => t + x.stack_bb - x.now_bb, 0);
    assert.ok(Math.abs(out - s.pot_bb) < 0.6, `pot ${s.pot_bb} vs ${out}`);
    const me = s.seats.find((x) => x.pos == s.hero.position);
    assert.ok(me && !me.fold && !me.allin && me.now_bb > 0);
    assert.ok(s.seats.filter((x) => !x.fold).length >= 2);
    assert.ok(s.actions.some((a) => a.street == "preflop") && s.actions.every((a) => ["preflop", "flop", "turn", "river"].includes(a.street)));
    assert.ok(s.max_bb > 0 && s.min_raise_bb > s.facing_bb);
    if (s.to_call_bb > 0) {
      facing++;
      assert.ok(E.tier(s.hero.hand, s.board) >= 1 || E.draw(s.hero.hand, s.board), "ベットを受けていて、何もない手は出さない");
    }
  }
  assert.ok(n >= 100 && streets.flop && streets.turn && streets.river, JSON.stringify(streets));
  assert.ok(facing > n * 0.1, `ベットを受ける場面もある ${facing}/${n}`);
});

test("回答の中身：ポストフロップは、ベットを受けていなければ チェック・ベット、受けていれば フォールド・コール・レイズ", () => {
  let open = null, faced = null;
  for (let seed = 1; seed < 5000 && !(open && faced); seed++) {
    const s = makePostflop(seed);
    if (s && s.to_call_bb > 0) faced ||= s;
    else if (s) open ||= s;
  }
  assert.ok(cleanAnswer({ action: "check", comment: "x" }, open).ok);
  assert.ok(cleanAnswer({ action: "fold", comment: "x" }, open).error);
  assert.ok(cleanAnswer({ action: "call", comment: "x" }, open).error);
  assert.equal(cleanAnswer({ action: "bet", size: open.min_raise_bb, comment: "x" }, open).ok.size_bb, open.min_raise_bb);
  assert.ok(cleanAnswer({ action: "bet", size: 0.5, comment: "x" }, open).error);
  assert.ok(cleanAnswer({ action: "check", comment: "x" }, faced).error);
  assert.ok(cleanAnswer({ action: "bet", size: 99, comment: "x" }, faced).error);
  assert.ok(cleanAnswer({ action: "call", comment: "x" }, faced).ok);
  assert.ok(cleanAnswer({ action: "allin", comment: "x" }, faced).ok && cleanAnswer({ action: "allin", comment: "x" }, open).ok);
});

// fill: 作り置きの間隔（ms）。ふだんは止めておく（問題の数を数えるテストが、裏で増えた問題で狂わないように）
async function boot(t, fill = 1e9) {
  const accounts = openAccounts();
  const srv = await startServer({ PORT: 0, HOST: "127.0.0.1", quiet: 1, DB_FILE: ":memory:", accounts, store: { get: () => null, set() {} }, spotFillMs: fill });
  t.after(() => srv.close());
  const origin = `http://127.0.0.1:${srv.port}`;
  const member = (name) => {
    const iv = accounts.createInvite("member");
    const { user } = accounts.loginExternal({ provider: "google", sub: name, name }, { invite: iv.token });
    return { user, sid: accounts.createSession(user.id, "t").token };
  };
  const call = (m, p, o = {}) =>
    fetch(origin + "/" + p, {
      method: o.body || o.raw != null ? "POST" : "GET",
      headers: { origin: o.origin || origin, "content-type": "application/json", ...(m ? { cookie: "alp_sid=" + m.sid } : {}) },
      body: o.raw != null ? o.raw : o.body && JSON.stringify(o.body), // raw: 送る文字をそのまま
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
  // 降りる答え：ベットを受けていればフォールド、受けていなければチェック（問題はプリフロップかポストフロップのどちらか）
  const pass = one.body.spot.situation.to_call_bb > 0 ? "fold" : "check";
  // 別のサイトからの回答は断る
  assert.equal((await call(k, "api/spots/answer", { body: { id, action: pass, comment: "x" }, origin: "https://evil.example" })).status, 401);
  assert.equal((await call(k, "api/spots/answer", { body: { id, action: pass, comment: "" } })).status, 400);
  assert.equal((await call(k, "api/spots/answer", { body: { id, action: pass, comment: "弱い" } })).status, 200);
  // 2回目は断る（直せない）
  assert.equal((await call(k, "api/spots/answer", { body: { id, action: "allin", comment: "やっぱり" } })).status, 409);
  const after = await call(k, "api/spots/one?id=" + id);
  assert.equal(after.body.answered, 1);
  assert.deepEqual(after.body.answers.map((a) => [a.name, a.action, a.comment, a.me]), [["Kaina", pass, "弱い", 1]]);
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
  assert.equal(Lk.find((s) => s.id == id).mine, pass);
  // ない問題
  assert.equal((await call(k, "api/spots/one?id=999")).status, 404);
  assert.equal((await call(k, "api/spots/answer", { body: { id: 999, action: "fold", comment: "x" } })).status, 404);
});

test("回答：中身が null などでもサーバーは落ちず、400 を返す", async (t) => {
  const { member, call } = await boot(t);
  const k = member("Kaina");
  // null・数・文字は「読めない」、配列は id がないので「ない問題」
  for (const [raw, want] of [["null", 400], ["1", 400], ['"x"', 400], ["[]", 404]]) assert.equal((await call(k, "api/spots/answer", { raw })).status, want, raw);
  // そのあとも動いている
  assert.equal((await call(k, "api/spots")).status, 200);
});

test("問題作り：重いポストフロップは時間で打ち切り、作れなければもう一方の種類で作る。作り置きは足りないときだけ", () => {
  const db = openDb(":memory:"), sp = openSpots(db);
  // 使える時間が 0 なら、ポストフロップは作れず、プリフロップで作る
  const id = sp.create(Math.random, "postflop", 0);
  assert.equal(sp.get(id).kind, "preflop");
  // 作り置き：まだ誰も答えていないポストフロップが 3 問になるまで作る
  for (let i = 0; i < 400 && sp.list("u").filter((s) => s.kind == "postflop").length < 3; i++) sp.topUp(3, 50);
  assert.equal(sp.list("u").filter((s) => s.kind == "postflop").length, 3);
  assert.equal(sp.topUp(3, 50), null, "足りていれば作らない");
});

test("作り置き：足りない種類のうち、少ないほうから作る（プリフロップばかりにならない）", () => {
  const db = openDb(":memory:"), sp = openSpots(db);
  const R = rng(5);
  for (let i = 0; i < 2; i++) sp.create(R, "preflop"); // プリフロップ 2・ポストフロップ 0
  let id = null;
  for (let i = 0; i < 400 && !id; i++) id = sp.topUp(3, 50);
  assert.equal(sp.get(id).kind, "postflop", "少ないポストフロップから");
});

test("一覧：未回答を先に並べてから上限で切る。全体の数も返す", () => {
  const db = openDb(":memory:"), sp = openSpots(db);
  const R = rng(3), ids = [];
  for (let i = 0; i < 6; i++) ids.push(sp.create(R, "preflop"));
  // 古い 3 問だけ未回答にする
  for (const id of ids.slice(3)) sp.answer(id, "u", { action: "allin", size_bb: null, comment: "x" });
  assert.deepEqual(sp.list("u", 3).map((s) => s.id), ids.slice(0, 3).reverse(), "上限 3 でも、未回答の古い問題が出る");
  assert.deepEqual(sp.totals("u"), { total: 6, done: 3 });
});

test("ベットを受けているかは、丸める前の額で決める（ごく小さな上乗せでも、チェック・ベットにしない）", () => {
  const s = { to_call_bb: 0, facing: 1, min_raise_bb: 2, max_bb: 20 };
  assert.ok(isFacing(s));
  assert.ok(cleanAnswer({ action: "check", comment: "x" }, s).error);
  assert.ok(cleanAnswer({ action: "fold", comment: "x" }, s).ok);
  // 印のない古い問題は、to_call_bb で見る
  assert.ok(!isFacing({ to_call_bb: 0 }));
  // 作った問題には印が付き、to_call_bb と合う
  for (let seed = 1, n = 0; n < 50; seed++) {
    const p = makePostflop(seed);
    if (!p) continue;
    n++;
    assert.equal(p.facing, p.to_call_bb > 0 ? 1 : p.facing);
  }
  assert.equal(makePreflop(rng(1)).facing, 1);
});

test("engine の R は、withRandom の中では差し替えた乱数を返す", () => {
  const a = E.withRandom(E.seeded(5), () => [E.R(), E.R()]), b = E.withRandom(E.seeded(5), () => [E.R(), E.R()]);
  assert.deepEqual(a, b);
});

test("ポストフロップ：リンプのあった場面は出さない（SB と BB の2人きりで揃えるのは残す）。前に作った未回答のものは片付ける", () => {
  const A = (pos, action) => ({ street: "preflop", pos, action });
  const F = (p) => A(p, "fold");
  assert.ok(hasLimp([A("UTG", "call"), F("CO"), F("BTN"), F("SB"), A("BB", "check")]), "UTG のリンプ");
  assert.ok(hasLimp([F("UTG"), F("CO"), F("BTN"), A("SB", "call"), A("BB", "raise"), A("SB", "call")]) === false, "SB と BB の2人きり");
  assert.ok(hasLimp([F("UTG"), A("CO", "call"), F("BTN"), A("SB", "call"), A("BB", "check")]), "CO のリンプのあとの SB");
  assert.ok(!hasLimp([A("UTG", "raise"), A("CO", "call"), F("BTN"), F("SB"), A("BB", "call")]), "レイズのあとのコールはリンプではない");
  assert.ok(!hasLimp([A("SB", "call"), A("BB", "check")], 2), "ヘッズアップの SB のリンプは2人きりなので残す");
  assert.ok(!hasLimp([F("BTN"), A("SB", "call"), A("BB", "check")], 3), "3人卓で BTN が降りたあとの SB");
  assert.ok(hasLimp([A("BTN", "call"), F("SB"), A("BB", "check")], 3), "3人卓の BTN のリンプ");
  // 作った問題には、リンプがない
  for (let seed = 1, n = 0; n < 150; seed++) {
    const x = makePostflop(seed);
    if (!x) continue;
    n++;
    assert.ok(!hasLimp(x.actions, x.table_size), "seed " + seed);
  }
  // 片付け：未回答でリンプのあるものだけ消し、答えのついたものは残す
  const db = openDb(":memory:");
  openSpots(db);
  const ins = db.prepare("INSERT INTO spots (kind, source, situation, hash, created_at) VALUES ('postflop', 'auto', ?, ?, 0)");
  const limped = JSON.stringify({ actions: [A("UTG", "call"), F("CO"), F("BTN"), F("SB"), A("BB", "check")] });
  const a = Number(ins.run(limped, "a").lastInsertRowid), b = Number(ins.run(limped, "b").lastInsertRowid);
  const c = Number(ins.run(JSON.stringify({ actions: [A("UTG", "raise")] }), "c").lastInsertRowid);
  db.prepare("INSERT INTO spot_answers (spot_id, uid, action, comment, answered_at) VALUES (?, 'u', 'check', 'x', 0)").run(b);
  openSpots(db);
  assert.deepEqual(db.prepare("SELECT id FROM spots ORDER BY id").all().map((r) => r.id), [b, c]);
  assert.ok(a);
});

test("問題に大会の状況（残り人数・入賞・平均の持ち点）が入る。バブル付近・最終卓も出る", () => {
  const left = new Set();
  for (const x of [...Array.from({ length: 300 }, () => makePreflop()), ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map(makePostflop).filter(Boolean)]) {
    assert.ok(x.players_left >= 2 && x.players_left <= 30, x.kind + " " + x.players_left);
    // 卓の人数はゲームと同じ決め方（ceil(残り/5) 卓に、人数差1以内で座る）。残り7人で5人卓、などはない
    const t = Math.ceil(x.players_left / 5);
    assert.ok([Math.floor(x.players_left / t), Math.ceil(x.players_left / t)].includes(x.table_size), `残り${x.players_left}人で${x.table_size}人卓`);
    // 残り5人以下は全員がこの卓にいるので、平均はこの卓の持ち点と合う
    if (x.players_left <= 5) {
      const mean = x.seats.reduce((t, q) => t + q.stack_bb, 0) / x.seats.length;
      assert.ok(Math.abs(x.avg_bb - mean) < 0.2, `${x.kind} 残り${x.players_left}人 平均 ${x.avg_bb} / 卓 ${mean}`);
    }
    left.add(x.players_left);
    assert.equal(x.entries, 40);
    assert.equal(x.itm, 8);
    assert.ok(x.avg_bb >= 5 && x.avg_bb <= 60, x.kind + " avg " + x.avg_bb);
  }
  for (const n of [2, 3, 4, 5, 8, 9, 11]) assert.ok(left.has(n), "残り " + n + " 人の問題も出る");
  // 最終卓・少ない人数の卓のポストフロップも作れる（ヘッズアップも）
  const sizes = new Set();
  for (let seed = 1; sizes.size < 4 && seed < 6000; seed++) {
    const x = makePostflop(seed);
    if (x) {
      sizes.add(x.table_size);
      assert.equal(x.seats.length, x.table_size);
      const t = Math.ceil(x.players_left / 5);
      assert.ok([Math.floor(x.players_left / t), Math.ceil(x.players_left / t)].includes(x.table_size));
    }
  }
  assert.deepEqual([...sizes].sort(), [2, 3, 4, 5], "2〜5人卓のどれも出る");
});

test("ポストフロップ：自分のドンク（前のストリートの攻め手がまだ動いていないのに先に打つか）はごくまれにしか出さない", () => {
  const donk = (x) => {
    if (x.facing) return false;
    const prev = { flop: "preflop", turn: "flop", river: "turn" }[x.street];
    let agg = null;
    for (const a of x.actions) if (a.street == prev && (a.action == "bet" || a.action == "raise")) agg = a.pos;
    return !!agg && agg != x.hero.position && !x.actions.some((a) => a.street == x.street && a.pos == agg);
  };
  let n = 0, d = 0;
  for (let seed = 1; n < 400; seed++) {
    const x = makePostflop(seed);
    if (!x) continue;
    n++;
    if (donk(x)) d++;
  }
  assert.ok(d / n < 0.05, `ドンク ${d}/${n}`);
});

test("次の問題：前に答えたのと違う種類を出す。評価の高い問題を先に、悪い問題は出さない。評価は答えてから", async (t) => {
  // 作り置きを動かす（ポストフロップは1問作るのに 0.1 秒ほどかかり、「次の問題」の中では作り切れないことが多い。本番と同じく作り置きから出す）
  const { member, call } = await boot(t, 20);
  const k = member("Kaina"), c = member("Croque"), m = member("Mio");
  for (let i = 0; i < 300; i++) {
    const L = (await call(k, "api/spots")).body.spots;
    if (["preflop", "postflop"].every((kd) => L.filter((s) => s.kind == kd).length >= 3)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const kindOf = async (who, id) => (await call(who, "api/spots/one?id=" + id)).body.spot.kind;
  const answer = async (who, id) => {
    const s = (await call(who, "api/spots/one?id=" + id)).body.spot.situation;
    return call(who, "api/spots/answer", { body: { id, action: isFacing(s) ? "fold" : "check", comment: "x" } });
  };
  // 交互に出る
  const kinds = [];
  for (let i = 0; i < 4; i++) {
    const id = (await call(k, "api/spots/next")).body.id;
    kinds.push(await kindOf(k, id));
    assert.equal((await answer(k, id)).status, 200);
  }
  for (let i = 1; i < kinds.length; i++) assert.notEqual(kinds[i], kinds[i - 1], kinds.join(","));
  // 評価：答える前はできない。答えたあとは良い・悪いを付けられ、取り消せる
  const ids = (await call(k, "api/spots")).body.spots.map((s) => s.id);
  const [a1, a2] = ids;
  assert.equal((await call(c, "api/spots/vote", { body: { id: a1, vote: 1 } })).status, 403);
  await answer(c, a1);
  const v = await call(c, "api/spots/vote", { body: { id: a1, vote: 1 } });
  assert.deepEqual([v.status, v.body.votes.up, v.body.votes.mine], [200, 1, 1]);
  assert.equal((await call(c, "api/spots/vote", { body: { id: a1, vote: 2 } })).status, 400);
  assert.equal((await call(c, "api/spots/vote", { raw: "null" })).status, 400);
  assert.equal((await call(c, "api/spots/one?id=" + a1)).body.votes.up, 1);
  // 悪い問題が BAD 票分たまると、ほかの人の「次の問題」に出ない
  // 悪い票を -BAD 票ぶん入れる（BAD を変えても、この確認がその基準どおりに働くように）
  const voters = [k, c, ...Array.from({ length: Math.max(0, -BAD - 2) }, (_, i) => member("V" + i))];
  for (const who of voters.slice(0, -BAD)) {
    await answer(who, a2);
    assert.equal((await call(who, "api/spots/vote", { body: { id: a2, vote: -1 } })).status, 200);
  }
  const seen = new Set();
  for (let i = 0; i < 6; i++) {
    const id = (await call(m, "api/spots/next")).body.id;
    seen.add(id);
    await answer(m, id);
  }
  assert.ok(!seen.has(a2), "悪い問題は出ない");
  assert.ok(seen.has(a1), "良い問題は出る");
  // 一覧に評価が出る
  const L = (await call(m, "api/spots")).body.spots;
  assert.equal(L.find((s) => s.id == a1).score, 1);
  assert.equal(L.find((s) => s.id == a2).score, BAD);
});

test("卓の人数が減ったプリフロップ：出せる席だけを出し、ヘッズアップは SB（ボタン）から", () => {
  const { orderOf, heroPosOf } = require("../server/spots.js");
  assert.deepEqual(orderOf(2), ["SB", "BB"]);
  assert.deepEqual(orderOf(3), ["BTN", "SB", "BB"]);
  assert.deepEqual(heroPosOf("open", orderOf(2)), ["SB"]);
  assert.deepEqual(heroPosOf("vsopen", orderOf(2)), ["BB"]);
  assert.deepEqual(heroPosOf("vs3bet", orderOf(2)), ["SB"]);
  assert.deepEqual(heroPosOf("open", orderOf(5)), ["UTG", "CO", "SB"]);
  const R = rng(11), seen = new Set();
  for (let i = 0; i < 3000; i++) {
    const s = makePreflop(R);
    if (s.table_size < 5) seen.add(s.table_size + s.scenario + s.hero.position);
    // 額のつじつま（ヘッズアップでも）
    assert.ok(s.to_call_bb >= 0 && s.min_raise_bb > s.facing_bb && s.max_bb > 0, JSON.stringify(s));
  }
  for (const k of ["2openSB", "2vsopenBB", "2vs3betSB", "3openSB", "3vsopenBB", "4openCO", "4vs3betCO"]) assert.ok(seen.has(k), k);
});

test("卓の人数：ゲームと同じ決め方（残り7人 → 4人卓か3人卓、6人 → 3人卓）", () => {
  const { tableSizeOf } = require("../server/spots.js");
  const sizes = (L) => new Set(Array.from({ length: 500 }, () => tableSizeOf(L, Math.random)));
  assert.deepEqual([...sizes(7)].sort(), [3, 4]);
  assert.deepEqual([...sizes(6)], [3]);
  assert.deepEqual([...sizes(9)].sort(), [4, 5]);
  assert.deepEqual([...sizes(11)].sort(), [3, 4]);
  assert.deepEqual([...sizes(30)], [5]);
  for (let L = 2; L <= 5; L++) assert.deepEqual([...sizes(L)], [L]);
  // 問題でも、残り7人で5人卓は出ない
  for (let i = 0; i < 3000; i++) {
    const s = makePreflop();
    if (s.players_left == 7) assert.ok(s.table_size == 3 || s.table_size == 4);
  }
});

test("お気に入りとマイページ：お気に入りの一覧、他の人と答えが違った問題、答えの傾向", async (t) => {
  const { member, call } = await boot(t);
  const k = member("Kaina"), c = member("Croque"), m = member("Mio");
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await call(k, "api/spots/next")).body.id), await call(k, "api/spots/answer", { body: await ans(k, ids[i], "pass") });
  async function ans(who, id, how) {
    const s = (await call(who, "api/spots/one?id=" + id)).body.spot.situation;
    const facing = isFacing(s);
    return { id, action: how == "pass" ? (facing ? "fold" : "check") : "allin", comment: "x" };
  }
  // ほかの2人は、1問目で Kaina と違う行動（オールイン）、2問目で同じ行動
  for (const who of [c, m]) {
    await call(who, "api/spots/answer", { body: await ans(who, ids[0], "push") });
    await call(who, "api/spots/answer", { body: await ans(who, ids[1], "pass") });
  }
  // お気に入り：付ける・外す。答える前でも付けられる。ほかの人のお気に入りは見えない
  assert.equal((await call(k, "api/spots/fav", { body: { id: ids[2], on: true } })).body.fav, 1);
  assert.equal((await call(k, "api/spots/one?id=" + ids[2])).body.fav, 1);
  assert.equal((await call(c, "api/spots/one?id=" + ids[2])).body.fav, 0);
  assert.equal((await call(k, "api/spots/fav", { body: { id: ids[2], on: "yes" } })).status, 400);
  assert.equal((await call(k, "api/spots/fav", { raw: "null" })).status, 400);
  assert.equal((await call(k, "api/spots")).body.spots.find((s) => s.id == ids[2]).fav, 1);
  const me = (await call(k, "api/spots/mine")).body;
  assert.deepEqual(me.favs.map((f) => f.id), [ids[2]]);
  assert.equal(me.answered, 3);
  // 1問目は2人とも違う行動 → 答えが違った問題。2問目は同じ → 出ない
  assert.deepEqual(me.minority.map((x) => [x.id, x.diff, x.n]), [[ids[0], 1, 2]]);
  assert.deepEqual(me.agree, { n: 2, rate: 50 });
  // 傾向：同じ問題で、自分の行動とほかの人の行動の割合を比べる。
  // 1問目は自分が降りる側（降りる・チェック）でほかの2人はオールイン、2問目は全員が自分と同じ
  const want = { facing: { n: 0, mine: {}, others: {} }, open: { n: 0, mine: {}, others: {} } };
  for (const [id, othersPush] of [[ids[0], true], [ids[1], false]]) {
    const f = isFacing((await call(k, "api/spots/one?id=" + id)).body.spot.situation), w = want[f ? "facing" : "open"], mine = f ? "fold" : "passive";
    w.n++;
    w.mine[mine] = (w.mine[mine] || 0) + 1;
    const o = othersPush ? "aggr" : mine;
    w.others[o] = (w.others[o] || 0) + 1;
  }
  const pct = (w) => ({ n: w.n, mine: Object.fromEntries(Object.entries(w.mine).map(([g, v]) => [g, Math.round((v / w.n) * 100)])), others: Object.fromEntries(Object.entries(w.others).map(([g, v]) => [g, Math.round((v / w.n) * 100)])) });
  assert.deepEqual(me.tendency, { facing: pct(want.facing), open: pct(want.open) });
  // 外す
  await call(k, "api/spots/fav", { body: { id: ids[2], on: false } });
  assert.deepEqual((await call(k, "api/spots/mine")).body.favs, []);
  assert.equal((await call(null, "api/spots/mine")).status, 401);
});

test("お気に入りは良い問題1票と同じに数え、「次の問題」で先に出る", async (t) => {
  const { member, call } = await boot(t);
  const k = member("Kaina"), c = member("Croque"), m = member("Mio");
  const pass = async (who, id) => {
    const s = (await call(who, "api/spots/one?id=" + id)).body.spot.situation;
    return call(who, "api/spots/answer", { body: { id, action: isFacing(s) ? "fold" : "check", comment: "x" } });
  };
  // Kaina が2問答え、新しいほう（あとに出る問題）だけをお気に入りにする
  const a = (await call(k, "api/spots/next")).body.id;
  await pass(k, a);
  const b = (await call(k, "api/spots/next")).body.id;
  await pass(k, b);
  // Croque も2問とも答えて、答えの数をそろえる（並びは評価だけで決まるように）
  await pass(c, a);
  await pass(c, b);
  const f = await call(k, "api/spots/fav", { body: { id: b, on: true } });
  assert.deepEqual([f.body.fav, f.body.votes.favs], [1, 1], "答えたあとなら評価の数も返る");
  const L = (await call(m, "api/spots")).body.spots;
  assert.equal(L.find((s) => s.id == b).score, 1, "お気に入りが評価に入る");
  assert.equal(L.find((s) => s.id == a).score, 0);
  // 良い問題も付けると +2
  await call(k, "api/spots/vote", { body: { id: b, vote: 1 } });
  assert.equal((await call(m, "api/spots")).body.spots.find((s) => s.id == b).score, 2);
  // Mio の「次の問題」は、古い a より、評価の高い b が先
  assert.equal((await call(m, "api/spots/next")).body.id, b);
  // 答える前のお気に入りは数えない（「あとで答える」用）。答えたら数える
  assert.equal((await call(m, "api/spots/fav", { body: { id: a, on: true } })).body.fav, 1);
  assert.equal((await call(k, "api/spots")).body.spots.find((s) => s.id == a).score, 0, "答える前のお気に入り");
  await pass(m, a);
  assert.equal((await call(k, "api/spots")).body.spots.find((s) => s.id == a).score, 1, "答えたあとは数える");
  assert.equal((await call(k, "api/spots/one?id=" + a)).body.votes.favs, 1);
});
