// review.js — 振り返りの画面（参加した大会・ハンドの一覧と絞り込み・1ハンドの表示・保存）と、打ち方の傾向の画面
// サーバー（server/review.js）から届いたものは、textContent でだけ画面に入れる（名前などを HTML として扱わない）
// $・note・get・when は page.js
const { histText, cardText, fileStamp, handInfo } = AlpEngine;
const el = (tag, text, attrs) => {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  Object.assign(e, attrs || {});
  return e;
};
const row = (cells, head) => {
  const tr = el("tr");
  for (const c of cells) tr.appendChild(el(head ? "th" : "td", c));
  return tr;
};
const saveFile = (name, text, type) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// ---- タブ ----
const tab = (n) => {
  $("p1").hidden = n != 1;
  $("p2").hidden = n != 2;
  $("t1").className = n == 1 ? "on" : "g";
  $("t2").className = n == 2 ? "on" : "g";
  if (n == 2 && !$("who").options.length) loadMembers();
};
$("t1").onclick = () => tab(1);
$("t2").onclick = () => tab(2);

// ---- 大会とハンド ----
let cur = null; // { tournament, hands, running }
async function loadTournaments() {
  let r;
  try {
    r = await get("api/review/tournaments");
  } catch (e) {
    return note("err", e.status == 401 ? "ログインしてください（アカウントの画面から）" : e.message);
  }
  const t = $("ts");
  t.textContent = "";
  t.appendChild(row(["日時", "種類", "順位", "ハンド", "状態"], 1));
  if (!r.tournaments.length) t.appendChild(row(["まだ記録がありません（ログインして遊ぶと、ここに溜まります）", "", "", "", ""]));
  for (const x of r.tournaments) {
    const tr = row([
      when(x.started_at),
      x.source == "solo" ? "ひとり用" : "みんなで",
      x.place ? `${x.place}位 / ${x.entries || "?"}` : "—",
      String(x.hands),
      x.finished ? "終わった" : x.closed ? "途中で終わった" : x.source == "mp" ? "続いている" : "途中",
    ]);
    tr.className = "pick";
    tr.onclick = () => openTournament(x.id);
    t.appendChild(tr);
  }
}
async function openTournament(id) {
  try {
    cur = await get("api/review/hands?t=" + id);
  } catch (e) {
    return note("err", e.message);
  }
  note("", "");
  const T = cur.tournament;
  $("hp").hidden = false;
  $("h1").hidden = true;
  $("ht").textContent = `${when(T.started_at)}　${T.source == "solo" ? "ひとり用" : "みんなで遊ぶ"}`;
  $("hn").textContent = cur.running
    ? "この大会はまだ続いています。見えるのは、自分が配られたハンドの、自分の手札と公開された手札だけです。"
    : T.source == "solo"
      ? "相手は CPU なので、全員の手札が見えます。"
      : "終わった大会なので、全員の手札が見えます。";
  showHands();
  $("hp").scrollIntoView({ behavior: "smooth" });
}
// 自分の席・結果など、1ハンドの見出し用の情報（engine.js の handInfo）
const info = (H) => {
  const x = handInfo(H, cur.tournament.oid);
  return x && { ...x, s: x.seat };
};
function filtered() {
  const f = { sd: $("fsd").checked, ai: $("fai").checked, big: $("fbig").checked, vp: $("fvp").checked, pos: $("fpos").value };
  return cur.hands.filter((H) => {
    const x = info(H);
    if (!x) return false;
    return (!f.sd || x.sd) && (!f.ai || x.ai) && (!f.big || x.big) && (!f.vp || x.vp) && (!f.pos || x.pos === f.pos);
  });
}
function showHands() {
  const list = filtered(), t = $("hs");
  $("hc").textContent = `${list.length} / ${cur.hands.length} ハンド`;
  t.textContent = "";
  t.appendChild(row(["#", "Lv", "位置", "手札", "ボード", "結果"], 1));
  for (const H of list) {
    const x = info(H);
    const tr = row([
      String(H.n),
      String(H.lv),
      x.pos,
      x.s.h ? x.s.h.map(cardText).join(" ") : "",
      (H.bd || []).map(cardText).join(" "),
      (x.net > 0 ? "+" : "") + x.net.toFixed(1) + "BB",
    ]);
    tr.className = "pick";
    tr.onclick = () => {
      $("h1").hidden = false;
      $("h1").textContent = histText([H]);
      // 卓の絵で1手ずつ見る（ハンドを見返すページ）
      const a = document.createElement("a");
      a.href = `hands.html?t=${cur.tournament.id}&n=${H.n}`;
      a.textContent = "▶ 卓で再生";
      $("h1").prepend(a, "\n\n");
    };
    t.appendChild(tr);
  }
}
for (const id of ["fsd", "fai", "fbig", "fvp", "fpos"]) $(id).onchange = () => cur && showHands();
$("sx").onclick = () => cur && saveFile(`alpoker-hands-${fileStamp(new Date())}.txt`, histText(filtered()), "text/plain;charset=utf-8");
$("sj").onclick = () =>
  cur && saveFile(`alpoker-hands-${fileStamp(new Date())}.json`, JSON.stringify({ format: "alpoker-hands", version: 2, hands: filtered() }, null, 1), "application/json");

