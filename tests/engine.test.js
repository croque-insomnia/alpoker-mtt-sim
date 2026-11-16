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

// ---- ハンド履歴 ----
function soloWithHistory(n = 40) {
  const m = new Map(), store = { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v) };
  const g = { dur: 6e4, lv: 2, entries: 40, lg: [], lvEnd: 0, hist: [] };
  E.soloSetup(g, store);
  for (let i = 0; i < n && g.T.p.filter((p) => p.stack > 0).length > 1; i++) {
    E.playHand(g, g.T);
    E.bust(g, g.T);
  }
  return g;
}

test("ハンド履歴：人間が配られたハンドを、チップの出入りが合う形で残す", () => {
  const g = soloWithHistory();
  assert.ok(g.hist.length > 10);
  g.hist.forEach((H, k) => {
    assert.equal(H.n, k + 1);
    assert.ok(H.seats.some((s) => s.hero), "人間が配られている");
    const st = H.seats.reduce((a, s) => a + s.st, 0), end = H.seats.reduce((a, s) => a + s.end, 0);
    assert.equal(st, end, `#${H.n} 開始と終了のチップの合計`);
    assert.equal(H.win.reduce((a, w) => a + w.x, 0) > 0, true);
    assert.ok(H.acts.every((a) => H.seats[a.i] && "fkcbr".includes(a.a)));
    assert.ok([0, 3, 4, 5].includes(H.bd.length));
    H.acts.forEach((a) => assert.ok(a.s <= H.bd.length));
    assert.match(H.seats[0].pos, /^D/, "ボタンから順（ヘッズアップでは D SB）");
    if (H.sd.length) H.sd.forEach((x) => assert.equal(H.seats[x.i].shown, 1));
  });
  // 人間のいない卓のハンドは残さない
  const other = g.tables.find((t) => t != g.T);
  const before = g.hist.length;
  E.playHand(g, other);
  assert.equal(g.hist.length, before);
});

test("ハンド履歴：見せる相手に合わせて手札を隠す", () => {
  const g = soloWithHistory(20);
  const all = E.histView(g.hist, null);
  assert.ok(all.every((H) => H.seats.every((s) => s.h)), "絞らなければ全員の手札");
  const cpu = g.T.p.find((p) => !p.hero);
  const mine = E.histView(g.hist, cpu.oid);
  assert.ok(mine.length > 0 && mine.every((H) => H.seats.some((s) => s.oid == cpu.oid)));
  mine.forEach((H) =>
    H.seats.forEach((s) => {
      if (s.oid == cpu.oid || s.shown) assert.ok(s.h);
      else assert.equal(s.h, null);
    }),
  );
  // もとの記録は書き換えない
  assert.ok(g.hist.every((H) => H.seats.every((s) => s.h)));
  assert.equal(E.histView(g.hist, "nobody").length, 0);
});

test("ハンド履歴：テキストにできる", () => {
  const g = soloWithHistory(15);
  const t = E.histText(g.hist);
  assert.match(t, /^#1 {2}Lv3/);
  assert.match(t, /-- プリフロップ/);
  assert.match(t, /▶ .+ が [\d.]+BB 獲得/);
  assert.match(t, /\[[2-9TJQKA][♠♥♦♣] [2-9TJQKA][♠♥♦♣]\]/);
  assert.equal(t.split("\n\n").length, g.hist.length);
});

// ---- 再生のコマ（hands.html） ----
test("再生：どのコマでもチップの合計が変わらず、最後のコマは記録どおり。手札が表になるのは履歴で公開された席だけ", () => {
  let checked = 0, withShow = 0;
  for (let run = 0; run < 6; run++) {
    const g = soloWithHistory(80);
    for (const H of g.hist) {
      const fr = E.replayFrames(H), total = H.seats.reduce((a, s) => a + s.st, 0);
      assert.ok(fr.length >= 2);
      fr.forEach((f, j) => assert.equal(f.seats.reduce((a, s) => a + s.stack, 0) + f.pot, total, `#${H.n} コマ ${j}`));
      const last = fr[fr.length - 1];
      assert.deepEqual(last.seats.map((s) => s.stack), H.seats.map((s) => s.end));
      assert.equal(last.pot, 0);
      // 行動の数だけ「行動したコマ」がある
      assert.equal(fr.filter((f) => f.actor >= 0).length, H.acts.length);
      // 表になった席は、履歴で公開された席（降りていない）だけ
      H.seats.forEach((s, i) => {
        const opened = fr.some((f) => f.seats[i].open);
        if (opened) assert.ok(s.shown, `#${H.n} 席 ${i}`);
        if (s.shown && !last.seats[i].fold) assert.ok(last.seats[i].open, `#${H.n} 席 ${i} は最後には表`);
      });
      if (H.seats.some((s) => s.shown)) withShow++;
      // ボードは、ストリートの数だけ見える
      assert.ok(fr.every((f) => f.board.length === f.street));
      checked++;
    }
  }
  assert.ok(checked > 100 && withShow > 5);
});

test("1ハンドの見出し：増減・位置・自分から参加したか（分析器と同じ）", () => {
  const g = soloWithHistory(60);
  for (const H of g.hist) {
    const x = E.handInfo(H, "hero"), s = H.seats.find((q) => q.oid === "hero");
    assert.equal(x.net, (s.end - s.st) / H.bb);
    assert.equal(x.pos, E.posName(x.i, H.seats.length));
    assert.equal(x.vp, !!(E.analyze([H], (q) => q.oid === "hero").all.vpip || 0));
  }
  assert.equal(E.handInfo(g.hist[0], "nobody"), null);
});
