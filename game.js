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
    `<h2 style="margin-top:0">${pl == 1 ? "🏆 優勝！" : pl + "位 でフィニッシュ"}</h2><p>${pl <= itm() ? "ITM（入賞）" : "ITM圏外"}${pl <= 5 ? "／ファイナルテーブル" : ""}　エントリー ${G.entries}人（あなたのリエントリー ${h.re}回）</p><p style="color:var(--mu)">参考：サーキットpt（仮配点）${pt}pt／通算 ${S.n}回・優勝${S.w}・FT${S.ft}・ITM${S.itm}</p><button onclick="location.reload()">もう一度</button>`;
}
function render() {
  const T = G.T,
    h = G.hero,
    al = G.P.filter((p) => p.alive),
    [sb, bb, an] = LV[G.lv];
  const rk = [...al].sort((a, b) => b.stack - a.stack).indexOf(h) + 1,
    avg = Math.round(al.reduce((s, p) => s + p.stack, 0) / Math.max(1, al.length));
  const hs = `<b>Lv${G.lv + 1}</b>（BB=${bb}点・ante ${+(an / bb).toFixed(2)}BB） ・ 次Lvまで <b id=tm></b> ・ 残り <b>${al.length}</b>/${G.entries}人 ・ ITM ${itm()}位 ・ 平均 ${fb(avg)}BB ・ あなた <b>${rk}位</b>（${fb(h.stack)}BB）${G.lv < 2 && !h.re ? " ・ <b>RE可</b>" : ""}`;
  if (G.hs != hs) {
    G.hs = hs;
    $("hd").innerHTML = hs;
    tmr();
  }
  const seat = (p) =>
    `<div class="s${p.fold ? " f" : ""}${G.req && G.req.p == p ? " a" : ""}${p.hero ? " h" : ""}"><b style="color:${p.col || "inherit"}">${p.name}</b> <small>${p.hero || !G.ty ? "" : p.ty[0]}${p.k && G.ty ? ` 記憶${Math.round(p.mem?.get("hero")?.n || 0)}H` : ""} ${p.lab || ""}${p.alive ? "" : " バスト"}</small><div>${fb(p.stack)} BB</div><div>${p.h ? p.h.map((c) => cd(c, !p.hero && !p.show)).join("") : "&nbsp;"}</div><em>${p.bet ? "bet " + fb(p.bet) : ""}</em></div>`;
  const pot = (T.ps || []).reduce((s, p) => s + p.tot, 0);
  $("tb").innerHTML = `<div class=row>${T.p
    .concat(T.gone || [])
    .filter((p) => !p.hero)
    .map(seat)
    .join(
      "",
    )}</div><div class=bd>${(T.bd || []).map((c) => cd(c)).join("") || "&nbsp;"}<span>POT ${fb(pot)} BB</span></div>${seat(h)}`;
  let c = "";
  if (G.req) {
    const { p, c: q } = G.req,
      mx = p.bet + p.stack,
      mn = Math.min(q.cur + q.minR, mx);
    G.rx = G.rx0 = mn;
    G.mn = mn;
    G.mx = mx;
    c = q.toCall
      ? `<button class=g onclick="A('f')">フォールド</button><button onclick="A('c')">コール ${fb(Math.min(q.toCall, p.stack))}BB</button>`
      : `<button onclick="A('c')">チェック</button>`;
    if (mx > q.cur)
      c +=
        `<div class=rs><input id=sl type=range min=${mn} max=${mx} value=${mn} oninput="X(this.value)"><button onclick="A('r')">${q.cur ? "レイズ" : "ベット"} <span id=rv>${fb(mn)}</span>BB</button></div><div>` +
        (q.cur
          ? [
              [2, "2x"],
              [2.5, "2.5x"],
              [3, "3x"],
            ].map(
              ([f, n]) => `<button class=g onclick="X(${Math.round(q.cur * f)},1)">${n}</button>`,
            )
          : [
              [1 / 3, "1/3 Pot"],
              [0.5, "1/2 Pot"],
              [1, "1 Pot"],
            ].map(
              ([f, n]) => `<button class=g onclick="X(${Math.round(q.pot * f)},1)">${n}</button>`,
            )
        ).join("") +
        `<button class=g onclick="X(${mx},1)">All-in</button></div>`;
  } else if (G.ask)
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