// ---- 打ち方の傾向 ----
let me = null;
async function loadMembers() {
  let r;
  try {
    r = await get("api/style/members");
  } catch (e) {
    return note("err", e.message);
  }
  me = r.me;
  const w = $("who");
  w.textContent = "";
  w.appendChild(el("option", me.name + "（わたし）", { value: me.id }));
  for (const m of r.members) w.appendChild(el("option", m.name, { value: m.id }));
  $("shr").hidden = false;
  $("shc").checked = !!me.share;
  loadStyle();
}
const src = () => document.querySelector("input[name=src]:checked").value;
const fmt = (v, kind) => (v == null ? "—" : kind == "%" ? Math.round(v * 100) + "%" : v.toFixed(2));
let lastStyle = null;
async function loadStyle() {
  const days = +$("per").value, since = days ? Date.now() - days * 864e5 : 0;
  try {
    lastStyle = await get(`api/style?u=${encodeURIComponent($("who").value)}&since=${since}`);
  } catch (e) {
    return note("err", e.message);
  }
  drawStyle();
}
function drawStyle() {
  const S = lastStyle[src()], c = S.counts;
  $("sh").textContent = `${lastStyle.user.name}：${c.hands || 0} ハンド（${{ all: "合算", mp: "対人", solo: "対CPU" }[src()]}）`;
  const t = $("rows");
  t.textContent = "";
  t.appendChild(row(["項目", "値", "回数"], 1));
  for (const r of S.rows) t.appendChild(row([r.name, fmt(r.value, r.kind), String(r.count)]));
  const tbl = (id, obj, order, label) => {
    const e = $(id);
    e.textContent = "";
    e.appendChild(row([label, "ハンド", "VPIP", "PFR"], 1));
    for (const k of order) {
      const o = obj[k];
      if (!o) continue;
      e.appendChild(row([k, String(o.hands), fmt((o.vpip || 0) / o.hands, "%"), fmt((o.pfr || 0) / o.hands, "%")]));
    }
  };
  tbl("pos", S.pos, ["UTG", "CO", "D", "SB", "BB"], "位置");
  tbl("dep", S.depth, ["short", "mid", "deep"], "深さ");
  for (const tr of $("dep").querySelectorAll("tr td:first-child")) tr.textContent = { short: "M 10以下", mid: "M 20以下", deep: "M 20より上" }[tr.textContent];
}
$("who").onchange = loadStyle;
$("per").onchange = loadStyle;
for (const r of document.querySelectorAll("input[name=src]")) r.onchange = () => lastStyle && drawStyle();
$("ex").onclick = () => (location.href = `api/style/profile?u=${encodeURIComponent($("who").value)}&src=${src()}`);
$("shc").onchange = async () => {
  try {
    const r = await fetch("api/me/share", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: $("shc").checked }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).why || "変えられませんでした");
    note("ok", $("shc").checked ? "身内CPU化に使ってよいにしました" : "身内CPU化に使わないようにしました");
  } catch (e) {
    $("shc").checked = !$("shc").checked;
    note("err", e.message);
  }
};
loadTournaments();
