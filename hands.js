// hands.js — ハンドを見返すページ。参加した大会のハンドを、卓の絵で1手ずつ再生する（ログインしている人だけ）
// データは振り返りと同じ api/review/*（見える範囲も同じ。続いている大会は、自分の手札と公開された手札だけ）
// 名前などサーバーから届いた文字は textContent で入れるか、卓の絵（table.js）では tblEsc してから入れる。札は 0〜51 の数だけ表にする
// ?t=大会ID&n=ハンド番号 で、そのハンドを直接開ける
// $・note・get・when は page.js、卓の絵（seatHtml・tableHtml・tblEsc）は table.js
const { replayFrames, histText, handInfo, cd } = AlpEngine;
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
// 札の HTML：0〜51 の数なら表、それ以外は裏
const card = (c) => (Number.isInteger(c) && c >= 0 && c < 52 ? cd(c) : cd(0, 1));

let T = null, // 今の大会 { tournament, hands, running }
  list = [], // 絞り込んだハンド
  H = null, // 今のハンド
  me = null, // 今のハンドでの自分の席（handInfo）
  at = -1, // 今のハンドの、絞り込んだ一覧の中での位置
  infos = new Map(), // ハンド -> handInfo（大会を開いたときに1回だけ数える）
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
  const want = qs.get("t"), found = want && r.tournaments.some((t) => String(t.id) === want);
  if (found) sel.value = want;
  // アドレスの n（ハンド番号）は、アドレスの大会が見つかったときだけ使う（別の大会の同じ番号を開かない）
  await openTournament(+sel.value, found ? +qs.get("n") || 0 : 0);
  // 開けたときだけ知らせる（開くのにも失敗していたら、そのエラーを残す）
  if (want && !found && T) note("err", "アドレスの大会は見られません（参加した大会だけ）。いちばん新しい大会を開きました。");
}
async function openTournament(id, n) {
  stop();
  try {
    T = await get("api/review/hands?t=" + id);
  } catch (e) {
    // 前の大会を出したままにしない（選んだ大会と、画面・アドレスの中身がずれないように）
    T = null;
    clearHand();
    infos = new Map();
    $("hsel").textContent = "";
    return note("err", e.message);
  }
  infos = new Map(T.hands.map((h) => [h, handInfo(h, T.tournament.oid)]));
  note("", "");
  $("note").textContent = T.running ? "この大会はまだ続いています。見えるのは、自分が配られたハンドの、自分の手札と公開された手札だけです。" : "";
  $("all").disabled = !!T.running;
  if (T.running) $("all").checked = false;
  refilter(n);
}
const info = (h) => infos.get(h);
// 今のハンドをやめる（再生を止め、絵を隠す。キーボードも効かなくなる）
function clearHand() {
  stop();
  H = me = null;
  at = -1;
  frames = [];
  k = 0;
  $("rp").hidden = true;
  $("hp").disabled = $("hn").disabled = true;
}
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
    clearHand();
    // 絞り込みのせいか、そもそも見られるハンドがないのかを分けて伝える
    return note("", T.hands.some(info) ? "条件に合うハンドがありません" : "この大会には、見られるハンドがありません");
  }
  note("", "");
  const pick = list.find((h) => h.n === n) || list[0];
  openHand(pick);
}
function openHand(h) {
  stop();
  H = h;
  me = info(h);
  at = list.indexOf(h);
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
  const fr = frames[k], bb = H.bb || 1, f = (x) => +(x / bb).toFixed(1), all = $("all").checked;
  // 席は遊ぶ画面と同じ形（table.js の seatHtml）。サーバーから届いた文字は tblEsc してから渡す
  const seat = (i) => {
    const s = H.seats[i], st = fr.seats[i], show = i === me.i || st.open || (all && s.h);
    return seatHtml({
      name: tblEsc(s.name),
      lab: tblEsc(s.pos || ""),
      sub: st.allin && !st.fold ? "オールイン" : "",
      stack: f(st.stack),
      cards: s.h && show ? s.h.map(card).join("") : st.fold ? "" : card(-1) + card(-1),
      fold: st.fold,
      act: fr.actor === i,
      me: i === me.i,
      bet: st.bet ? f(st.bet) : 0,
      ac: tblEsc(st.fold && !(i === me.i) ? "" : st.act || ""), // 降りた人は席に「フォールド」と出るので、行動の一言は重ねない
    });
  };
  const tb = $("tb"), n = H.seats.length, order = [];
  // 自分を下に置き、席の順に時計回り（卓を回る順＝アクションの順）
  for (let j = 0; j < n; j++) order.push(seat((me.i + j) % n));
  tb.className = "ring";
  tb.innerHTML = tableHtml(
    order,
    `<div class="bd">${fr.board.length ? fr.board.map(card).join("") : "&nbsp;"}${potHtml(fr.pot, AlpEngine.potOf(fr.seats).bets, f)}` +
      `<small class="lv">${tblEsc(`Lv${H.lv}（${H.sb}/${H.bb} ante ${H.an}）`)}</small></div>`,
  );
  $("cap").textContent = fr.cap;
  $("cnt").textContent = `${k + 1} / ${frames.length}`;
  $("fp").disabled = $("f0").disabled = k == 0;
  $("fn").disabled = $("fe").disabled = k == frames.length - 1;
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
  const to = at + d;
  if (H && to >= 0 && to < list.length) openHand(list[to]);
};
$("hp").onclick = () => hop(-1);
$("hn").onclick = () => hop(1);
$("hsel").onchange = () => openHand(list.find((h) => String(h.n) === $("hsel").value));
$("tsel").onchange = () => openTournament(+$("tsel").value, 0);
$("all").onchange = () => H && draw();
for (const id of ["fsd", "fai", "fbig", "fvp", "fpos"]) $(id).onchange = () => T && refilter(H && H.n);
// キーボード：← → で1手、Shift+← → で前後のハンド、Home / End
document.addEventListener("keydown", (e) => {
  // 文字を打つ欄・選ぶ欄にいるときは、その欄の操作を優先する（チェックボックスのあとは効く）
  const a = document.activeElement, tag = a ? a.tagName : "";
  if (!H || /^(SELECT|TEXTAREA)$/.test(tag) || (tag == "INPUT" && !/^(checkbox|radio|button)$/.test(a.type))) return;
  if (e.key == "ArrowRight") e.shiftKey ? hop(1) : (stop(), go(k + 1));
  else if (e.key == "ArrowLeft") e.shiftKey ? hop(-1) : (stop(), go(k - 1));
  else if (e.key == "Home") (stop(), go(0));
  else if (e.key == "End") (stop(), go(frames.length - 1));
  else return;
  e.preventDefault();
});
start();
