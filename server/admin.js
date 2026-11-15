// admin.js — VPS の上で使う管理コマンド。動いているサーバーの「管理用の口」（127.0.0.1:ADMIN_PORT）に頼む
//   npm run admin -- invite admin      … 管理者用の招待リンクを出す（最初の1人はこれで入る）
//   npm run admin -- invite            … メンバー用の招待リンクを出す
//   npm run admin -- login <名前>      … 緊急ログインリンクを出す（外部サービスが落ちているときなど。15分・1回だけ）
//   npm run admin -- users             … アカウントの一覧
// ADMIN_PORT は既定 8091（サーバーと同じ値にする）
"use strict";
const http = require("http");
const port = +process.env.ADMIN_PORT || 8091;

function call(method, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers: { "content-type": "application/json" } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(b) });
        } catch (e) {
          reject(new Error("返事が読めません: " + b));
        }
      });
    });
    req.on("error", (e) =>
      reject(new Error(`サーバーの管理用の口（127.0.0.1:${port}）につながりません。サーバーが動いているか、ADMIN_PORT が合っているか確かめてください（${e.code}）`)),
    );
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
const when = (t) => new Date(t).toLocaleString("ja-JP");

async function main([cmd, arg]) {
  if (cmd === "invite") {
    const r = await call("POST", "/invite", { role: arg === "admin" ? "admin" : "member" });
    if (r.status != 200) throw new Error(r.body.why);
    console.log(`${r.body.role === "admin" ? "管理者" : "メンバー"}用の招待リンク（${when(r.body.expiresAt)} まで・1回だけ）:\n${r.body.url}`);
  } else if (cmd === "login") {
    if (!arg) throw new Error("名前を指定してください: npm run admin -- login <名前>");
    const r = await call("POST", "/login-link", { user: arg });
    if (r.status != 200) throw new Error(r.body.why);
    console.log(`${r.body.user} の緊急ログインリンク（${when(r.body.expiresAt)} まで・1回だけ）:\n${r.body.url}`);
  } else if (cmd === "users") {
    const r = await call("GET", "/users");
    for (const u of r.body.users)
      console.log(`${u.role === "admin" ? "★" : " "} ${u.name.padEnd(12)} ${u.identities.map((i) => i.provider).join("+").padEnd(16)} 端末${u.sessions}  最終ログイン ${u.lastLogin ? when(u.lastLogin) : "-"}`);
    if (!r.body.users.length) console.log("まだ誰もいません。npm run admin -- invite admin で最初の管理者を招待してください");
  } else {
    console.log("使い方:\n  npm run admin -- invite admin\n  npm run admin -- invite\n  npm run admin -- login <名前>\n  npm run admin -- users");
    process.exitCode = 1;
  }
}
main(process.argv.slice(2)).catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
