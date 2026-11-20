// spots.js — スポット（同じ場面に、みんながどう打つか）。プリフロップの問題を作り、回答を集めて並べる
// 問題は多めに用意し、各自が好きなだけ答える（全員に回答は求めない）。同じ問題に答えが集まるよう、
// 「次の問題」は、他の人が答えた問題を優先して出し、答えていないものがなくなったら新しく作る
// 回答は1人1回。答えるとすぐ結果（それまでに答えた人の選択とコメント）が見える。結果を見たあとは直せない
//   GET  api/spots            … 問題の一覧（自分が答えたか・答えた人数）
//   GET  api/spots/next       … 次に答える問題の ID（なければ作る）
//   GET  api/spots/one?id=    … 1問。答えていれば、全員の回答もつける
//   POST api/spots/answer     … 回答 { id, action: fold|call|raise|allin, size, comment }
"use strict";
const crypto = require("crypto");
const E = require("../engine.js");

// ---- 問題を作る（プリフロップ・5-Max） ----
// 判断が割れる場面だけを出す（自明な AA・72o などは出さない）
const STACKS = [10, 13, 16, 20, 25];
// 席は 5-Max のアクション順（UTG → CO → BTN → SB → BB）
const ORDER = ["UTG", "CO", "BTN", "SB", "BB"];
const ANTE = 0.2; // 1人あたり（5人で 1BB。BB アンティと同じ量）
// 採る手（境界付近）
const RANKS = "23456789TJQKA";
const HAND_POOL = (() => {
  const out = [];
  for (const r of "23456789TJ") out.push(r + r); // 22〜JJ
  for (const r of "23456789") out.push("A" + r + "s"); // A2s〜A9s
  for (const r of "23456789TJ") out.push("A" + r + "o"); // A2o〜AJo
  out.push("KQo", "KJo", "QJo", "KTs", "QTs", "JTs");
  for (const [a, b] of [["5", "4"], ["6", "5"], ["7", "6"], ["8", "7"], ["9", "8"], ["T", "9"]]) out.push(a + b + "s"); // 54s〜T9s
  return out;
})();
// シナリオ：open（自分より前が全員降りた）/ vsopen（前の人のオープンに対応）/ vs3bet（自分のオープンに 3bet が返ってきた）
// 成り立たない組み合わせは作らない：BB はオープンしない（全員降りたら BB の勝ちで終わる）。10BB の 3bet への対応は、ほぼオールインの判断なので出さない
// BTN は、出題する側（自分）にはしない（設計書の方針。相手としては出る）
// （5-Max のとき。卓の人数が減ったときは heroPosOf で決める）
const HERO_POS = { open: ["UTG", "CO", "SB"], vsopen: ["CO", "SB", "BB"], vs3bet: ["UTG", "CO", "SB"] };
const SCENARIOS = ["open", "vsopen", "vs3bet"];

// カードの番号（engine.js と同じ：スート = c / 13、ランク = c % 13）
const cardOf = (rank, suit) => suit * 13 + RANKS.indexOf(rank);
// "A5s" → 具体的な2枚（スートはランダム）
function dealHand(cls, R) {
  const s1 = Math.floor(R() * 4);
  if (cls.length == 2) {
    let s2 = Math.floor(R() * 3);
    if (s2 >= s1) s2++;
    return [cardOf(cls[0], s1), cardOf(cls[1], s2)];
  }
  if (cls[2] == "s") return [cardOf(cls[0], s1), cardOf(cls[1], s1)];
  let s2 = Math.floor(R() * 3);
  if (s2 >= s1) s2++;
  return [cardOf(cls[0], s1), cardOf(cls[1], s2)];
}
const r1 = (x) => Math.round(x * 10) / 10;
// 大会の状況：40人エントリー（開始 10000点）、入賞は上位 20%（8人）。残りは 2〜30人
// バブル付近（残り 9〜11人）・入賞圏内・最終卓（残り5人以下）も出す。そこでは CPU も入賞を意識した判断になる（engine.js の ai2）
// 残り4人以下では、卓の人数もそれに合わせて減る（4人・3人・ヘッズアップ）
const ENTRIES = 40, ITM = Math.floor(ENTRIES * 0.2);
const leftOf = (R) => 2 + Math.floor(R() * 29);
// n 人卓の席（アクション順）。ヘッズアップは SB がボタンで、プリフロップは SB から
const orderOf = (n) => ORDER.slice(ORDER.length - Math.min(5, n));
// 出題する自分の席：open は BB 以外（全員降りたら BB の勝ち）、vsopen は前に誰かいる席、vs3bet は後ろに誰かいる席。BTN は出さない（企画書の方針）
function heroPosOf(scenario, ord) {
  return ord.filter((pos, i) => pos != "BTN" && (scenario == "open" ? pos != "BB" : scenario == "vsopen" ? i > 0 : i < ord.length - 1));
}
const pick = (a, R) => a[Math.floor(R() * a.length)];

