// hands.js — ハンドを見返すページ。参加した大会のハンドを、卓の絵で1手ずつ再生する（ログインしている人だけ）
// データは振り返りと同じ api/review/*（見える範囲も同じ。続いている大会は、自分の手札と公開された手札だけ）
// 名前などサーバーから届いた文字は textContent でだけ入れる。札は 0〜51 の数なので、決まった形の要素を作る
// ?t=大会ID&n=ハンド番号 で、そのハンドを直接開ける
const $ = (i) => document.getElementById(i);
const { replayFrames, histText, handInfo, posName, RK, SU } = AlpEngine;
const note = (kind, text) => {
  $("msg").hidden = !text;
  $("msg").className = kind;
  $("msg").textContent = text || "";
};
const get = async (p) => {
  const r = await fetch(p, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.why || "読み出せませんでした"), { status: r.status });
  return j;
};
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
// 札：表なら「A♠」、裏なら模様
const card = (c) => {
  if (!(Number.isInteger(c) && c >= 0 && c < 52)) return el("i", "c b", "??");
  const u = (c / 13) | 0;
  return el("i", "c s" + u, RK[c % 13] + SU[u]);
};
const when = (t) => (t ? new Date(t).toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");

let T = null, // 今の大会 { tournament, hands, running }
  list = [], // 絞り込んだハンド
  H = null, // 今のハンド
  frames = [],
  k = 0, // 今のコマ
  timer = null;
const qs = new URLSearchParams(location.search);

async function start() {
  let r;
  try {
    r = await get("api/review/tournaments");
  } catch (e) {
    if (e.status == 401) {
      note("err", "ハンドを見返すには、ログインしてください。");
      const a = el("a", null, "ログインする");
      a.href = "account.html";
      $("msg").append("　", a);
      return;
    }
    return note("err", e.message);
  }
  if (!r.tournaments.length) return note("", "まだ記録がありません。ログインして遊ぶと、ここで見返せるようになります。");
  const sel = $("tsel");
  for (const t of r.tournaments) {
    const o = el("option", null, `${when(t.started_at)}　${t.source == "solo" ? "ひとり用" : "みんなで"}　${t.place ? t.place + "位" : ""}（${t.hands}ハンド）`);
    o.value = t.id;
    sel.appendChild(o);
  }
  $("pick").hidden = false;
  const want = qs.get("t");
  if (want && r.tournaments.some((t) => String(t.id) === want)) sel.value = want;
  await openTournament(+sel.value, +qs.get("n") || 0);
}
async function openTournament(id, n) {
  stop();
  try {
    T = await get("api/review/hands?t=" + id);
  } catch (e) {
    return note("err", e.message);
  }
  note("", "");
  $("note").textContent = T.running ? "この大会はまだ続いています。見えるのは、自分が配られたハンドの、自分の手札と公開された手札だけです。" : "";
  $("all").disabled = !!T.running;
  if (T.running) $("all").checked = false;
  refilter(n);
}
const info = (h) => handInfo(h, T.tournament.oid);
function refilter(n) {
  const f = { sd: $("fsd").checked, ai: $("fai").checked, big: $("fbig").checked, vp: $("fvp").checked, pos: $("fpos").value };
  list = T.hands.filter((h) => {
    const x = info(h);
    return x && (!f.sd || x.sd) && (!f.ai || x.ai) && (!f.big || x.big) && (!f.vp || x.vp) && (!f.pos || x.pos === f.pos);
  });
  const sel = $("hsel");
  sel.textContent = "";
  for (const h of list) {
    const x = info(h), o = el("option", null, `#${h.n}　Lv${h.lv}　${x.pos}　${(x.net > 0 ? "+" : "") + x.net.toFixed(1)}BB`);
    o.value = h.n;
    sel.appendChild(o);
  }
  if (!list.length) {
    $("rp").hidden = true;
    return note("", "条件に合うハンドがありません");
  }
  note("", "");
  const pick = list.find((h) => h.n === n) || list[0];
  openHand(pick);
}
function openHand(h) {
  stop();
  H = h;
  frames = replayFrames(h);
  k = 0;
  $("hsel").value = h.n;
  $("txt").textContent = histText([h]);
  $("rp").hidden = false;
  // アドレスにも残す（再読み込み・共有用）
  try {
    history.replaceState(null, "", `?t=${T.tournament.id}&n=${h.n}`);
  } catch (e) {}
  draw();
}
function draw() {
  const fr = frames[k], me = info(H), bb = H.bb || 1, f = (x) => +(x / bb).toFixed(1), all = $("all").checked;
  const seat = (i) => {
    const s = H.seats[i], st = fr.seats[i], d = el("div", "s" + (st.fold ? " f" : "") + (fr.actor === i ? " a" : "") + (i === me.i ? " h" : ""));
    const nm = el("b", null, s.name);
    d.append(nm, " ", el("small", null, posName(i, H.seats.length)));
    d.appendChild(el("div", null, f(st.stack) + " BB" + (st.allin && !st.fold ? "（オールイン）" : "")));
    const cs = el("div");
    const show = i === me.i || st.open || (all && s.h);
    if (s.h && show) s.h.forEach((c) => cs.appendChild(card(c)));
    else if (!st.fold) cs.append(card(-1), card(-1));
    else cs.textContent = " ";
    d.appendChild(cs);
    d.appendChild(el("em", null, st.bet ? "bet " + f(st.bet) : ""));
    d.appendChild(el("span", "ac", st.act || ""));
    return d;
  };
  const tb = $("tb");
  tb.textContent = "";
  const row = el("div", "row");
  // 自分以外を、自分の次の席から順に上へ並べる（卓を回る順）
  for (let j = 1; j < H.seats.length; j++) row.appendChild(seat((me.i + j) % H.seats.length));
  const bd = el("div", "bd");
  if (fr.board.length) fr.board.forEach((c) => bd.appendChild(card(c)));
  else bd.append(" ");
  bd.appendChild(el("span", null, `POT ${f(fr.pot)} BB　Lv${H.lv}（${H.sb}/${H.bb} ante ${H.an}）`));
  tb.append(row, bd, seat(me.i));
  $("cap").textContent = fr.cap;
  $("cnt").textContent = `${k + 1} / ${frames.length}`;
  $("fp").disabled = $("f0").disabled = k == 0;
  $("fn").disabled = $("fe").disabled = k == frames.length - 1;
  const at = list.indexOf(H);
  $("hp").disabled = at <= 0;
  $("hn").disabled = at >= list.length - 1;
}
const go = (to) => {
  k = Math.max(0, Math.min(frames.length - 1, to));
  draw();
};
const stop = () => {
  clearInterval(timer);
  timer = null;
  $("play").textContent = "自動再生";
};
$("f0").onclick = () => (stop(), go(0));
$("fp").onclick = () => (stop(), go(k - 1));
$("fn").onclick = () => (stop(), go(k + 1));
$("fe").onclick = () => (stop(), go(frames.length - 1));
$("play").onclick = () => {
  if (timer) return stop();
  if (k >= frames.length - 1) go(0);
  $("play").textContent = "止める";
  timer = setInterval(() => (k >= frames.length - 1 ? stop() : go(k + 1)), 900);
};
const hop = (d) => {
  const at = list.indexOf(H) + d;
  if (at >= 0 && at < list.length) openHand(list[at]);
};
$("hp").onclick = () => hop(-1);
$("hn").onclick = () => hop(1);
$("hsel").onchange = () => openHand(list.find((h) => String(h.n) === $("hsel").value));
$("tsel").onchange = () => openTournament(+$("tsel").value, 0);
$("all").onchange = () => H && draw();
for (const id of ["fsd", "fai", "fbig", "fvp", "fpos"]) $(id).onchange = () => T && refilter(H && H.n);
// キーボード：← → で1手、Shift+← → で前後のハンド、Home / End
document.addEventListener("keydown", (e) => {
  if (!H || /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
  if (e.key == "ArrowRight") e.shiftKey ? hop(1) : (stop(), go(k + 1));
  else if (e.key == "ArrowLeft") e.shiftKey ? hop(-1) : (stop(), go(k - 1));
  else if (e.key == "Home") (stop(), go(0));
  else if (e.key == "End") (stop(), go(frames.length - 1));
  else return;
  e.preventDefault();
});
start();
