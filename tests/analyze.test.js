// 段階3c：分析器（ハンド履歴から傾向を数え直す）。遊びながら数えたもの（track）と一致するか
const test = require("node:test");
const assert = require("node:assert");
const E = require("../engine.js");
const { openDb } = require("../server/db.js");
const { openRecords } = require("../server/records.js");
const { createRoom } = require("../room.js");
const { fakeClock } = require("./helpers.js");

const KEYS = Object.keys(E.REC_KEYS);
const same = (a, b, msg) => {
  for (const k of KEYS) assert.ok(Math.abs((a[k] || 0) - (b[k] || 0)) < 1e-9, `${msg} ${k}: analyze ${a[k] || 0} / track ${b[k] || 0}`);
};
const mem = () => {
  const m = new Map();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v) };
};

test("卓の全員（CPU も）について、履歴から数えたものと遊びながら数えたものが一致する", () => {
  let hands = 0;
  for (let run = 0; run < 12; run++) {
    const g = { dur: 6e4, lv: run, entries: 40, lg: [], lvEnd: 0, hist: [] };
    E.soloSetup(g, mem());
    g.T.p.forEach((p) => (p.rec = [{}]));
    for (let i = 0; i < 60; i++) {
      g.T.p.forEach((p) => p.stack <= 0 && (p.stack = 3000 + ((i * 7919 + run * 104729) % 30000)));
      E.playHand(g, g.T);
    }
    hands += g.hist.length;
    for (const p of g.T.p) same(E.analyze(g.hist, (s) => s.oid === p.oid).all, p.rec[0], `run ${run} ${p.name}`);
  }
  assert.ok(hands >= 600);
});

test("位置別・深さ別：合計がハンド数と一致し、位置の名前はボタンから順", () => {
  const g = { dur: 6e4, lv: 3, entries: 40, lg: [], lvEnd: 0, hist: [] };
  E.soloSetup(g, mem());
  for (let i = 0; i < 100; i++) {
    g.T.p.forEach((p) => p.stack <= 0 && (p.stack = 1e4));
    E.playHand(g, g.T);
  }
  const r = E.analyze(g.hist, (s) => s.oid === "hero");
  const sum = (o) => Object.values(o).reduce((s, x) => s + x.hands, 0);
  assert.equal(sum(r.pos), r.all.hands);
  assert.equal(sum(r.depth), r.all.hands);
  assert.ok(Object.keys(r.pos).every((k) => E.posName.length && ["D", "SB", "BB", "UTG", "CO"].includes(k)));
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => E.posName(i, 5)), ["D", "SB", "BB", "UTG", "CO"]);
  assert.deepEqual([0, 1, 2, 3].map((i) => E.posName(i, 4)), ["D", "SB", "BB", "CO"]);
  assert.deepEqual([0, 1, 2].map((i) => E.posName(i, 3)), ["D", "SB", "BB"]);
  assert.deepEqual([0, 1].map((i) => E.posName(i, 2)), ["SB", "BB"]);
  // 画面に出す行
  const rows = E.analyzeRows(r.all);
  assert.equal(rows.length, E.ME_ROWS.length);
  const v = rows.find((x) => x.key == "vpip/hands");
  assert.equal(v.value, (r.all.vpip || 0) / r.all.hands);
  assert.equal(E.analyzeRows({}).every((x) => x.value === null), true, "記録がなければ null");
});

// みんなで遊ぶ：DB に入ったハンドから数えた傾向と、参加者の記録（track）が一致する。離席したハンドは数えない
function playRoom(records, { away = null } = {}) {
  const clock = fakeClock(), last = {}, ids = ["a", "b"];
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
  room.start([{ id: "a", name: "A", uid: "uA" }, { id: "b", name: "B", uid: "uB" }], 1);
  const g = room.state();
  let n = 0, wentAway = false;
  while (n++ < 5e5 && !g.over && clock.step()) {
    for (const id of ids) {
      const v = last[id];
      if (!v) continue;
      if (v.req && !v._done) {
        if (!(id === away && !wentAway && g.hist.length >= 6)) v._done = 1;
        // away の人は、数ハンド目で一度、離席になるまで放置する（他の卓が進むと画面データが届き直すので、離席になるまで答えない）
        if (id === away && !wentAway && g.hist.length >= 6) {
          if (!g.P.find((p) => p.pid === id).away) continue;
          wentAway = true;
        }
        room.msg(id, { t: "act", a: { t: v.req.toCall > v.req.stack / 2 ? "f" : "c" } });
      } else if (v.away && !v._back) (v._back = 1), room.msg(id, { t: "back" });
      else if (v.ask && !v._re) (v._re = 1), room.msg(id, { t: "re", y: true });
    }
  }
  return { g, tid };
}

test("みんなで遊ぶ：DB のハンドから数えた傾向が、参加者の記録と一致する", () => {
  const db = openDb(":memory:"), records = openRecords(db);
  const { g } = playRoom(records);
  assert.ok(g.over);
  for (const p of g.P.filter((x) => x.hero)) {
    const r = records.analyzeUser(p.uid);
    same(r.mp.all, p.rec[0], p.name);
    same(r.all.all, p.rec[0], p.name + "（合算）");
    assert.equal(r.solo.all.hands || 0, 0);
    assert.ok(r.all.all.hands > 0);
  }
});

test("離席が混ざったハンドは数えない（履歴の席に auto が付く）", () => {
  const db = openDb(":memory:"), records = openRecords(db);
  const { g } = playRoom(records, { away: "a" });
  const a = g.P.find((p) => p.uid === "uA");
  const autoHands = g.hist.filter((H) => H.seats.some((s) => s.oid === a.oid && s.auto)).length,
    dealt = g.hist.filter((H) => H.seats.some((s) => s.oid === a.oid)).length;
  assert.ok(autoHands >= 1, "放置したハンドに印が付く");
  assert.equal(records.analyzeUser("uA").all.all.hands, dealt - autoHands);
  // 放置しなかった人は、これまでどおり一致
  const b = g.P.find((p) => p.uid === "uB");
  same(records.analyzeUser("uB").all.all, b.rec[0], "B");
});

test("ひとり用と合わせて見る・分けて見る", () => {
  const db = openDb(":memory:"), records = openRecords(db);
  const { g } = playRoom(records);
  // uA のひとり用の大会を1つ入れる（あなたの席に uA）
  const s = { dur: 6e4, lv: 2, entries: 40, lg: [], lvEnd: 0, hist: [] };
  E.soloSetup(s, mem());
  s.hero.rec = [{}];
  for (let i = 0; i < 30 && s.T.p.filter((p) => p.stack > 0).length > 1; i++) {
    E.playHand(s, s.T);
    E.bust(s, s.T);
  }
  const hands = s.hist.map((H) => ({ ...H, seats: H.seats.map((x) => ({ ...x, uid: x.hero ? "uA" : null })) }));
  records.solo({ id: "uA", name: "A" }, { key: "k".repeat(20), hands, stats: s.hero.rec[0], entries: 40, re: 0 });
  const r = records.analyzeUser("uA");
  same(r.solo.all, s.hero.rec[0], "ひとり用");
  for (const k of KEYS) assert.ok(Math.abs((r.all.all[k] || 0) - ((r.mp.all[k] || 0) + (r.solo.all[k] || 0))) < 1e-9, "合算 = 対人 + 対CPU: " + k);
  assert.equal(r.hands, records.handsOf("uA").length);
  assert.equal(records.handsOf("uA", { source: "solo" }).length, hands.length);
  assert.ok(g.over);
});
