// table.js — 卓の絵（席を楕円に並べた卓）。遊ぶ画面（game.js・mp.js）と、ハンドを見返すページ（hands.js）で共通
// engine.js のあとに読み込む（席の位置は AlpEngine.seatRing）
// HTML に入れる文字を安全にする（見返すページで、サーバーから届いた名前などに使う）
const tblEsc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// 席。o の文字（name・sub・lab・ac）は HTML に入れて安全なもの（ひとり用は CPU の名前、みんなで遊ぶは mpClean 済み、見返すページは tblEsc 済み）
//   o: { name, col: 名前の色, sub: タイプなどの小さな字, lab: "D SB" などの位置, stack: BB, cards: 手札の HTML, fold, act: 行動中, me, bet: BB（なければ 0）, ac: 直前の行動などの一言（省略可） }
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
    `<em>${o.bet ? o.bet + "BB" : ""}</em>${o.ac != null ? `<span class="ac">${o.ac || "&nbsp;"}</span>` : ""}</div>`
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
// 席の並びを、me が先頭になるように回す（並びの順＝時計回りの順はそのまま）
const fromMe = (list, isMe) => {
  const i = list.findIndex(isMe);
  return i > 0 ? list.slice(i).concat(list.slice(0, i)) : list;
};
