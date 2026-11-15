// 大会の進行（room.js の createRoom）を、早送りの時計で最後まで回す
const test = require("node:test");
const assert = require("node:assert");
const { createRoom, ACT_MS } = require("../room.js");
const { fakeClock } = require("./helpers.js");

// 人間 nh 人＋観戦1人で大会を開き、人間役はランダムに打つ（放置・切断・戻るも混ぜる）
// drop: 最初のハンドのあとで必ず切断させる人（偶然に頼らず、切断の場面を必ず通すため）
function play(nh, { afk = 0.05, leave = 0, back = 0.3, seed = 1, drop = [] } = {}) {
  let s = seed * 2654435761 % 4294967296;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const clock = fakeClock();
  const ids = [...Array(nh)].map((_, i) => "p" + i).concat(["spec"]);
  const last = {}, gone = new Set(), problems = [];
  let msgs = 0;
  const room = createRoom({
    deliver: (id, m) => {
      msgs++;
      if (m.t != "view") return;
      last[id] = { v: m.v, fresh: 1 };
      // 手札の漏れ：自分以外の、公開されていない手札が view に入っていないか。
      // 送った瞬間の状態と照らし合わせる（あとで照らすと、卓の並べ替えなどで席の順がずれて、漏れと見誤る）
      const g0 = room.state(), me = g0.P.find((p) => p.pid == id), T = g0.tables[m.v.ti];
      if (T)
        m.v.pl.forEach((p, i) => {
          const real = T.p.concat(T.gone || [])[i];
          if (real && p.name != real.name) problems.push("seat order " + id);
          if (p.h && real && real != me && !real.show) problems.push("leak " + real.name);
        });
    },
    members: () => ids.filter((i) => !gone.has(i)),
    clock,
  });
  assert.ok(room.start(ids.slice(0, nh).map((id, i) => ({ id, name: "H" + i })), 1));
  const g = room.state();
  let wasWait = 0, rounds = 0, timeouts = 0, backs = 0;
  const check = () => {
    for (const id of ids) {
      const L = last[id];
      if (!L || !L.fresh) continue;
      L.fresh = 0;
      const v = L.v;
      if (gone.has(id)) continue;
      if (v.req) {
        if (rnd() < afk) { timeouts++; continue; } // 放置
        const k = rnd();
        const a = k < 0.2 ? { t: "f" } : k < 0.7 ? { t: "c" } : { t: "r", x: v.req.cur + v.req.minR + Math.floor(v.req.stack * rnd() * rnd()) };
        room.msg(id, { t: "act", a });
      } else if (v.away && rnd() < back) { backs++; room.msg(id, { t: "back" }); }
      else if (v.ask) room.msg(id, { t: "re", y: rnd() < 0.7 });
      else if (v.spec && rnd() < 0.05) room.msg(id, { t: "watch", i: (rnd() * 10) | 0 });
      if (id != "spec" && rnd() < leave) { gone.add(id); room.left(id); }
    }
    if (g.wait && !wasWait) {
      rounds++;
      if (rounds == 1)
        for (const id of drop) {
          gone.add(id);
          room.left(id);
        }
      // チップの合計は「エントリー数 × 開始スタック」のまま
      const tot = g.P.reduce((a, p) => a + (p.alive ? p.stack : 0), 0);
      if (tot != g.entries * 1e4) problems.push(`chips ${tot} != ${g.entries * 1e4} (round ${rounds})`);
      if (g.tables.some((t) => t.p.length > 5)) problems.push("table over 5");
    }
    wasWait = g.wait;
  };
  check();
  // 全員が切断して戻らないと大会が終わらない（自動のチェック/フォールドだけになる）ので、そこで止める
  clock.run(2e5, () => {
    check();
    if (g.over || !g.P.some((p) => p.hero && p.alive && !gone.has(p.pid))) clock.run = () => 0;
  });
  return { g, problems, rounds, msgs, timeouts, backs, gone };
}

for (const nh of [1, 3, 8, 20, 40]) {
  test(`人間${nh}人の大会が最後まで進み、チップも手札も正しい`, () => {
    const r = play(nh, { seed: nh });
    assert.deepEqual(r.problems, []);
    assert.ok(r.g.over, "大会が終わる");
    assert.ok(r.rounds > 0);
    const places = r.g.P.filter((p) => p.hero).map((p) => p.place);
    assert.ok(places.every((x) => x >= 1 && x <= r.g.entries), String(places));
  });
}

test("切断する人がいても進む", () => {
  const r = play(8, { seed: 7, leave: 0.002, drop: ["p1", "p2"] });
  assert.deepEqual(r.problems, []);
  assert.ok(r.gone.has("p1") && r.gone.has("p2"));
  assert.ok(r.g.over || !r.g.P.some((p) => p.hero && p.alive && !r.gone.has(p.pid)), "最後まで進む");
});

test("時間切れで離席扱いになり、戻るで解ける", () => {
  const clock = fakeClock();
  const last = {};
  const room = createRoom({ deliver: (id, m) => m.t == "view" && (last[id] = m.v), members: () => ["a"], clock });
  room.start([{ id: "a", name: "A" }], 5);
  // a の番が来るまで進める
  while (!(last.a && last.a.req)) assert.ok(clock.step());
  const g = room.state(), me = g.P.find((p) => p.pid == "a");
  assert.ok(!me.away);
  clock.advance(ACT_MS);
  while (!me.away) assert.ok(clock.step());
  assert.equal(room.view("a").away, me.alive ? 1 : 0);
  room.msg("a", { t: "back" });
  assert.equal(me.away, 0);
});

