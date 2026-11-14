// 大会の進行（room.js の createRoom）を、早送りの時計で最後まで回す
const test = require("node:test");
const assert = require("node:assert");
const { createRoom, ACT_MS } = require("../room.js");
const { fakeClock } = require("./helpers.js");

// 人間 nh 人＋観戦1人で大会を開き、人間役はランダムに打つ（放置・切断・戻るも混ぜる）
function play(nh, { afk = 0.05, leave = 0, back = 0.3, seed = 1 } = {}) {
  let s = seed * 2654435761 % 4294967296;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const clock = fakeClock();
  const ids = [...Array(nh)].map((_, i) => "p" + i).concat(["spec"]);
  const last = {}, gone = new Set(), problems = [];
  let msgs = 0;
  const room = createRoom({
    deliver: (id, m) => {
      msgs++;
      if (m.t == "view") last[id] = { v: m.v, fresh: 1 };
    },
    members: () => ids.filter((i) => !gone.has(i)),
    clock,
  });
  assert.ok(room.start(ids.slice(0, nh).map((id, i) => ({ id, name: "H" + i })), 1));
  const g = room.state();
  let wasWait = 0, rounds = 0, timeouts = 0, backs = 0;
  const check = () => {
    // 手札の漏れ：自分以外の、公開されていない手札が view に入っていないか
    for (const id of ids) {
      const L = last[id];
      if (!L || !L.fresh) continue;
      L.fresh = 0;
      const v = L.v, me = g.P.find((p) => p.pid == id), T = g.tables[v.ti];
      if (T) v.pl.forEach((p, i) => {
        const real = T.p.concat(T.gone || [])[i];
        if (p.h && real && real != me && !real.show) problems.push("leak " + real.name);
      });
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
  const r = play(8, { seed: 7, leave: 0.002 });
  assert.deepEqual(r.problems, []);
  assert.ok(r.gone.size > 0);
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
