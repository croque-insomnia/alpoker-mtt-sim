// auth.js — 外部ログイン（Discord / Google）とアカウントの HTTP の口。データは accounts.js が持つ。
//
// 流れ（OAuth 2.0 の認可コード方式。Google は PKCE も付ける）
//   1. GET auth/<discord|google>/start      … 使い捨ての state を作り、短命の Cookie に入れて外部サービスへ送る
//   2. GET auth/<discord|google>/callback   … state を確かめ、外部サービスに直接問い合わせて本人の ID を受け取る
//   3. 通す条件（紐づき済み・招待・Discord サーバーのメンバー）を確かめ、セッションの Cookie を渡して戻す
// 外部サービスの秘密鍵はサーバーだけが持つ（ブラウザには出さない）。メールアドレスは頼まない・持たない
//
// 環境変数
//   PUBLIC_URL             このアプリの公開 URL（例 https://kaina-lab.com/poker/mtt/）。戻り先の URL はここから作る。なければログインは無効
//   COOKIE_PATH            セッションの Cookie を共有する範囲（既定 /。kaina-lab.com では /poker/）
//   DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET / DISCORD_GUILD_ID（このサーバーのメンバーは招待なしで入れる）
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
//   TRUST_PROXY=1          前に Caddy などがいるとき。回数制限に X-Forwarded-For の接続元を使う
//   ADMIN_PORT             VPS の中からだけ届く管理用の口（127.0.0.1）。招待リンク・緊急ログインリンクを出す（0 で無効）
"use strict";
const http = require("http"),
  crypto = require("crypto");

const PROVIDERS = {
  discord: {
    label: "Discord",
    authorize: "https://discord.com/oauth2/authorize",
    token: "https://discord.com/api/oauth2/token",
    me: "https://discord.com/api/users/@me",
    guilds: "https://discord.com/api/users/@me/guilds",
    pkce: false,
    // 返ってくる本人の情報を、共通の形にする
    who: (u) => ({ sub: u.id, name: u.global_name || u.username, avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : null }),
  },
  google: {
    label: "Google",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    me: "https://openidconnect.googleapis.com/v1/userinfo",
    scope: "openid profile",
    pkce: true,
    who: (u) => ({ sub: u.sub, name: u.name || u.given_name, avatar: u.picture || null }),
  },
};
const STATE_MS = 10 * 60e3, // 外部サービスから戻ってくるまでの猶予
  LINK_MS = 15 * 60e3; // 緊急ログインリンクの有効期限
