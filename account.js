// account.js — アカウント画面（ログイン・表示名・ログイン方法の連携・管理者の招待とメンバー管理）
// サーバー（server/auth.js）が返すものは、textContent でだけ画面に入れる（HTML として扱わない）
const $ = (i) => document.getElementById(i);
// サーバーから戻ってきたときの結果（?r=コード）。文言はここで決める
const R = {
  linked: ["ok", "ログイン方法を追加しました"],
  state: ["err", "ログインをやり直してください（時間が経ちすぎたか、別のタブで始めたログインです）"],
  cancel: ["err", "ログインを取りやめました"],
  provider: ["err", "外部サービスとのやりとりに失敗しました。少し待ってからやり直してください"],
  needinvite: ["err", "まだメンバーではありません。招待リンクから入ってください"],
  notmember: ["err", "身内の Discord サーバーのメンバーではないようです。招待リンクから入ってください"],
  badinvite: ["err", "招待リンクが使えません（使用済みか、期限切れ）。新しいリンクをもらってください"],
  taken: ["err", "その外部アカウントは、別の人に紐づいています"],
  one: ["err", "同じ種類のログイン方法は1つまでです。先に今のものを外してください"],
  relogin: ["err", "ログインし直してください"],
  disabled: ["err", "このアカウントは止められています。管理者に確認してください"],
  badlink: ["err", "ログインリンクが使えません（使用済みか、期限切れ）"],
};
const qs = new URLSearchParams(location.search);
// 招待の合言葉は、アドレスバーから消してタブの中だけに持つ（画面を見せたり、URL を貼ったりしたときに漏れないように）
let invite = qs.get("invite") || "";
try {
  if (invite) sessionStorage.setItem("alp-invite", invite);
  else invite = sessionStorage.getItem("alp-invite") || "";
} catch (e) {}
if (qs.has("invite") || qs.has("r")) history.replaceState(null, "", location.pathname);
const note = (kind, text) => {
  $("msg").hidden = !text;
  $("msg").className = kind;
  $("msg").textContent = text || "";
};
if (R[qs.get("r")]) note(...R[qs.get("r")]);
const post = async (p, body) => {
  const r = await fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.why || "うまくいきませんでした");
  return j;
};
const P = { discord: "Discord", google: "Google" };

async function load() {
  let me;
  try {
    me = await fetch("api/me", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null));
  } catch (e) {}
  if (!me) return note("err", "このページは簡易サーバーでだけ使えます");
  if (!me.enabled) return note("err", "ログインはまだ設定されていません（サーバーの PUBLIC_URL と、Discord / Google の設定が必要です）");
  const u = me.user;
  $("out").hidden = !!u;
  $("in").hidden = !u;
  $("adm").hidden = !(u && u.role === "admin");
  if (!u) {
    $("lead").textContent = invite ? "招待されています。使う外部サービスを選んでログインしてください。" : "使う外部サービスを選んでログインしてください。";
    const b = $("btns");
    b.textContent = "";
    for (const [k, label] of Object.entries(me.providers)) {
      const btn = document.createElement("button");
      btn.textContent = label + " でログイン";
      btn.onclick = () => (location.href = `auth/${k}/start?` + new URLSearchParams({ invite, next: "./" }));
      b.appendChild(btn);
    }
    return;
  }
  try {
    sessionStorage.removeItem("alp-invite"); // ログインできたら招待はもう要らない
  } catch (e) {}
  $("nm").textContent = u.name;
  $("rl").textContent = u.role === "admin" ? "管理者" : "メンバー";
  $("nmi").value = u.name;
  const ul = $("ids");
  ul.textContent = "";
  for (const k of Object.keys(me.providers)) {
    const idn = u.identities.find((i) => i.provider === k), li = document.createElement("li");
    li.textContent = P[k] + "：" + (idn ? idn.name + " " : "未連携 ");
    const b = document.createElement("button");
    b.className = "g";
    if (idn) {
      b.textContent = "外す";
      b.disabled = u.identities.length <= 1;
      b.onclick = () => post("api/me/unlink", { provider: k }).then(load, (e) => note("err", e.message));
    } else {
      b.textContent = "連携する";
      b.onclick = () => (location.href = `auth/${k}/start?intent=link`);
    }
    li.appendChild(b);
    ul.appendChild(li);
  }
  if (u.role === "admin") {
    $("gd").hidden = !me.guild;
    loadUsers();
  }
}
async function loadUsers() {
  const ul = $("us");
  try {
    const { users } = await post("api/admin/users");
    ul.textContent = "";
    for (const x of users) {
      const li = document.createElement("li");
      li.textContent = `${x.name}（${x.role === "admin" ? "管理者" : "メンバー"}・${x.identities.map((i) => P[i.provider] || i.provider).join("+")}・端末${x.sessions}${x.disabled ? "・停止中" : ""}）`;
      const rb = document.createElement("button");
      rb.className = "g";
      rb.textContent = x.role === "admin" ? "メンバーにする" : "管理者にする";
      rb.onclick = () => post("api/admin/role", { id: x.id, role: x.role === "admin" ? "member" : "admin" }).then(load, (e) => note("err", e.message));
      const lb = document.createElement("button");
      lb.className = "g";
      lb.textContent = "ログアウトさせる";
      lb.onclick = () => confirm(x.name + " をすべての端末からログアウトさせますか？") && post("api/admin/logout", { id: x.id }).then(load, (e) => note("err", e.message));
      const db = document.createElement("button");
      db.className = "g";
      db.textContent = x.disabled ? "停止を解く" : "止める";
      db.onclick = () =>
        (x.disabled || confirm(x.name + " を止めますか？（ログアウトさせ、入り直せなくします）")) &&
        post("api/admin/disable", { id: x.id, on: !x.disabled }).then(load, (e) => note("err", e.message));
      li.append(" ", rb, lb, db);
      ul.appendChild(li);
    }
  } catch (e) {
    note("err", e.message);
  }
}
$("nmb").onclick = () => post("api/me", { name: $("nmi").value }).then(() => (note("ok", "表示名を変えました"), load()), (e) => note("err", e.message));
$("lo").onclick = () => post("auth/logout").then(load, (e) => note("err", e.message));
$("loa").onclick = () => confirm("すべての端末からログアウトしますか？") && post("api/me/logout-all").then(load, (e) => note("err", e.message));
const mkInvite = (role) =>
  post("api/admin/invite", { role }).then(
    (r) => {
      $("ivo").hidden = false;
      $("ivu").value = r.url;
      note("ok", `${role === "admin" ? "管理者" : "メンバー"}用の招待リンクを作りました（${new Date(r.expiresAt).toLocaleString("ja-JP")} まで・1回だけ）`);
    },
    (e) => note("err", e.message),
  );
$("ivm").onclick = () => mkInvite("member");
$("iva").onclick = () => confirm("管理者用の招待リンクを作りますか？（受け取った人は、招待やメンバー管理ができます）") && mkInvite("admin");
$("ivc").onclick = () => navigator.clipboard && navigator.clipboard.writeText($("ivu").value).then(() => ($("ivc").textContent = "コピーしました"));
load();