// 1問作る。R: 0〜1 の乱数。戻り値は situation（spots.situation に入る形）
// 席の stack_bb は配札前の持ち点（アンティ・ブラインドを払う前）。actions は自分の番までの流れ
function makePreflop(R = Math.random, want = {}) {
  // 残り人数を先に決める（4人以下なら卓の人数も減る）。席を指定されたときは 5-Max（残り5人以上）にする
  const left = want.pos ? 5 + Math.floor(R() * 26) : leftOf(R),
    ORD = orderOf(left);
  const scenario = want.scenario || pick(SCENARIOS, R);
  const heroPos = want.pos || pick(heroPosOf(scenario, ORD), R);
  const stack = want.stack || pick(scenario == "vs3bet" ? STACKS.filter((s) => s > 10) : STACKS, R);
  const cls = want.hand || pick(HAND_POOL, R);
  const hi = ORD.indexOf(heroPos);
  // 相手の持ち点：自分の 0.6〜1.6 倍（実戦らしくばらす）。0.1 刻み
  const seats = ORD.map((pos) => ({ pos, stack_bb: pos == heroPos ? stack : r1(Math.max(4, stack * (0.6 + R()))) }));
  const actions = [];
  const blind = (pos) => (pos == "SB" ? 0.5 : pos == "BB" ? 1 : 0);
  let opener = null, threebettor = null, openTo = 0, threeTo = 0;
  if (scenario == "open") {
    for (let i = 0; i < hi; i++) actions.push({ pos: ORD[i], action: "fold" });
  } else if (scenario == "vsopen") {
    // 自分より前の誰かがオープン。その間と後ろの人は降りる
    const oi = Math.floor(R() * hi);
    opener = ORD[oi];
    openTo = pick(opener == "SB" ? [2.5, 3] : [2, 2.2, 2.5], R);
    // オープンした人は、オールインにならない程度の持ち点にする（オープン額の 4 倍以上）
    if (seats[oi].stack_bb < openTo * 4) seats[oi].stack_bb = r1(openTo * (4 + 2 * R()));
    for (let i = 0; i < hi; i++) actions.push(i == oi ? { pos: ORD[i], action: "raise", to_bb: openTo } : { pos: ORD[i], action: "fold" });
  } else {
    // 自分がオープンし、後ろの誰かが 3bet。ほかは降りる
    openTo = heroPos == "SB" ? 3 : pick([2, 2.2], R);
    const ti = hi + 1 + Math.floor(R() * (ORD.length - hi - 1));
    threebettor = ORD[ti];
    for (let i = 0; i < hi; i++) actions.push({ pos: ORD[i], action: "fold" });
    actions.push({ pos: heroPos, action: "raise", to_bb: openTo });
    // 3bet の額：後ろから（インポジション）3倍、ブラインドから 3.5〜4倍。持ち点を超えるならオールイン
    threeTo = r1(openTo * (threebettor == "SB" || threebettor == "BB" ? (heroPos == "SB" ? 3 : 3.8) : 3));
    const ts = seats[ti];
    // 3bet する人は、オールインにならない程度の持ち点にする（3bet 額の 1.6 倍以上）
    if (ts.stack_bb < threeTo * 1.6) ts.stack_bb = r1(threeTo * (1.6 + R()));
    for (let i = hi + 1; i < ORD.length; i++) actions.push(i == ti ? { pos: ORD[i], action: "raise", to_bb: threeTo } : { pos: ORD[i], action: "fold" });
  }
  // 自分が今、場に出している額と、コールに要る額
  const heroIn = scenario == "vs3bet" ? openTo : blind(heroPos);
  const facing = scenario == "open" ? Math.max(1, blind(heroPos)) : scenario == "vsopen" ? openTo : threeTo;
  const heroStack = stack - ANTE; // アンティを払ったあとの、この手に使える額（場に出した額を含む）
  const toCall = r1(Math.min(facing, heroStack) - heroIn);
  // レイズできる最小の額（今のベット + 直前の上げ幅）。オールイン以上になるなら、レイズはなし（オールインだけ）
  const lastInc = scenario == "open" ? 1 : scenario == "vsopen" ? openTo - 1 : threeTo - openTo;
  const minRaise = r1(facing + lastInc);
  // ポット（場に出たもの全部：アンティ・ブラインド・レイズ）
  const put = {};
  for (const s of seats) put[s.pos] = Math.min(blind(s.pos), s.stack_bb - ANTE);
  for (const a of actions) if (a.action == "raise") put[a.pos] = a.to_bb;
  const pot = r1(ANTE * seats.length + Object.values(put).reduce((x, y) => x + y, 0));
  return {
    kind: "preflop",
    scenario,
    table_size: ORD.length,
    ante_bb: ANTE,
    hero: { position: heroPos, stack_bb: stack, hand: dealHand(cls, R), cls },
    seats,
    actions,
    facing_bb: facing, // 今のベット額（この額にそろえればコール）
    facing: toCall > 0 ? 1 : 0, // ベットを受けているか
    to_call_bb: toCall,
    in_bb: heroIn, // 自分がもう出している額
    min_raise_bb: minRaise,
    max_bb: r1(heroStack), // オールインの額（この手に使える全部）
    pot_bb: pot,
    ...preflopTour(R, left, seats),
  };
}
// プリフロップの問題の大会の状況：残り人数を決め、そのときの平均の持ち点（BB）が 12〜40BB になるレベルを選ぶ
// 残り5人以下なら全員がこの卓にいるので、平均はこの卓の持ち点から出す
function preflopTour(R, left, seats) {
  if (left <= 5) return { players_left: left, entries: ENTRIES, itm: ITM, avg_bb: r1(seats.reduce((x, s) => x + s.stack_bb, 0) / seats.length) };
  const avgChips = (ENTRIES * 10000) / left;
  const fits = E.LV.map(([, bb]) => avgChips / bb).filter((x) => x >= 12 && x <= 40);
  const avg = fits.length ? fits[Math.floor(R() * fits.length)] : avgChips / E.LV[E.LV.length - 1][1];
  return { players_left: left, entries: ENTRIES, itm: ITM, avg_bb: r1(avg) };
}
// ---- ポストフロップ（自動）：ゲームと同じ CPU で1ハンドを進め、あなたの番で止めて写す ----
// 乱数はシード1つから作る（配札・席順・CPU の個人差と行動のすべて）。同じシードなら、いつ作っても同じ場面になる
// あなたの手前の行動（プリフロップなど）も、あなたの席に「バランス」タイプの CPU の判断をさせて進める
const STREET = { 0: "preflop", 3: "flop", 4: "turn", 5: "river" };
// プリフロップでリンプ（だれもレイズしていないうちに、BB 以外がコールして入る）があったか
// ゲームの CPU は、入るときに3〜4回に1回リンプするので、そのまま写すとリンプの場面が多すぎる（実戦ではまれ）。そういう場面は出さない
// ただし、SB が BB と2人きり（前の全員が降りた）で揃えるのは、実戦でもよくあるので残す
// actions: 問題の形（{ street, pos, action }）、n: 卓の人数（SB より前の n−2 人が全員降りていれば、SB と BB の2人きり）
function hasLimp(actions, n = 5) {
  let folded = 0;
  for (const a of actions || []) {
    if (a.street != "preflop") break;
    if (a.action == "raise" || a.action == "bet") return false; // ここから先はレイズのあと
    if (a.action == "call" && a.pos != "BB" && !(a.pos == "SB" && folded == n - 2)) return true;
    if (a.action == "fold") folded++;
  }
  return false;
}
const ACT_OF = { f: "fold", k: "check", c: "call", b: "bet", r: "raise" };
function makePostflop(seed) {
  const R = E.seeded(seed);
  return E.withRandom(R, () => {
    const lv = Math.floor(R() * 6), // レベル 1〜6（アンティの重さが変わる）
      [, bb] = E.LV[lv];
    // 止めるストリート：フロップ 45%・ターン 35%・リバー 20%
    const u = R(),
      target = u < 0.45 ? 3 : u < 0.8 ? 4 : 5;
    const depth = (lo, hi) => Math.round((lo + R() * (hi - lo)) * bb);
    // 残り人数（4人以下なら、卓の人数もそれに合わせる）
    const left = leftOf(R),
      seatsN = Math.min(5, left);
    const P = [];
    const bal = E.TY.find((t) => t.name == "バランス");
    P.push({ ...E.fromType(bal), id: 0, oid: "hero", name: "あなた", hero: 1, stack: depth(12, 40), alive: 1 });
    for (let i = 1; i < seatsN; i++) P.push({ ...E.fromType(E.TYC[Math.floor(R() * E.TYC.length)]), id: i, oid: "c" + i, name: "c" + i, stack: depth(8, 50), alive: 1 });
    const T = { p: E.shf(P.slice()), btn: -1 };
    // 大会の途中（40人エントリー・入賞は8人、残り 5〜30人）として CPU に判断させる（バブル付近・最終卓では、それらしい動きになる）
    // ほかの卓の人にも持ち点を持たせて、平均の持ち点を出す
    const rest = Array.from({ length: left - P.length }, (_, i) => ({ id: 100 + i, alive: 1, stack: depth(8, 50) }));
    const g = { P: P.concat(rest), tables: [T], lv, entries: ENTRIES, hist: [] };
    const tour = { players_left: left, entries: ENTRIES, itm: ITM, avg_bb: r1(g.P.reduce((x, p) => x + p.stack, 0) / left / bb) };
    const h = E.hand(g, T);
    for (let r = h.next(); !r.done; ) {
      const v = r.value;
      if (v.k != "hero") {
        r = h.next();
        continue;
      }
      if (v.c.board.length == target) {
        // ベットを受けていない場面（チェックで回ってきた・先に打つ）は多く出がちなので、半分は捨てて次のシードへ
        // （この判断もシードの乱数で決めるので、同じシードなら同じ結果）
        // 自分のドンク（前のストリートで自分以外がベット・レイズし、その人がまだこのストリートで動いていないのに、先に打つかどうか）は、
        // 実戦ではまれ（チェックがふつう）なので、5% だけ残す（ポストフロップの問題のうち約1.5%になる）
        if (!(v.c.toCall > 0) && isDonk(v, T) && R() >= 0.05) return null;
        if (!(v.c.toCall > 0) && R() < 0.5) return null;
        // 人数の少ない卓は、あなたがフロップ以降まで残りやすく、そのままだと多く出すぎる（ヘッズアップは5人卓の約7倍）。
        // 残り人数どおりの割合になるよう間引く
        if (seatsN == 2 ? R() >= 0.15 : seatsN == 3 ? R() >= 0.5 : false) return null;
        const s = snapPostflop(v, T, bb, seed);
        if (s) Object.assign(s, tour);
        return s && !hasLimp(s.actions, s.table_size) ? s : null; // リンプのあった場面は、次のシードへ
      }
      if (v.c.board.length > target) return null;
      r = h.next(E.ai2(v.p, v.c));
    }
    return null; // あなたが途中で降りた・ハンドが終わった
  });
}
// 自分のドンクの場面か：前のストリートの最後のベット・レイズが自分以外で、その人がまだこのストリートで動いていない
function isDonk(v, T) {
  const st = v.c.board.length, prev = st == 3 ? 0 : st - 1, acts = v.H.acts, hi = T.ps.indexOf(v.p);
  let agg = -1;
  for (const a of acts) if (a.s == prev && (a.a == "b" || a.a == "r")) agg = a.i;
  return agg >= 0 && agg != hi && !T.ps[agg].fold && !acts.some((a) => a.s == st && a.i == agg);
}
// あなたの番の場面を、問題の形にする。判断が自明な場面（何もない手でベットを受けている、など）は null
function snapPostflop(v, T, bb, seed) {
  const { p, c, H } = v,
    ps = T.ps,
    n = ps.length,
    B = c.board.slice();
  const f = (x) => r1(x / bb);
  const facing = c.cur,
    toCall = Math.min(c.toCall, p.stack);
  // 降りるかどうかが自明な場面は出さない：ベットを受けていて、ワンペアもドローもない
  if (toCall > 0 && E.tier(p.h, B) < 1 && !E.draw(p.h, B)) return null;
  if (!p.stack || ps.filter((q) => !q.fold).length < 2) return null;
  const posOf = (i) => {
    const x = E.posName(i, n);
    return x == "D" ? "BTN" : x;
  };
  const hi = ps.indexOf(p);
  const seats = ps.map((q, i) => ({
    pos: posOf(i),
    stack_bb: f(H.seats[i].st), // 配札前の持ち点
    now_bb: f(q.stack), // 今の持ち点
    bet_bb: f(q.bet), // このストリートで出している額
    fold: q.fold ? 1 : 0,
    allin: q.allin ? 1 : 0,
  }));
  const actions = H.acts.map((a) => ({ street: STREET[a.s], pos: posOf(a.i), action: ACT_OF[a.a], to_bb: f(a.to), allin: a.ai ? 1 : 0 }));
  const pot = ps.reduce((t, q) => t + q.tot, 0);
  return {
    kind: "postflop",
    scenario: "postflop",
    seed,
    street: STREET[B.length],
    table_size: n,
    ante_bb: f(H.an),
    board: B,
    hero: { position: posOf(hi), stack_bb: f(H.seats[hi].st), hand: p.h.slice(), cls: E.hcls(p.h) },
    seats,
    actions,
    facing_bb: f(facing),
    // ベットを受けているか（丸める前の額で決める。ごく小さな上乗せでも to_call_bb が 0 に丸まるため）
    facing: toCall > 0 ? 1 : 0,
    to_call_bb: f(toCall),
    in_bb: f(p.bet),
    min_raise_bb: f(facing + c.minR),
    max_bb: f(p.bet + p.stack),
    pot_bb: f(pot), // このストリートのベットも含む
  };
}
// 同じ問題かを見分ける目印（スートや相手の細かい持ち点は無視：シナリオ・位置・深さ・手・オープンした人・3bet した人）
function spotKey(s) {
  if (s.kind == "postflop") return crypto.createHash("sha256").update("postflop|" + s.seed).digest("hex").slice(0, 32);
  const who = (s.actions || []).filter((a) => a.action == "raise").map((a) => a.pos + a.to_bb).join(",");
  const k = [s.kind, s.scenario, s.hero.position, s.hero.stack_bb, s.hero.cls, who].join("|") + (s.table_size && s.table_size != 5 ? "|" + s.table_size : "");
  return crypto.createHash("sha256").update(k).digest("hex").slice(0, 32);
}