const b64u = (buf) => buf.toString("base64url");
const parseCookies = (h) =>
  Object.fromEntries(
    String(h || "")
      .split(";")
      .map((s) => s.trim().split("="))
      .filter(([k, v]) => k && v != null)
      .map(([k, ...v]) => {
        // 読めない値（% の使い方が正しくないもの。同じドメインの別のアプリの Cookie など）は無視する
        try {
          return [k, decodeURIComponent(v.join("="))];
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean),
  );

function createAuth(opt) {
  const env = opt.env,
    accounts = opt.accounts,
    log = opt.log || (() => {}),
    doFetch = opt.fetch || globalThis.fetch,
    now = opt.now || (() => Date.now()),
    pub = env.PUBLIC_URL ? new URL(env.PUBLIC_URL.endsWith("/") ? env.PUBLIC_URL : env.PUBLIC_URL + "/") : null,
    cookiePath = env.COOKIE_PATH || "/",
    secure = pub && pub.protocol === "https:",
    trustProxy = env.TRUST_PROXY === "1",
    guild = env.DISCORD_GUILD_ID || "";
  // 使える外部ログイン（ID と秘密鍵の両方があるものだけ）。テストでは opt.providers で行き先を差し替える
  const prov = {};
  for (const [k, P] of Object.entries(PROVIDERS)) {
    const id = env[k.toUpperCase() + "_CLIENT_ID"], secret = env[k.toUpperCase() + "_CLIENT_SECRET"];
    if (pub && id && secret) prov[k] = { ...P, ...((opt.providers || {})[k] || {}), id, secret, redirect: new URL(`auth/${k}/callback`, pub).href };
  }
  if (prov.discord) prov.discord.scope = guild ? "identify guilds" : "identify";
  const pending = new Map(), // state -> { p, intent, invite, next, userId, verifier, exp }
    links = new Map(); // 緊急ログインリンクのハッシュ -> { userId, exp }
  const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

  // ---- 小物 ----
  const cookie = (name, val, maxAge) =>
    `${name}=${encodeURIComponent(val)}; Path=${cookiePath}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}; Max-Age=${maxAge}`;
  const json = (res, code, obj, headers = {}) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify(obj));
  };
  const redirect = (res, to, headers = {}) => {
    res.writeHead(302, { location: to, "cache-control": "no-store", "referrer-policy": "no-referrer", ...headers });
    res.end();
  };
  // 結果をアカウント画面に知らせる。文言はコードだけ渡し、画面側で決まった文に置き換える（好きな文字列を出させない）
  const toAccount = (res, code, headers) => {
    const u = new URL("account.html", pub);
    u.searchParams.set("r", code);
    redirect(res, u.pathname + u.search, headers);
  };
  // X-Forwarded-For は最後の値（すぐ前の中継が付けたもの）を使う。先頭は送り手が好きに書ける
  const ip = (req) => (trustProxy && String(req.headers["x-forwarded-for"] || "").split(",").pop().trim()) || req.socket.remoteAddress || "";
  // 回数制限：接続元ごとに1分あたり limit 回まで
  const hits = new Map();
  const limited = (req, kind, limit) => {
    const k = kind + "|" + ip(req), t = now(), h = hits.get(k);
    if (hits.size > 2000) for (const [x, v] of hits) if (t - v.t > 60e3) hits.delete(x); // 古い記録を捨てる
    if (!h || t - h.t > 60e3) return hits.set(k, { t, n: 1 }), false;
    return ++h.n > limit;
  };
  // 書き込み系は、このサイトのページから来たものだけ受け付ける（別のサイトに仕込まれた送信を防ぐ）
  const sameOrigin = (req) => {
    const o = req.headers.origin;
    if (!o) return false;
    if (pub) return o === pub.origin;
    return o === `http://${req.headers.host}` || o === `https://${req.headers.host}`;
  };
  const readJson = (req) =>
    new Promise((resolve) => {
      let b = "";
      req.on("data", (c) => {
        b += c;
        if (b.length > 4096) req.destroy();
      });
      req.on("end", () => {
        try {
          resolve(JSON.parse(b || "{}"));
        } catch (e) {
          resolve(null);
        }
      });
      req.on("error", () => resolve(null));
    });
  const sid = (req) => parseCookies(req.headers.cookie).alp_sid || "";
  const userFromReq = (req) => accounts.sessionUser(sid(req));
  // このサイトのページから来たときだけ、Cookie のセッションを使う（別のサイトに仕込まれた接続・送信は、ゲストとして扱う）
  const browserSid = (req) => (sameOrigin(req) ? sid(req) : ""),
    browserUser = (req) => accounts.sessionUser(browserSid(req));
  // 読むだけの GET 用。ブラウザは同じサイトの GET に Origin を付けないので、「別のサイトだと分かるもの」だけを断る
  // （別のサイトのページが fetch しても、応答は読めない。Cookie も SameSite=Lax なので、ふつうは付かない）
  const readerUser = (req) => {
    const o = req.headers.origin, site = req.headers["sec-fetch-site"];
    if (o && !sameOrigin(req)) return null;
    if (site && site !== "same-origin" && site !== "none") return null;
    return accounts.sessionUser(sid(req));
  };
  // 戻り先は、このアプリの中のページだけ（外のサイトへ飛ばす踏み台にさせない）
  const safeNext = (n) => {
    try {
      const u = new URL(n || "", pub);
      if (u.origin === pub.origin && u.pathname.startsWith(pub.pathname) && !u.pathname.startsWith("//")) return u.pathname + u.search;
    } catch (e) {}
    return new URL("account.html", pub).pathname;
  };
  const sweepPending = () => {
    const t = now();
    for (const [k, v] of pending) if (v.exp < t) pending.delete(k);
    for (const [k, v] of links) if (v.exp < t) links.delete(k);
  };
  const login = (req, res, userId, next) => {
    accounts.endSession(sid(req)); // 前のセッションは捨てて、作り直す
    const s = accounts.createSession(userId, req.headers["user-agent"]);
    redirect(res, next, { "set-cookie": [cookie("alp_sid", s.token, s.maxAge), cookie("alp_oa", "", 0)] });
  };

  // ---- 外部サービスとのやりとり ----
  // 外部サービスが返したエラーの種類（invalid_client など）だけを取り出す。説明文や秘密の値はログに出さない
  const errCode = async (r) => {
    try {
      const j = await r.json(), e = j && (j.error || (j.code != null && "code " + j.code));
      return typeof e == "string" && /^[\w .-]{1,40}$/.test(e) ? " " + e : "";
    } catch (e) {
      return "";
    }
  };
  async function exchange(P, code, verifier) {
    const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: P.redirect, client_id: P.id, client_secret: P.secret });
    if (verifier) body.set("code_verifier", verifier);
    const r = await doFetch(P.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body });
    if (!r.ok) throw new Error("token " + r.status + (await errCode(r)));
    const t = await r.json();
    if (!t.access_token) throw new Error("no access_token");
    const get = async (u) => {
      const x = await doFetch(u, { headers: { authorization: "Bearer " + t.access_token, accept: "application/json" } });
      if (!x.ok) throw new Error("api " + x.status + (await errCode(x)));
      return x.json();
    };
    const who = P.who(await get(P.me));
    if (!who.sub) throw new Error("no subject");
    // Discord：指定したサーバーのメンバーか
    let member = false;
    if (P === prov.discord && guild) member = (await get(P.guilds)).some((g) => g && String(g.id) === guild);
    return { ...who, member };
  }

  // ---- 外から届く口 ----
  async function handle(req, res, url) {
    const p = url.pathname;
    if (p === "/api/me" && req.method === "GET") {
      const u = userFromReq(req);
      return json(res, 200, {
        enabled: !!Object.keys(prov).length,
        providers: Object.fromEntries(Object.entries(prov).map(([k, P]) => [k, P.label])),
        guild: !!guild,
        user: u,
      }), true;
    }
    let m;
    if ((m = p.match(/^\/auth\/(discord|google)\/start$/)) && req.method === "GET") {
      const P = prov[m[1]];
      if (!P) return json(res, 404, { why: "このログイン方法は使えません" }), true;
      if (limited(req, "start", 20)) return json(res, 429, { why: "少し待ってからやり直してください" }), true;
      sweepPending();
      const intent = url.searchParams.get("intent") === "link" ? "link" : "login";
      const me = intent === "link" ? userFromReq(req) : null;
      if (intent === "link" && !me) return toAccount(res, "relogin"), true;
      const state = b64u(crypto.randomBytes(24)),
        verifier = P.pkce ? b64u(crypto.randomBytes(32)) : null;
      pending.set(state, {
        p: m[1], intent, verifier, exp: now() + STATE_MS,
        invite: String(url.searchParams.get("invite") || "").slice(0, 100),
        next: safeNext(url.searchParams.get("next")),
        userId: me && me.id,
      });
      const q = new URLSearchParams({ client_id: P.id, redirect_uri: P.redirect, response_type: "code", scope: P.scope, state });
      if (verifier) {
        q.set("code_challenge", b64u(crypto.createHash("sha256").update(verifier).digest()));
        q.set("code_challenge_method", "S256");
      }
      if (P === prov.discord && intent !== "link") q.set("prompt", "none"); // 一度許可していれば、確認画面を出さない（連携は毎回確かめる）
      return redirect(res, P.authorize + "?" + q, { "set-cookie": cookie("alp_oa", state, STATE_MS / 1000) }), true;
    }
    if ((m = p.match(/^\/auth\/(discord|google)\/callback$/)) && req.method === "GET") {
      const P = prov[m[1]];
      if (!P) return json(res, 404, { why: "このログイン方法は使えません" }), true;
      if (limited(req, "callback", 20)) return json(res, 429, { why: "少し待ってからやり直してください" }), true;
      const state = url.searchParams.get("state") || "",
        st = pending.get(state),
        clear = { "set-cookie": cookie("alp_oa", "", 0) };
      // 同じブラウザで始めたログインか（Cookie の state と一致するか）。一致しなければ横取りの疑い
      if (!st || st.exp < now() || st.p !== m[1] || parseCookies(req.headers.cookie).alp_oa !== state) return toAccount(res, "state", clear), true;
      pending.delete(state);
      if (url.searchParams.get("error")) return toAccount(res, "cancel", clear), true;
      let who;
      try {
        who = await exchange(P, url.searchParams.get("code") || "", st.verifier);
      } catch (e) {
        log("auth: 外部サービスとのやりとりに失敗", m[1], e.message);
        return toAccount(res, "provider", clear), true;
      }
      const ident = { provider: m[1], sub: who.sub, name: who.name, avatar: who.avatar };
      if (st.intent === "link") {
        // 始めたときと同じ人が、今もログインしているときだけ紐づける
        const cur = userFromReq(req);
        if (!cur || cur.id !== st.userId) return toAccount(res, "relogin", clear), true;
        const r = accounts.linkExternal(st.userId, ident);
        if (r.error) return toAccount(res, r.code || "relogin", clear), true;
        log("auth: link", m[1], st.userId);
        return toAccount(res, "linked", clear), true;
      }
      const r = accounts.loginExternal(ident, { invite: st.invite, autoJoin: who.member });
      if (r.error) return toAccount(res, r.code === "disabled" ? "disabled" : st.invite ? "badinvite" : P === prov.discord && guild ? "notmember" : "needinvite", clear), true;
      log("auth: login", m[1], r.user.id, r.user.name);
      return login(req, res, r.user.id, st.next), true;
    }
    // 緊急ログインリンク（管理用の口で出したもの。1回だけ使える）
    // GET は確認のページを出すだけ。ボタンを押した POST で初めて使う（リンクのプレビューなどが先に開いても消費されない）
    if (p === "/auth/link" && (req.method === "GET" || req.method === "POST")) {
      if (req.method === "POST" && !sameOrigin(req)) return json(res, 403, { why: "このページからは操作できません" }), true;
      if (limited(req, "link", 20)) return json(res, 429, { why: "少し待ってからやり直してください" }), true;
      sweepPending();
      const t = url.searchParams.get("t") || "", k = sha(t), l = links.get(k), lu = l && accounts.getUser(l.userId);
      if (!l || l.exp < now() || !lu || lu.disabled) return toAccount(res, "badlink"), true;
      if (req.method === "GET") {
        // Origin を付けて送るため、このページだけ referrer-policy を same-origin にする（no-referrer だと Origin が null になる）
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "same-origin", "x-frame-options": "DENY" });
        res.end(
          `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ログイン</title>` +
            `<form method="post" action="link?t=${encodeURIComponent(t)}"><p>緊急ログインリンクです。</p><button>ログインする</button></form></html>`,
        );
        return true;
      }
      links.delete(k);
      log("auth: emergency login", l.userId);
      return login(req, res, l.userId, safeNext("account.html")), true;
    }
    // ---- ここから下は書き込み（このサイトのページからだけ） ----
    if (req.method !== "POST" || !(p === "/auth/logout" || p.startsWith("/api/me") || p.startsWith("/api/admin/"))) return false;
    if (!sameOrigin(req)) return json(res, 403, { why: "このページからは操作できません" }), true;
    if (limited(req, "post", 60)) return json(res, 429, { why: "少し待ってからやり直してください" }), true;
    const me = userFromReq(req);
    if (p === "/auth/logout") {
      accounts.endSession(sid(req));
      return json(res, 200, { ok: 1 }, { "set-cookie": cookie("alp_sid", "", 0) }), true;
    }
    if (!me) return json(res, 401, { why: "ログインしてください" }), true;
    const b = await readJson(req);
    if (!b) return json(res, 400, { why: "送信内容が読めません" }), true;
    const reply = (r) => json(res, r.error ? 400 : 200, r.error ? { why: r.error } : r);
    if (p === "/api/me") return reply(accounts.rename(me.id, b.name)), true;
    if (p === "/api/me/unlink") return reply(accounts.unlinkExternal(me.id, String(b.provider || ""))), true;
    if (p === "/api/me/logout-all") return reply({ ended: accounts.endUserSessions(me.id) }), true;
    if (p === "/api/me/share") return reply(accounts.setShare(me.id, !!b.on)), true;
    // 管理者だけ
    if (me.role !== "admin") return json(res, 403, { why: "管理者だけが使えます" }), true;
    if (p === "/api/admin/users") return reply({ users: accounts.listUsers() }), true;
    if (p === "/api/admin/invite") {
      const iv = accounts.createInvite(b.role, me.id);
      log("auth: invite by", me.id, b.role === "admin" ? "admin" : "member");
      return reply({ url: inviteUrl(iv.token), expiresAt: iv.expiresAt }), true;
    }
    if (p === "/api/admin/role") return reply(accounts.setRole(String(b.id || ""), b.role)), true;
    if (p === "/api/admin/disable") return reply(b.id === me.id ? { error: "自分は止められません" } : accounts.setDisabled(String(b.id || ""), !!b.on)), true;
    if (p === "/api/admin/logout") return reply({ ended: accounts.endUserSessions(String(b.id || "")) }), true;
    return json(res, 404, { why: "not found" }), true;
  }
  const inviteUrl = (t) => new URL("account.html?invite=" + encodeURIComponent(t), pub).href;

  // ---- VPS の中からだけ届く管理用の口（npm run admin が使う） ----
  function startLocalAdmin(port) {
    const srv = http.createServer(async (req, res) => {
      let u;
      try {
        u = new URL(req.url, "http://x");
      } catch (e) {
        return json(res, 400, { why: "bad request" });
      }
      if (req.method === "GET" && u.pathname === "/users") return json(res, 200, { users: accounts.listUsers() });
      if (req.method !== "POST") return json(res, 404, { why: "not found" });
      // ブラウザから（別のサイトに仕込まれて）呼ばれないよう、Origin 付きは断る
      if (req.headers.origin) return json(res, 403, { why: "forbidden" });
      const b = (await readJson(req)) || {};
      if (!pub) return json(res, 400, { why: "PUBLIC_URL が設定されていません" });
      if (u.pathname === "/invite") {
        const iv = accounts.createInvite(b.role, null);
        log("auth: invite (local)", b.role === "admin" ? "admin" : "member");
        return json(res, 200, { url: inviteUrl(iv.token), expiresAt: iv.expiresAt, role: b.role === "admin" ? "admin" : "member" });
      }
      if (u.pathname === "/login-link") {
        const who = accounts.listUsers().find((x) => x.id === b.user || x.name.toLowerCase() === String(b.user || "").toLowerCase());
        if (!who) return json(res, 404, { why: "その人は見つかりません" });
        const t = b64u(crypto.randomBytes(32));
        links.set(sha(t), { userId: who.id, exp: now() + LINK_MS });
        log("auth: login link (local)", who.id);
        return json(res, 200, { url: new URL("auth/link?t=" + t, pub).href, user: who.name, expiresAt: now() + LINK_MS });
      }
      return json(res, 404, { why: "not found" });
    });
    return new Promise((resolve) => srv.listen(port, "127.0.0.1", () => resolve(srv)));
  }

  return { handle, userFromReq, browserSid, browserUser, readerUser, startLocalAdmin, enabled: () => !!Object.keys(prov).length, providers: () => Object.keys(prov) };
}

module.exports = { createAuth, parseCookies, PROVIDERS };
