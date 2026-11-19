// spots.js — スポットのページ（spots.html）。一覧・1問に答える・みんなの回答
// 場面の中身は server/spots.js の makePreflop の形。サーバーから届いた文字（名前・コメント）は textContent でだけ入れる
const { cd } = AlpEngine;
const ACT = { fold: "フォールド", call: "コール", raise: "レイズ", allin: "オールイン" };
const SCN = { open: "オープンするか", vsopen: "オープンへの対応", vs3bet: "3bet への対応" };
const fb = (x) => +(+x).toFixed(1);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
// 手の短い書き方（"A5s"）と、場面の一言
const title = (s) => `${SCN[s.scenario] || ""}　${s.hero.position}・${s.hero.stack_bb}BB　${s.hero.cls}`;
// 行動の言い方。fold 以外はコールの言い方を場面で変える（誰もレイズしていなければリンプ）
const callWord = (s) => (s.scenario == "open" ? (s.hero.position == "SB" ? "コール（リンプ）" : "リンプ") : "コール");
const actText = (s, a) =>
  a.action == "raise" ? `レイズ ${fb(a.size_bb)}BB` : a.action == "call" ? `${callWord(s)} ${fb(s.facing_bb)}BB` : ACT[a.action] || a.action;

async function post(p, body) {
  const r = await fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.why || "送れませんでした"), { status: r.status });
  return j;
}
const go = (id) => (location.href = "spots.html?id=" + id);
async function nextSpot() {
  try {
    note("", "");
    const { id } = await get("api/spots/next");
    go(id);
  } catch (e) {
    note("err", e.message);
  }
}
$("nx1").onclick = $("nx2").onclick = nextSpot;

// ---- 一覧 ----
async function showList() {
  const { spots } = await get("api/spots");
  const done = spots.filter((s) => s.mine).length;
  $("cnt").textContent = spots.length ? `回答済み ${done} / ${spots.length} 問` : "まだ問題がありません。「次の問題に答える」で最初の問題が作られます";
  // 答えていないものを上に（その中は新しい順）
  const list = spots.slice().sort((a, b) => !!a.mine - !!b.mine || b.id - a.id);
  const t = $("ls");
  t.textContent = "";
  if (list.length) {
    const h = el("tr");
    for (const x of ["#", "場面", "回答", "あなた"]) h.appendChild(el("th", null, x));
    t.appendChild(h);
  }
  for (const s of list) {
    const tr = el("tr", "pick");
    tr.onclick = () => go(s.id);
    tr.appendChild(el("td", null, s.id));
    const td = el("td");
    td.append(el("span", "tag", s.kind == "preflop" ? "プリフロップ" : "ポストフロップ"), " ", title(s.situation));
    tr.appendChild(td);
    tr.appendChild(el("td", "c2", s.answers + "人"));
    const m = el("td", "c2");
    if (s.mine) m.textContent = ACT[s.mine] || s.mine;
    else m.appendChild(el("span", "tag new", "未回答"));
    tr.appendChild(m);
    t.appendChild(tr);
  }
  $("lv").hidden = false;
}

// ---- 1問 ----
// 卓の絵：席の順（UTG → CO → BTN → SB → BB）のまま、自分を下に置いて時計回り
function drawTable(s) {
  const put = {}, folded = {};
  for (const x of s.seats) put[x.pos] = x.pos == "SB" ? 0.5 : x.pos == "BB" ? 1 : 0;
  for (const a of s.actions) {
    if (a.action == "raise") put[a.pos] = a.to_bb;
    if (a.action == "fold") folded[a.pos] = 1;
  }
  const ante = s.ante_bb || 0;
  const order = fromMe(s.seats, (x) => x.pos == s.hero.position);
  const html = order.map((x) => {
    const me = x.pos == s.hero.position, bet = Math.min(put[x.pos], x.stack_bb - ante);
    return seatHtml({
      name: me ? "あなた" : tblEsc(x.pos),
      lab: x.pos == "BTN" ? "D" : "", // SB・BB は名前がそのまま位置なので、印は重ねない
      sub: me ? tblEsc(x.pos) : "",
      stack: fb(x.stack_bb - ante - bet),
      cards: me ? s.hero.hand.map((c) => cd(c)).join("") : cd(0, 1) + cd(0, 1),
      fold: !!folded[x.pos],
      act: me,
      me,
      bet: bet ? fb(bet) : 0,
    });
  });
  const bets = s.seats.reduce((t, x) => t + Math.min(put[x.pos], x.stack_bb - ante), 0);
  $("tb").className = "ring";
  $("tb").innerHTML = tableHtml(html, `<div class="bd">&nbsp;${potHtml(s.pot_bb, bets, fb)}<small class="pt">アンティ ${fb(ante)}BB × ${s.seats.length}人</small></div>`);
}
// ここまでの流れ（自分の番まで）
function drawFlow(s) {
  const f = $("flow");
  f.textContent = "";
  const who = (a) => (a.pos == s.hero.position ? `あなた（${a.pos}）` : a.pos);
  const parts = s.actions.map((a) => (a.action == "raise" ? `${who(a)} ${fb(a.to_bb)}BB にレイズ` : `${who(a)} フォールド`));
  f.append(el("span", "mu", "プリフロップ：" + (parts.length ? parts.join(" → ") + " → " : "")), el("b", null, "あなた（" + s.hero.position + "）"));
}