test("入り直した人は同じ席に戻る", () => {
  const clock = fakeClock();
  const room = createRoom({ deliver: () => {}, members: () => ["a", "b"], clock });
  room.start([{ id: "a", name: "A" }, { id: "b", name: "B" }], 5);
  const g = room.state(), a = g.P.find((p) => p.pid == "a");
  room.left("a");
  assert.equal(a.away, 1);
  room.rejoin("a", "a2");
  assert.equal(a.pid, "a2");
  assert.equal(a.away, 0);
  assert.equal(room.view("a2").spec, 0);
});

test("他の人の番に送った行動は無視される", () => {
  const clock = fakeClock();
  const last = {};
  const room = createRoom({ deliver: (id, m) => m.t == "view" && (last[id] = m.v), members: () => ["a", "b"], clock });
  room.start([{ id: "a", name: "A" }, { id: "b", name: "B" }], 5);
  while (!(last.a && last.a.req) && !(last.b && last.b.req)) assert.ok(clock.step());
  const turn = last.a && last.a.req ? "a" : "b", other = turn == "a" ? "b" : "a";
  const g = room.state(), t = g.tables.find((t) => t.req);
  room.msg(other, { t: "act", a: { t: "f" } });
  assert.ok(t.req && t.req.p.pid == turn, "番は動かない");
});

test("ハンド履歴：大会中は自分のハンドだけ、終わったら全員の手札つき", () => {
  const clock = fakeClock();
  const got = {}, last = {};
  const room = createRoom({
    deliver: (id, m) => {
      if (m.t == "view") last[id] = m.v;
      if (m.t == "hands") got[id] = m;
    },
    members: () => ["a", "b", "w"],
    clock,
  });
  room.start([{ id: "a", name: "A" }, { id: "b", name: "B" }], 1);
  const g = room.state();
  const act = () => {
    for (const id of ["a", "b"]) if (last[id] && last[id].req) room.msg(id, { t: "act", a: { t: "c" } });
  };
  // 数ハンド進めて、大会中の履歴を頼む
  while (g.hist.length < 3 && !g.over) {
    assert.ok(clock.step());
    act();
  }
  assert.ok(!g.over && g.hist.length > 0);
  room.msg("a", { t: "hands" });
  room.msg("w", { t: "hands" });
  const a = g.P.find((p) => p.pid == "a");
  assert.equal(got.a.over, 0);
  assert.ok(got.a.h.length > 0 && got.a.h.every((H) => H.seats.some((s) => s.oid == a.oid)));
  got.a.h.forEach((H) => H.seats.forEach((s) => s.oid != a.oid && !s.shown && assert.equal(s.h, null)));
  assert.deepEqual(got.w.h, [], "観戦者には大会中は何も送らない");
  // 続けて頼んでも、すぐには送らない
  delete got.a;
  room.msg("a", { t: "hands" });
  assert.deepEqual(got.a, { t: "hands", busy: 1 }, "中身は送らず、待つように知らせる");
  // 最後まで進めると、全ハンドを全員の手札つきで送る
  clock.run(1e6, act);
  assert.ok(g.over);
  clock.advance(3000);
  room.msg("w", { t: "hands" });
  assert.equal(got.w.over, 1);
  assert.equal(got.w.h.length, g.hist.length);
  assert.ok(got.w.h.every((H) => H.seats.every((s) => s.h)));
});

test("大会が終わったら onOver が呼ばれる", () => {
  const clock = fakeClock();
  let over = null;
  const last = {};
  const room = createRoom({ deliver: (id, m) => m.t == "view" && (last[id] = m.v), members: () => ["a"], clock, onOver: (g) => (over = g) });
  room.start([{ id: "a", name: "A" }], 1);
  clock.run(1e6, () => last.a && last.a.req && room.msg("a", { t: "act", a: { t: "c" } }));
  assert.ok(over && over.over && over.hist.length > 0);
});

test("打ち方の記録：離席中の自動の行動は数えない", () => {
  const clock = fakeClock();
  const last = {};
  const room = createRoom({ deliver: (id, m) => m.t == "view" && (last[id] = m.v), members: () => ["a", "b"], clock });
  room.start([{ id: "a", name: "A" }, { id: "b", name: "B" }], 1);
  const g = room.state();
  room.left("b"); // b は最初から離席（全部、自動のチェック/フォールド）
  clock.run(1e6, () => last.a && last.a.req && room.msg("a", { t: "act", a: { t: "c" } }));
  const [a, b] = ["a", "b"].map((id) => g.P.find((p) => p.name == id.toUpperCase()));
  assert.ok(a.rec[0].hands > 0, "席にいた人は数える");
  assert.equal(b.rec[0].hands || 0, 0, "離席中のハンドは数えない");
  assert.ok(g.hist.every((H) => H.seats.every((s) => s.uid === null)), "アカウントでない席の uid は null");
});
