const test = require("node:test");
const assert = require("node:assert");
const E = require("../engine.js");

// 札は 0〜51。ランク = c % 13（0 が 2、12 が A）、スート = c / 13 の整数部
const C = (s) => {
  const r = "23456789TJQKA".indexOf(s[0]), u = "shdc".indexOf(s[1]);
  return u * 13 + r;
};
const H = (s) => s.split(" ").map(C);
const cat = (s) => (E.best(H(s)) / 1e10) | 0;

test("役の判定", () => {
  assert.equal(cat("As Ks Qs Js Ts 2h 3d"), 8); // ストレートフラッシュ
  assert.equal(cat("9s 9h 9d 9c 2s 3h 4d"), 7); // フォーカード
  assert.equal(cat("9s 9h 9d 2c 2s 3h 4d"), 6); // フルハウス
  assert.equal(cat("2s 7s 9s Js Ks 3h 4d"), 5); // フラッシュ
  assert.equal(cat("As 2h 3d 4c 5s 9h Jd"), 4); // A から始まるストレート
  assert.equal(cat("9s 9h 9d 2c 5s 7h Jd"), 3);
  assert.equal(cat("9s 9h 2d 2c 5s 7h Jd"), 2);
  assert.equal(cat("9s 9h 3d 2c 5s 7h Jd"), 1);
  assert.equal(cat("9s Th 3d 2c 5s 7h Jd"), 0);
  // 同じ役ならキッカーで比べる
  assert.ok(E.best(H("As Ah Kd 2c 5s 7h 9d")) > E.best(H("As Ah Qd 2c 5s 7h 9d")));
  // ホイール（A-5）は 6-high ストレートより弱い
  assert.ok(E.best(H("As 2h 3d 4c 5s 9h Jd")) < E.best(H("2h 3d 4c 5s 6h 9h Jd")));
});

// CPUだけの卓を何ハンドも回し、チップが増えも減りもしないことを確かめる
test("1卓をCPUだけで回してもチップの合計は変わらない", () => {
  for (let run = 0; run < 20; run++) {
    const P = [...Array(5)].map((_, i) => ({ ...E.fromType(E.TY[i % E.TY.length]), id: i, name: "c" + i, oid: "c" + i, stack: 1e4, re: 0, alive: 1 }));
    const g = { P, lv: run % E.LV.length, entries: 40 };
    const T = { p: P.slice(), btn: -1 };
    g.tables = [T];
    for (let h = 0; h < 60 && T.p.filter((p) => p.stack > 0).length > 1; h++) {
      E.playHand(g, T);
      const sum = P.reduce((s, p) => s + p.stack, 0);
      assert.equal(sum, 5e4, `run ${run} hand ${h}`);
      P.forEach((p) => assert.ok(p.stack >= 0));
    }
  }
});

test("人間の番では hero を返し、行動を受け取る", () => {
  const P = [...Array(3)].map((_, i) => ({ ...E.fromType(E.TY[0]), id: i, name: "c" + i, oid: "c" + i, stack: 1e4, re: 0, alive: 1 }));
  P[0] = { id: 0, oid: "h0", name: "you", hero: 1, ty: ["—"], stack: 1e4, re: 0, alive: 1 };
  const g = { P, lv: 0, entries: 40 }, T = { p: P.slice(), btn: -1 };
  g.tables = [T];
  const log = [];
  const h = E.hand(g, T, (s) => log.push(s));
  let r = h.next(), asked = 0;
  while (!r.done) {
    if (r.value.k == "hero") {
      asked++;
      assert.equal(r.value.p, P[0]);
      assert.ok(r.value.c.toCall >= 0);
      r = h.next({ t: "f" });
    } else r = h.next();
  }
  assert.ok(asked >= 1);
  assert.match(log[0], /ハンド開始/);
});

test("ひとり用の大会を作る", () => {
  const m = new Map(), store = { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v) };
  const g = { dur: 6e4, lv: 0, entries: 40, lg: [], lvEnd: 0 };
  E.soloSetup(g, store);
  assert.equal(g.P.length, 40);
  assert.equal(g.tables.length, 8);
  assert.ok(g.tables.every((t) => t.p.length == 5));
  assert.ok(g.T.p.includes(g.hero));
  assert.equal(new Set(g.tables.flatMap((t) => t.p)).size, 40);
  // 記憶の保存と読み込み（大会をまたいで縮めて持ち越す）
  const k = g.P.find((p) => p.k);
  E.obs(k, g.hero).n = 10;
  E.saveMem(g, store);
  const q = { oid: k.oid };
  E.loadMem(q, store);
  assert.equal(q.mem.get("hero").n, 10 * 0.7);
});

test("時間が来たらレベルが上がる（最大レベルで止まる）", () => {
  const g = { lv: 0, dur: 100, lvEnd: 100 };
  E.advanceLevel(g, 350);
  assert.equal(g.lv, 3);
  assert.equal(g.lvEnd, 400);
  E.advanceLevel(g, 1e9);
  assert.equal(g.lv, E.LV.length - 1);
});