let S = null, choice = null;
function drawForm(s) {
  const b = $("btns");
  b.textContent = "";
  const opts = [["fold", "フォールド"]];
  if (s.to_call_bb > 0 && s.to_call_bb < s.max_bb - s.in_bb) opts.push(["call", `${callWord(s)} ${fb(s.facing_bb)}BB`]);
  if (s.min_raise_bb < s.max_bb) opts.push(["raise", "レイズ"]);
  opts.push(["allin", `オールイン ${fb(s.max_bb)}BB`]);
  for (const [k, label] of opts) {
    const x = el("button", k == "raise" ? "rb" : "g", label);
    x.dataset.k = k;
    x.onclick = () => pickAct(k);
    b.appendChild(x);
  }
  // レイズ額：よく使う額
  const r = $("rsz");
  r.min = s.min_raise_bb;
  r.max = fb(s.max_bb - 0.1);
  $("rhint").textContent = `（${s.min_raise_bb}〜${fb(s.max_bb - 0.1)}BB。それ以上はオールイン）`;
  const pre = $("rpre");
  pre.textContent = "";
  const sizes = s.scenario == "open" ? [2, 2.2, 2.5, 3] : [2.5, 3, 3.5, 4].map((k) => fb(s.facing_bb * k));
  for (const x of [...new Set(sizes)].filter((x) => x >= s.min_raise_bb && x < s.max_bb)) {
    const p = el("button", "g", x + "BB");
    p.onclick = () => ((r.value = x), check());
    pre.appendChild(p);
  }
  r.value = (sizes.find((x) => x >= s.min_raise_bb && x < s.max_bb) || s.min_raise_bb);
  r.oninput = check;
  $("cmt").oninput = check;
  $("form").hidden = false;
}
function pickAct(k) {
  choice = k;
  for (const x of $("btns").children) x.classList.toggle("on", x.dataset.k == k);
  $("rzb").hidden = k != "raise";
  check();
}
function check() {
  const okSize = choice != "raise" || (+$("rsz").value >= S.min_raise_bb && +$("rsz").value < S.max_bb);
  $("send").disabled = !(choice && okSize && $("cmt").value.trim());
  $("sent").textContent = !choice ? "行動を選んでください" : !okSize ? "レイズ額を確かめてください" : !$("cmt").value.trim() ? "理由を書いてください" : "";
}
$("send").onclick = async () => {
  $("send").disabled = true;
  try {
    await post("api/spots/answer", { id: S.id, action: choice, size: +$("rsz").value, comment: $("cmt").value });
    await showSpot(S.id);
  } catch (e) {
    note("err", e.message);
    if (e.status == 409) await showSpot(S.id);
    else check();
  }
};
function drawResult(s, answers) {
  // 何人がどれを選んだか（グラフは出さない。5人規模では、並べて読むほうが分かる）
  const n = {};
  for (const a of answers) n[a.action] = (n[a.action] || 0) + 1;
  $("sum").textContent = `${answers.length}人が回答：` + Object.keys(ACT).filter((k) => n[k]).map((k) => `${ACT[k]} ${n[k]}`).join("・");
  const L = $("alist");
  L.textContent = "";
  for (const a of answers) {
    const d = el("div", "ans" + (a.me ? " me" : ""));
    d.append(el("span", "who", a.me ? `${a.name}（あなた）` : a.name), el("span", "act", actText(s, a)), el("p", null, a.comment));
    L.appendChild(d);
  }
  if (answers.length < 2) L.appendChild(el("p", "mu", "まだほかの人の回答がありません。答えが集まったら、ここに並びます。"));
  $("res").hidden = false;
}
async function showSpot(id) {
  const r = await get("api/spots/one?id=" + id);
  S = { ...r.spot.situation, id: r.spot.id };
  document.title = `スポット #${S.id}`;
  drawTable(S);
  drawFlow(S);
  $("q").textContent = r.answered ? `#${S.id}　${title(S)}` : `#${S.id}　${title(S)}。どうする？（${r.count}人が回答済み）`;
  $("form").hidden = $("res").hidden = true;
  if (r.answered) drawResult(S, r.answers);
  else drawForm(S);
  $("sv").hidden = false;
}

(async () => {
  try {
    const id = +new URLSearchParams(location.search).get("id");
    if (id) await showSpot(id);
    else await showList();
  } catch (e) {
    note("err", e.status == 401 ? "ログインしてください（トップ画面の「ログイン」から）" : e.message);
  }
})();