// ---- 保存と読み出し ----
const ACTIONS = ["fold", "check", "call", "bet", "raise", "allin"];
const BAD = -2; // 評価（良い − 悪い）がこれ以下の問題は「次の問題」に出さない
function openSpots(db, { now = () => Date.now() } = {}) {
  // 前に作った問題のうち、まだ誰も答えていない、リンプのあったポストフロップは片付ける（答えがついた問題は残す）
  {
    const del = db.prepare("DELETE FROM spots WHERE id = ?");
    const rows = db
      .prepare(`SELECT id, situation FROM spots s WHERE s.source = 'auto' AND s.kind = 'postflop' AND NOT EXISTS (SELECT 1 FROM spot_answers a WHERE a.spot_id = s.id)`)
      .all();
    db.transaction(() => {
      for (const r of rows) {
        const s = JSON.parse(r.situation);
        if (hasLimp(s.actions, s.table_size || 5)) del.run(r.id);
      }
    })();
  }
  const st = {
    add: db.prepare("INSERT OR IGNORE INTO spots (kind, source, situation, hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
    get: db.prepare("SELECT id, kind, source, situation, created_at FROM spots WHERE id = ?"),
    // 一覧：新しい順。自分が答えたか・答えた人数
    list: db.prepare(`SELECT s.id, s.kind, s.source, s.situation, s.created_at,
        (SELECT COUNT(*) FROM spot_answers a WHERE a.spot_id = s.id) AS answers,
        (SELECT a.action FROM spot_answers a WHERE a.spot_id = s.id AND a.uid = ?) AS mine,
        COALESCE((SELECT SUM(v.vote) FROM spot_votes v WHERE v.spot_id = s.id), 0) AS score
      FROM spots s ORDER BY (mine IS NULL) DESC, s.id DESC LIMIT ?`),
    // 一覧の上限で切る前の数（画面の「回答済み x / y 問」用）
    totals: db.prepare(`SELECT (SELECT COUNT(*) FROM spots) AS total, (SELECT COUNT(*) FROM spot_answers WHERE uid = ?) AS done`),
    // 作り置き：まだ誰も答えていないポストフロップの問題の数
    spare: db.prepare(`SELECT COUNT(*) AS n FROM spots s WHERE s.kind = ? AND NOT EXISTS (SELECT 1 FROM spot_answers a WHERE a.spot_id = s.id)`),
    // 次の問題：自分が答えていないもの（kind を渡せばその種類だけ）のうち、評価が高いもの → 答えた人が多いもの → 古いもの
    // 評価が BAD 以下（悪い問題が良い問題より2票以上多い）の問題は出さない
    next: db.prepare(`SELECT s.id FROM spots s
      WHERE NOT EXISTS (SELECT 1 FROM spot_answers a WHERE a.spot_id = s.id AND a.uid = @uid)
        AND (@kind IS NULL OR s.kind = @kind)
        AND COALESCE((SELECT SUM(v.vote) FROM spot_votes v WHERE v.spot_id = s.id), 0) > @bad
      ORDER BY COALESCE((SELECT SUM(v.vote) FROM spot_votes v WHERE v.spot_id = s.id), 0) DESC,
        (SELECT COUNT(*) FROM spot_answers a WHERE a.spot_id = s.id) DESC, s.id ASC LIMIT 1`),
    // 最後に答えた問題の種類（次はもう一方を出して、プリフロップとポストフロップを交互にする）
    lastKind: db.prepare(`SELECT s.kind FROM spot_answers a JOIN spots s ON s.id = a.spot_id WHERE a.uid = ? ORDER BY a.answered_at DESC, a.rowid DESC LIMIT 1`),
    // 評価
    vote: db.prepare(`INSERT INTO spot_votes (spot_id, uid, vote, voted_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (spot_id, uid) DO UPDATE SET vote = excluded.vote, voted_at = excluded.voted_at`),
    unvote: db.prepare("DELETE FROM spot_votes WHERE spot_id = ? AND uid = ?"),
    votes: db.prepare(`SELECT COALESCE(SUM(vote > 0), 0) AS up, COALESCE(SUM(vote < 0), 0) AS down,
      (SELECT vote FROM spot_votes WHERE spot_id = @id AND uid = @uid) AS mine FROM spot_votes WHERE spot_id = @id`),
    answers: db.prepare("SELECT uid, action, size_bb, comment, answered_at FROM spot_answers WHERE spot_id = ? ORDER BY answered_at ASC"),
    mine: db.prepare("SELECT 1 FROM spot_answers WHERE spot_id = ? AND uid = ?"),
    count: db.prepare("SELECT COUNT(*) AS n FROM spot_answers WHERE spot_id = ?"),
    answer: db.prepare("INSERT OR IGNORE INTO spot_answers (spot_id, uid, action, size_bb, comment, answered_at) VALUES (?, ?, ?, ?, ?, ?)"),
  };
  // 新しい問題を作る（同じ問題がもうあれば作り直す）。プリフロップとポストフロップを半々で
  // ポストフロップはシードを決めて1ハンド進め、あなたの番まで来なければ次のシードで（同じシードなら同じ場面）
  // ポストフロップは1ハンド丸ごと CPU に打たせるので重い。部屋の進行を止めないよう、使ってよい時間（budgetMs）で打ち切る
  // （足りない分は topUp が空いているときに作り置きする）。作れなかった種類は、もう一方で作り直す
  const clock = () => Date.now();
  function makeOne(R, kind, budgetMs) {
    // 時間の制限はポストフロップだけ（プリフロップは一瞬で作れる）。budgetMs が 0 なら、ポストフロップは1回も作らない
    const until = clock() + budgetMs;
    for (let i = 0; i < 60 && (kind == "preflop" || clock() < until); i++) {
      let s = null;
      if (kind == "preflop") s = makePreflop(R);
      else while (!s && clock() < until) s = makePostflop(Math.floor(R() * 2 ** 31));
      if (!s) continue;
      const r = st.add.run(s.kind, "auto", JSON.stringify(s), spotKey(s), null, now());
      if (r.changes) return Number(r.lastInsertRowid);
    }
    return null;
  }
  function create(R = Math.random, kind = R() < 0.5 ? "preflop" : "postflop", budgetMs = 25) {
    return makeOne(R, kind, budgetMs) || makeOne(R, kind == "preflop" ? "postflop" : "preflop", budgetMs);
  }
  // 作り置き：まだ誰も答えていないポストフロップの問題が keep 問より少なければ、budgetMs だけ使って作る（サーバーが定期的に呼ぶ）
  // プリフロップは軽いのですぐ作れるが、ポストフロップと交互に出すため、両方の種類を用意しておく
  function topUp(keep = 3, budgetMs = 10, R = Math.random) {
    for (const kind of ["preflop", "postflop"]) if (st.spare.get(kind).n < keep) return makeOne(R, kind, budgetMs);
    return null;
  }
  return {
    create,
    topUp,
    list: (uid, limit = 200) => st.list.all(uid, limit).map((r) => ({ ...r, situation: JSON.parse(r.situation), mine: r.mine || null })),
    totals: (uid) => st.totals.get(uid),
    // 次の問題：前に答えた問題ともう一方の種類を優先する。なければどちらの種類でも（既にある問題を先に）、それもなければ作る
    // （まだ1問も答えていない人は、種類を問わず、評価が高い・答えが集まっている問題から）
    next(uid, R = Math.random) {
      const last = st.lastKind.get(uid), want = last ? (last.kind == "preflop" ? "postflop" : "preflop") : null;
      const pickOf = (kind) => st.next.get({ uid, kind, bad: BAD });
      const r = (want && pickOf(want)) || pickOf(null);
      return r ? r.id : create(R, want || undefined);
    },
    // 評価する：vote = 1（良い問題）/ -1（悪い問題）/ 0（取り消す）
    vote(id, uid, vote) {
      if (vote) st.vote.run(id, uid, vote > 0 ? 1 : -1, now());
      else st.unvote.run(id, uid);
    },
    votes: (id, uid) => st.votes.get({ id, uid }),
    get(id) {
      const r = st.get.get(id);
      return r ? { ...r, situation: JSON.parse(r.situation) } : null;
    },
    answered: (id, uid) => !!st.mine.get(id, uid),
    count: (id) => st.count.get(id).n,
    answers: (id) => st.answers.all(id),
    // 回答する。もう答えていれば false（結果を見たあとは直せない）
    answer(id, uid, a) {
      return st.answer.run(id, uid, a.action, a.size_bb, a.comment, now()).changes > 0;
    },
  };
}

// ベットを受けているか（facing の印がない古い問題は、to_call_bb で見る）
const isFacing = (s) => (s.facing != null ? !!s.facing : s.to_call_bb > 0);
// 回答の中身を確かめる。戻り値 { ok } か { error }
function cleanAnswer(m, s) {
  if (!m || typeof m != "object") return { error: "送信内容が読めません" };
  const action = m.action;
  if (!ACTIONS.includes(action)) return { error: "行動を選んでください" };
  // ベットを受けているか（受けていれば フォールド・コール・レイズ、いなければ チェック・ベット。オールインはいつでも）
  const facing = isFacing(s);
  if ((action == "fold" || action == "call" || action == "raise") && !facing) return { error: "ここではチェックかベットです" };
  if ((action == "check" || action == "bet") && facing) return { error: "ベットを受けているので、フォールド・コール・レイズです" };
  const comment = typeof m.comment == "string" ? m.comment.trim().replace(/\r\n?/g, "\n") : "";
  if (!comment) return { error: "理由のコメントを書いてください" };
  if (comment.length > 500) return { error: "コメントは500字までです" };
  let size_bb = null;
  if (action == "raise" || action == "bet") {
    size_bb = +m.size;
    const w = action == "bet" ? "ベット" : "レイズ";
    if (!(s.min_raise_bb < s.max_bb)) return { error: `ここでは${w}できません（オールインだけです）` };
    if (!Number.isFinite(size_bb) || size_bb < s.min_raise_bb || size_bb >= s.max_bb) return { error: `${w}額は ${s.min_raise_bb}BB 以上、オールイン（${s.max_bb}BB）より小さくしてください` };
    size_bb = r1(size_bb);
  }
  return { ok: { action, size_bb, comment } };
}

// ---- HTTP の口 ----
function createSpotsApi({ auth, accounts, spots, json, log }) {
  const nameOf = (uid) => {
    const u = accounts.getUser(uid);
    return u ? u.name : "?";
  };
  return function handle(req, res, url) {
    const p = url.pathname;
    if (p !== "/api/spots" && !p.startsWith("/api/spots/")) return false;
    try {
      if (p === "/api/spots/answer") {
        if (req.method !== "POST") return json(res, 405, { why: "POST だけです" }), true;
        const me = auth.browserUser(req);
        if (!me) return json(res, 401, { why: "ログインしてください" }), true;
        if (auth.limit("spot|" + me.id, 30)) return json(res, 429, { why: "少し待ってから送ってください" }), true;
        let body = "";
        req.on("data", (c) => {
          body += c;
          if (body.length > 16 * 1024) req.destroy();
        });
        // ここは外側の try の外（あとで呼ばれる）なので、自分で受け止める。投げたままだとプロセスごと落ちる
        req.on("end", () => {
          try {
            let m;
            try {
              m = JSON.parse(body);
            } catch (e) {
              return json(res, 400, { why: "送信内容が読めません" });
            }
            if (!m || typeof m != "object") return json(res, 400, { why: "送信内容が読めません" });
            const id = +m.id, s = Number.isInteger(id) && spots.get(id);
            if (!s) return json(res, 404, { why: "その問題はありません" });
            const c = cleanAnswer(m, s.situation);
            if (c.error) return json(res, 400, { why: c.error });
            if (!spots.answer(id, me.id, c.ok)) return json(res, 409, { why: "もう回答しています（回答は1人1回です）" });
            log && log("spot answer", id, me.id, c.ok.action);
            json(res, 200, { ok: 1 });
          } catch (e) {
            log && log("spots error", e.stack || e.message);
            if (!res.headersSent) json(res, 500, { why: "保存できませんでした" });
          }
        });
        return true;
      }
      if (p === "/api/spots/vote") {
        if (req.method !== "POST") return json(res, 405, { why: "POST だけです" }), true;
        const me = auth.browserUser(req);
        if (!me) return json(res, 401, { why: "ログインしてください" }), true;
        if (auth.limit("spotvote|" + me.id, 60)) return json(res, 429, { why: "少し待ってから送ってください" }), true;
        let body = "";
        req.on("data", (c) => {
          body += c;
          if (body.length > 1024) req.destroy();
        });
        // ここは外側の try の外（あとで呼ばれる）なので、自分で受け止める
        req.on("end", () => {
          try {
            let m;
            try {
              m = JSON.parse(body);
            } catch (e) {
              return json(res, 400, { why: "送信内容が読めません" });
            }
            if (!m || typeof m != "object" || ![1, -1, 0].includes(m.vote)) return json(res, 400, { why: "送信内容が読めません" });
            const id = +m.id;
            if (!Number.isInteger(id) || !spots.get(id)) return json(res, 404, { why: "その問題はありません" });
            // 答えてから評価する（中身を考えたうえでの評価にするため）
            if (!spots.answered(id, me.id)) return json(res, 403, { why: "答えてから評価できます" });
            spots.vote(id, me.id, m.vote);
            json(res, 200, { ok: 1, votes: spots.votes(id, me.id) });
          } catch (e) {
            log && log("spots error", e.stack || e.message);
            if (!res.headersSent) json(res, 500, { why: "保存できませんでした" });
          }
        });
        return true;
      }
      if (req.method !== "GET") return json(res, 405, { why: "GET だけです" }), true;
      const me = auth.readerUser(req);
      if (!me) return json(res, 401, { why: "ログインしてください" }), true;
      if (p === "/api/spots") {
        // 一覧では、まだ答えていない問題の手札も見せてよい（問題そのものなので）。回答の中身は出さない
        // 未回答を先に並べてから上限で切る。全体の数（total・done）も添える
        return json(res, 200, { me: { id: me.id, name: me.name }, spots: spots.list(me.id), ...spots.totals(me.id) }), true;
      }
      if (p === "/api/spots/next") {
        // 新しく作ることがあるので、回数を制限する
        if (auth.limit("spotnext|" + me.id, 60)) return json(res, 429, { why: "少し待ってからやり直してください" }), true;
        const id = spots.next(me.id);
        if (!id) return json(res, 500, { why: "問題を作れませんでした" }), true;
        return json(res, 200, { id }), true;
      }
      if (p === "/api/spots/one") {
        const id = +url.searchParams.get("id"), s = Number.isInteger(id) && spots.get(id);
        if (!s) return json(res, 404, { why: "その問題はありません" }), true;
        const done = spots.answered(id, me.id);
        const body = { spot: s, answered: done ? 1 : 0, count: spots.count(id) };
        // 答えるまで、他の人の答えは見せない
        if (done) body.answers = spots.answers(id).map((a) => ({ ...a, name: nameOf(a.uid), me: a.uid === me.id ? 1 : 0, uid: undefined }));
        // 評価（良い・悪いの数と、自分の票）は、答えたあとに見せる
        if (done) body.votes = spots.votes(id, me.id);
        return json(res, 200, body), true;
      }
    } catch (e) {
      log && log("spots error", e.stack || e.message);
      return json(res, 500, { why: "読み出せませんでした" }), true;
    }
    return json(res, 404, { why: "not found" }), true;
  };
}

module.exports = { makePostflop, makePreflop, orderOf, heroPosOf, spotKey, openSpots, cleanAnswer, isFacing, hasLimp, isDonk, BAD, createSpotsApi, HAND_POOL, HERO_POS, STACKS, ORDER };
