// game.js — ひとり用の画面と進行。ゲームの中身（ルール・CPU）は engine.js にある。
const $ = (i) => document.getElementById(i);
const { LV, cd, hand, bust, bal, advanceLevel, playHand, soloSetup, saveMem, meStats, REC_KEYS, MEK, ME_DECAY, ME_PRIOR, histText, fileStamp } =
  AlpEngine;
// ブラウザの保存先（ネームドCPUの記憶などに使う）
const LS = {
  get: (k) => localStorage.getItem(k),
  set: (k, v) => localStorage.setItem(k, v),
};
let G = {},
  S = { n: 0, w: 0, ft: 0, itm: 0, pt: 0 };
try {
  S = Object.assign(S, JSON.parse(localStorage.getItem("mtt5")));
} catch (e) {}
$("st").textContent = S.n
  ? `戦績：${S.n}回 / 優勝${S.w} / FT${S.ft} / ITM${S.itm} / 仮pt合計${S.pt}`
  : "";
const alive = () => AlpEngine.alive(G),
  itm = () => AlpEngine.itm(G);
const fb = (x) => +(x / LV[G.lv][1]).toFixed(1);
const ls = () => {
  try {
    return localStorage.getItem("mtt5ty") != "0";
  } catch (e) {
    return 1;
  }
};
function step(v) {
  const g = G.cur;
  let r = g.next(v);
  for (; !r.done; r = g.next()) {
    const y = r.value;
    if (y.k == "hero") {
      G.req = y;
      render();
      return;
    }
    if (y.k == "tick" && G.live) {
      const h = G.hero;
      render();
      setTimeout(() => step(), h.fold || h.allin ? 130 : 480);
      return;
    }
  }
  end();
}
function end() {
  G.live = 0;
  const T = G.T,
    h = G.hero;
  bust(G, T);
  saveMem(G, LS);
  saveMe();
  // ログインしていれば、このハンドをアカウントへ送る（solo-sync.js。読み込んでいなければ何もしない）
  if (typeof soloSync != "undefined") soloSync.hand(G);
  G.wait = 1;
  render();
  if (h.stack <= 0) {
    G.wait = 0;
    if (G.lv < 2 && !h.re) {
      G.ask = 1;
      render();
    } else fin();
  }
}
function nx() {
  G.wait = 0;
  G.lg = [];
  G.tables.forEach((t) => (t.gone = []));
  const o = G.T;
  advanceLevel(G, Date.now());
  G.tables.forEach((t) => {
    if (t != G.T) {
      playHand(G, t);
      bust(G, t);
    }
  });
  bal(G);
  G.T = G.tables.find((t) => t.p.includes(G.hero));
  if (G.T != o) G.lg.push("※ テーブルが再編され、移動しました");
  if (alive() == 1) return fin();
  G.live = 1;
  G.cur = hand(G, G.T, (s) => G.lg.push(s));
  step();
}
function reent() {
  const h = G.hero;
  h.stack = 1e4;
  h.re++;
  G.entries++;
  G.ask = 0;
  G.wait = 1;
  G.lg.push("リエントリーしました");
  render();
}
function fin() {
  const h = G.hero;
  saveMem(G, LS);
  saveMe();
  h.alive = 0;
  G.ask = 0;
  const pl = alive() + 1,
    pt = pl == 1 ? 6 : pl == 2 ? 4 : pl == 3 ? 3 : pl <= 5 ? 2 : pl <= itm() ? 1 : 0;
  G.place = pl; // 見出しと操作欄を「終わった」表示にする
  G.done = 1;
  S.n++;
  if (pl == 1) S.w++;
  if (pl <= 5) S.ft++;
  if (pl <= itm()) S.itm++;
  S.pt += pt;
  try {
    localStorage.setItem("mtt5", JSON.stringify(S));
  } catch (e) {}
  if (typeof soloSync != "undefined") soloSync.finish(G, pl);
  render();
  $("ov").hidden = 0;
  $("ov").innerHTML =
    `<h2 style="margin-top:0">${pl == 1 ? "🏆 優勝！" : pl + "位 でフィニッシュ"}</h2><p>${pl <= itm() ? "ITM（入賞）" : "ITM圏外"}${pl <= 5 ? "／ファイナルテーブル" : ""}　エントリー ${G.entries}人（あなたのリエントリー ${h.re}回）</p><p style="color:var(--mu)">参考：サーキットpt（仮配点）${pt}pt／通算 ${S.n}回・優勝${S.w}・FT${S.ft}・ITM${S.itm}</p><button onclick="location.reload()">もう一度</button><button class=g onclick="$('ov').hidden=1">閉じる（卓を見る）</button>`;
}
// ---- 画面の部品（ひとり用・みんなで遊ぶで共通）----
// 上の情報：小さな枠ごとに並べる。o の値はすべて数（HTML に入れても安全）
//   { lv: レベルの番号(0〜), bb, an, al: 残り人数, en: エントリー数, itm: 入賞の順位, avg: 平均(BB), rk: 順位, st: スタック(BB), re: リエントリーできる, spec: 観戦中 }
function hdHtml(o) {
  const box = (label, main, sub, cls) => `<div class="hb${cls ? " " + cls : ""}"><small>${label}</small><b>${main}</b>${sub ? `<span>${sub}</span>` : ""}</div>`;
  return (
    `<div class="hdg">` +
    box("レベル", `Lv${o.lv + 1}`, `BB ${o.bb}・ante ${+(o.an / o.bb).toFixed(2)}BB`) +
    `<div class="hb"><small>次のレベルまで</small><b id=tm></b></div>` +
    box("残り", `${o.al}人`, `エントリー ${o.en}`) +
    box("入賞", `${o.itm}位まで`) +
    box("平均", `${o.avg}BB`) +
    (o.spec
      ? box("あなた", "観戦中", "", "me")
      : o.done
        ? box("あなた", o.place ? `${o.place}位` : "—", "終了", "me")
        : box("あなた", `${o.rk}位`, `${o.st}BB${o.re ? "・リエントリー可" : ""}`, "me")) +
    `</div>`
  );
}
// 席。o の文字（name・sub・lab）は HTML に入れて安全なもの（ひとり用は CPU の名前、みんなで遊ぶは mpClean 済み）
//   o: { name, col: 名前の色, sub: タイプなどの小さな字, lab: "D SB" などの位置, stack: BB, cards: 手札の HTML, fold, act: 行動中, me, bet: BB（なければ 0） }
// 位置は小さな印にする。降りた人は手札の代わりに「フォールド」と出す（自分の手札は残す）
function seatHtml(o) {
  const pos = String(o.lab || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((x) => `<i class="pos p${x}">${x}</i>`)
    .join("");
  const cards = o.fold && !o.me ? '<span class="fd">フォールド</span>' : o.cards || "&nbsp;";
  return (
    `<div class="s${o.fold ? " f" : ""}${o.act ? " a" : ""}${o.me ? " h" : ""}">` +
    `<div class="sn"><b style="color:${o.col || "inherit"}">${o.name}</b>${pos}</div>` +
    `${o.sub ? `<small>${o.sub}</small>` : ""}<div>${o.stack} BB</div><div class="hc">${cards}</div>` +
    `<em>${o.bet ? o.bet + "BB" : ""}</em></div>`
  );
}
// 卓：席を楕円に並べ、真ん中にボードとポット。seats は席の HTML を「下の真ん中（ふつうは自分）から時計回り」の順に
function tableHtml(seats, center) {
  const pos = AlpEngine.seatRing(seats.length);
  return (
    `<div class="felt"></div>` +
    seats.map((h, k) => `<div class="seat" style="left:${pos[k].x}%;top:${pos[k].y}%">${h}</div>`).join("") +
    `<div class="mid">${center}</div>`
  );
}
// 真ん中のポット表示。POT は前のストリートまでに集まった額（アンティ込み）で、このストリートのベットは含めない
// （ベット額がポットの何%かを見て取れるように）。ベットが出ている間は、ベット込みの合計も小さく添える
function potHtml(total, bets, f) {
  return `<span>POT ${f(total - bets)} BB</span>` + (bets > 0 ? `<small class="pt">ベット込み ${f(total)} BB</small>` : "");
}
// 席の並びを、me が先頭になるように回す（並びの順＝時計回りの順はそのまま）
const fromMe = (list, isMe) => {
  const i = list.findIndex(isMe);
  return i > 0 ? list.slice(i).concat(list.slice(0, i)) : list;
};
// 自分の番の操作欄。A: 行動を送る関数の名前、X: レイズ額を動かす関数の名前（ひとり用は A / X、みんなで遊ぶは MA / MX）
//   o: { toCall, call: コールの額(BB), cur, mn: 最小のレイズ額, mx: 最大（オールイン）, pot, f: 点 → BB }
// 1段目に「フォールド・コール（チェック）・レイズ」を並べ、2段目にレイズ額（スライダーとよく使う額）をまとめる
function actHtml(A, X, o) {
  const raise = o.mx > o.cur, word = o.cur ? "レイズ" : "ベット";
  let c = `<div class="acts">`;
  c += o.toCall
    ? `<button class=g onclick="${A}('f')">フォールド</button><button onclick="${A}('c')">コール ${o.call}BB</button>`
    : `<button onclick="${A}('c')">チェック</button>`;
  if (raise) c += `<button class="rb" onclick="${A}('r')">${word} <b id=rv>${o.f(o.mn)}</b>BB</button>`;
  c += `</div>`;
  if (raise) {
    const pr = o.cur
      ? [[2, "2倍"], [2.5, "2.5倍"], [3, "3倍"]].map(([k, n]) => [Math.round(o.cur * k), n])
      : [[1 / 3, "ポットの1/3"], [0.5, "ポットの1/2"], [1, "ポット"]].map(([k, n]) => [Math.round(o.pot * k), n]);
    c +=
      `<div class="rz"><div class="mu">${word}額を選ぶ（${o.f(o.mn)}〜${o.f(o.mx)}BB）</div>` +
      `<input id=sl type=range min=${o.mn} max=${o.mx} value=${o.mn} oninput="${X}(this.value)">` +
      `<div class="pre">${pr.map(([x, n]) => `<button class=g onclick="${X}(${x},1)">${n}</button>`).join("")}<button class=g onclick="${X}(${o.mx},1)">オールイン</button></div></div>`;
  }
  return c;
}
function render() {
  const T = G.T,
    h = G.hero,
    al = G.P.filter((p) => p.alive),
    [sb, bb, an] = LV[G.lv];
  const rk = [...al].sort((a, b) => b.stack - a.stack).indexOf(h) + 1,
    avg = Math.round(al.reduce((s, p) => s + p.stack, 0) / Math.max(1, al.length));
  const hs = hdHtml({ lv: G.lv, bb, an, al: al.length, en: G.entries, itm: itm(), avg: fb(avg), rk, st: fb(h.stack), re: G.lv < 2 && !h.re, done: !h.alive, place: G.place });
  if (G.hs != hs) {
    G.hs = hs;
    $("hd").innerHTML = hs;
    tmr();
  }
  const seat = (p) =>
    seatHtml({
      name: p.name,
      col: p.col,
      sub: [p.hero || !G.ty ? "" : p.ty[0], p.k && G.ty ? `記憶${Math.round(p.mem?.get("hero")?.n || 0)}H` : "", p.alive ? "" : "バスト"].filter(Boolean).join(" "),
      lab: p.lab,
      stack: fb(p.stack),
      cards: p.h ? p.h.map((c) => cd(c, !p.hero && !p.show)).join("") : "",
      fold: p.fold,
      act: G.req && G.req.p == p,
      me: p.hero,
      bet: p.bet ? fb(p.bet) : 0,
    });
  const pot = (T.ps || []).reduce((s, p) => s + p.tot, 0),
    bets = (T.ps || []).reduce((s, p) => s + (p.bet || 0), 0);
  // 席の順（T.p）で円に並べる。あなたを下に置き、そこから時計回り。バストしてまだ表示している人は最後に
  $("tb").className = "ring";
  $("tb").innerHTML = tableHtml(
    fromMe(T.p, (p) => p.hero).concat(T.gone || []).map(seat),
    `<div class=bd>${(T.bd || []).map((c) => cd(c)).join("") || "&nbsp;"}${potHtml(pot, bets, fb)}</div>`,
  );
  let c = "";
  if (G.req) {
    const { p, c: q } = G.req,
      mx = p.bet + p.stack,
      mn = Math.min(q.cur + q.minR, mx);
    G.rx = G.rx0 = mn;
    G.mn = mn;
    G.mx = mx;
    c = actHtml("A", "X", { toCall: q.toCall, call: fb(Math.min(q.toCall, p.stack)), cur: q.cur, mn, mx, pot: q.pot, f: fb });
  } else if (G.done) c = '<span class="mu">大会が終わりました</span>';
  else if (G.ask)
    c =
      '<p>バストしました。リエントリー（開始スタック）しますか？</p><button onclick="reent()">リエントリー</button><button class=g onclick="fin()">終了</button>';
  else if (G.wait && h.stack > 0) c = '<button onclick="nx()">次のハンド ▶</button>';
  else if (!G.wait) c = '<span style="color:var(--mu)">CPUのアクション中…</span>';
  $("ct").innerHTML = c;
  $("lg").innerHTML = G.lg
    .slice(-14)
    .map((s) => `<div>${s}</div>`)
    .join("");
  $("lg").scrollTop = 1e5;
}
function X(v, s) {
  v = Math.max(G.mn, Math.min(G.mx, +v));
  G.rx = v;
  $("rv").textContent = fb(v);
  if (s) $("sl").value = v;
}
function A(t) {
  G.req = null;
  step(t == "r" ? { t, x: G.rx } : { t });
}
function TY2(v) {
  G.ty = v;
  try {
    localStorage.setItem("mtt5ty", v ? 1 : 0);
  } catch (e) {}
  render();
}
function tmr() {
  const e = $("tm");
  if (e && G.lvEnd) {
    const t = (Math.max(0, G.lvEnd - Date.now()) / 1000) | 0,
      s = ((t / 60) | 0) + ":" + String(t % 60).padStart(2, "0");
    if (e.textContent != s) e.textContent = s;
  }
}
setInterval(tmr, 500);
// ---- あなたの記録の保存・表示・エクスポート ----
// all: 累計 / recent: 直近（大会の始めに ME_DECAY 倍に縮めるので、最近の大会ほど重い）
// 表示・エクスポートの指標は「直近 ＋ 累計を最大 ME_PRIOR ハンド分の重みに縮めたもの」から計算する
function loadMe() {
  try {
    const m = JSON.parse(localStorage.getItem(MEK));
    if (m && m.v == 1) return m;
  } catch (e) {}
  return { v: 1, tn: 0, all: {}, recent: {} };
}
function saveMe() {
  try {
    localStorage.setItem(MEK, JSON.stringify(G.me));
  } catch (e) {}
}
function renderMe() {
  const m = loadMe(),
    el = $("me");
  if (!el) return;
  if (!m.all.hands) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `<details><summary>あなたの傾向（${m.tn}大会・累計${Math.round(m.all.hands)}ハンド）</summary>
<table><tr><td>指標</td><td>直近重視</td><td>累計</td><td>回数（累計）</td></tr>${meStats(m)
    .map(
      (r) =>
        `<tr><td>${r.name}</td><td>${r.text[0]}</td><td>${r.text[1]}</td><td>${r.count}</td></tr>`,
    )
    .join("")}</table>
<p>名前 <input id="mename" value="あなた" size="10"> <button onclick="exportMe()">エクスポート</button><button class="g" onclick="resetMe()">記録をリセット</button></p></details>`;
}
// 調整ツール（tools/fit.js）に渡すファイルを書き出す
function exportMe() {
  const m = loadMe(),
    name = ($("mename").value || "あなた").trim(),
    data = {
      format: "alpoker-profile",
      version: 1,
      name,
      exportedAt: new Date().toISOString(),
      tournaments: m.tn,
      blend: { decay: ME_DECAY, prior: ME_PRIOR },
      keys: REC_KEYS,
      all: m.all,
      recent: m.recent,
      summary: Object.fromEntries(meStats(m).map((r) => [r.name, r.blend])),
    },
    a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  // 日本語のファイル名は環境によって無視されるので、ファイル名は日付だけにする（名前は中身に入る）
  a.download = `alpoker-profile-${data.exportedAt.slice(0, 10).replace(/-/g, "")}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function resetMe() {
  if (!confirm("あなたの傾向の記録をすべて消します。よろしいですか？")) return;
  try {
    localStorage.removeItem(MEK);
  } catch (e) {}
  renderMe();
}
// ---- ハンド履歴の保存（あなたが配られたハンド。ひとり用は全員の手札つき） ----
// kind: "txt"（読む用）/ "json"（道具に渡す用）。みんなで遊ぶときは部屋に頼んで、届いたら保存する（mp.js）
function saveFile(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function saveHands(hands, kind, extra) {
  const stamp = fileStamp(new Date());
  if (!hands || !hands.length) return ($("hxm").textContent = "まだ記録されたハンドがありません");
  $("hxm").textContent = `${hands.length}ハンドを保存しました` + (extra || "");
  if (kind == "json")
    saveFile(`alpoker-hands-${stamp}.json`, JSON.stringify({ format: "alpoker-hands", version: 1, hands }, null, 1), "application/json");
  else saveFile(`alpoker-hands-${stamp}.txt`, histText(hands), "text/plain;charset=utf-8");
}
function HX(kind) {
  if (G.mp && typeof mpHands == "function") return mpHands(kind);
  saveHands(G.hist, kind);
}
function begin() {
  G = { dur: +$("spd").value * 6e4, lv: 0, entries: 40, lg: [], ty: ls(), hist: [] };
  $("tyc").checked = G.ty;
  G.lvEnd = Date.now() + G.dur;
  soloSetup(G, LS);
  // あなたの記録：直近の記録を縮めてから、この大会の記録を足していく
  G.me = loadMe();
  for (const k in G.me.recent) G.me.recent[k] *= ME_DECAY;
  G.me.tn++;
  // G.tr：この大会だけの記録（アカウントへ送る用）
  G.tr = {};
  G.P[0].rec = [G.me.all, G.me.recent, G.tr];
  saveMe();
  if (typeof soloSync != "undefined") soloSync.start(G);
  $("start").hidden = 1;
  $("game").hidden = 0;
  nx();
}
renderMe();
