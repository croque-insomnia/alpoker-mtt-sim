// page.js — 振り返り（review.html）と、ハンドを見返すページ（hands.html）で共通の小物
// サーバーから届いた文字は textContent でだけ入れる（HTML として扱わない）
const $ = (i) => document.getElementById(i);
// 画面上のお知らせ（kind: "ok" / "err" / ""。text が空なら隠す）
const note = (kind, text) => {
  $("msg").hidden = !text;
  $("msg").className = kind;
  $("msg").textContent = text || "";
};
// 読むだけの API。失敗したら、サーバーの理由（why）と status を持ったエラーを投げる
const get = async (p) => {
  const r = await fetch(p, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.why || "読み出せませんでした"), { status: r.status });
  return j;
};
// 日時（年月日 時:分）
const when = (t) => (t ? new Date(t).toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
