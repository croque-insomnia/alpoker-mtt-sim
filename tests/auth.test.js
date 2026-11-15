// 外部ログイン（Discord / Google）を、偽の Discord・Google を立てて最初から最後まで通す
const test = require("node:test");
const assert = require("node:assert");
const http = require("http"),
  crypto = require("crypto");
const { startServer } = require("../server/server.js");
const { openAccounts } = require("../server/accounts.js");

const GUILD = "999";
// 偽の外部サービス。code ごとに「誰としてログインしたか」を決めておく
async function fakeProviders(t) {
  const people = {}, // code -> { provider, profile, guilds }
    tokens = {}, // access_token -> code
    challenges = {}, // state -> code_challenge（Google の PKCE を確かめる）
    seen = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const send = (code, obj) => (res.writeHead(code, { "content-type": "application/json" }), res.end(JSON.stringify(obj)));
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      seen.push(u.pathname);
      if (u.pathname.endsWith("/token")) {
        const f = new URLSearchParams(b), who = people[f.get("code")];
        // 本物と同じく、秘密鍵が違えば 401 invalid_client、コードが違えば 400 invalid_grant
        if (who && f.get("client_secret") !== who.provider + "-secret") return send(401, { error: "invalid_client", error_description: "The provided client secret is invalid." });
        if (!who || f.get("grant_type") !== "authorization_code") return send(400, { error: "invalid_grant" });
        if (!String(f.get("redirect_uri")).endsWith(`/auth/${who.provider}/callback`)) return send(400, { error: "redirect" });
        if (who.provider === "google") {
          const ch = crypto.createHash("sha256").update(f.get("code_verifier") || "").digest("base64url");
          if (ch !== who.challenge) return send(400, { error: "pkce" });
        }
        const at = crypto.randomBytes(8).toString("hex");
        tokens[at] = f.get("code");
        delete people[f.get("code")]; // code は1回だけ
        tokens[at + "who"] = who;
        return send(200, { access_token: at, token_type: "Bearer" });
      }
      const at = String(req.headers.authorization || "").replace("Bearer ", ""), who = tokens[at + "who"];
      if (!who) return send(401, {});
      if (u.pathname.endsWith("/me")) return send(200, who.profile);
      if (u.pathname.endsWith("/guilds")) return send(200, (who.guilds || []).map((id) => ({ id })));
      send(404, {});
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  return {
    providers: {
      discord: { authorize: base + "/discord/authorize", token: base + "/discord/token", me: base + "/discord/me", guilds: base + "/discord/guilds" },
      google: { authorize: base + "/google/authorize", token: base + "/google/token", me: base + "/google/me" },
    },
    // 外部サービスで「許可」を押したことにする。戻り先の URL を返す
    approve(authorizeUrl, provider, profile, guilds) {
      const u = new URL(authorizeUrl), code = crypto.randomBytes(6).toString("hex");
      people[code] = { provider, profile, guilds, challenge: u.searchParams.get("code_challenge") };
      return { url: `${u.searchParams.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(u.searchParams.get("state"))}`, params: u.searchParams };
    },
    deny(authorizeUrl) {
      const u = new URL(authorizeUrl);
      return `${u.searchParams.get("redirect_uri")}?error=access_denied&state=${encodeURIComponent(u.searchParams.get("state"))}`;
    },
    seen,
  };
}

async function boot(t, extra = {}) {
  const fp = await fakeProviders(t);
  const accounts = openAccounts();
  // PUBLIC_URL は実際の待ち受けポートが決まってから作るので、いったん仮で立ててから立て直す
  const tmp = await startServer({ PORT: 0, HOST: "127.0.0.1", quiet: 1, accounts, store: { get: () => null, set() {} } });
  const port = tmp.port;
  await tmp.close();
  const srv = await startServer({
    PORT: port, HOST: "127.0.0.1", quiet: 1, accounts, store: { get: () => null, set() {} },
    PUBLIC_URL: `http://127.0.0.1:${port}/`, ADMIN_PORT: "auto",
    DISCORD_CLIENT_ID: "d-id", DISCORD_CLIENT_SECRET: "discord-secret", DISCORD_GUILD_ID: GUILD,
    GOOGLE_CLIENT_ID: "g-id", GOOGLE_CLIENT_SECRET: "google-secret",
    providers: fp.providers,
    ...extra,
  });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${port}/`;
  // Cookie を覚えておくブラウザ役
  const browser = () => {
    const jar = {};
    const go = async (url, o = {}) => {
      const r = await fetch(new URL(url, base), {
        redirect: "manual",
        ...o,
        headers: { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; "), ...(o.headers || {}) },
      });
      for (const c of r.headers.getSetCookie()) {
        const [kv, ...attrs] = c.split("; "), [k, v] = kv.split("=");
        if (/Max-Age=0/.test(c) || !v) delete jar[k];
        else jar[k] = v;
        if (k == "alp_sid" && v) assert.ok(attrs.includes("HttpOnly") && attrs.includes("SameSite=Lax"), "セッションの Cookie は HttpOnly・SameSite=Lax");
      }
      return r;
    };
    const post = (p, body, origin = new URL(base).origin) =>
      go(p, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body || {}) });
    const me = async () => (await (await go("api/me")).json()).user;
    // ログインの流れ全体：start → 外部サービスで許可 → callback
    const login = async (provider, profile, { invite, guilds, intent } = {}) => {
      const q = new URLSearchParams({ ...(invite ? { invite } : {}), ...(intent ? { intent } : {}), next: "./" });
      const s = await go(`auth/${provider}/start?${q}`);
      assert.equal(s.status, 302);
      const a = fp.approve(s.headers.get("location"), provider, profile, guilds);
      const c = await go(a.url);
      return { status: c.status, to: c.headers.get("location"), params: a.params };
    };
    return { go, post, me, login, jar };
  };
  const local = (p, body) =>
    fetch(`http://127.0.0.1:${srv.adminPort}${p}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) }).then((r) => r.json());
  return { srv, base, fp, browser, local, accounts };
}
const D = (id, name) => ({ id, username: name.toLowerCase(), global_name: name, avatar: null });
const G = (sub, name) => ({ sub, name, picture: "https://example.com/p.png" });

test("ログインの設定がなければ、ログインは無効のまま", async (t) => {
  const srv = await startServer({ PORT: 0, HOST: "127.0.0.1", quiet: 1, accounts: openAccounts(), store: { get: () => null, set() {} } });
  t.after(() => srv.close());
  const me = await fetch(`http://127.0.0.1:${srv.port}/api/me`).then((r) => r.json());
  assert.deepEqual(me, { enabled: false, providers: {}, guild: false, user: null });
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}/auth/discord/start`, { redirect: "manual" })).status, 404);
});

test("最初の管理者：管理用の口で招待を出し、そのリンクから Google で入る", async (t) => {
  const { browser, local, base } = await boot(t);
  const iv = await local("/invite", { role: "admin" });
  assert.equal(iv.role, "admin");
  assert.ok(iv.url.startsWith(base + "account.html?invite="));
  const invite = new URL(iv.url).searchParams.get("invite");
  const b = browser();
  const r = await b.login("google", G("g-1", "Kaina"), { invite });
  assert.equal(r.status, 302);
  assert.equal(r.to, "/", "元のページへ戻る");
  // Google には PKCE と最小の権限だけを頼む（メールは頼まない）
  assert.equal(r.params.get("code_challenge_method"), "S256");
  assert.equal(r.params.get("scope"), "openid profile");
  const me = await b.me();
  assert.equal(me.name, "Kaina");
  assert.equal(me.role, "admin");
  assert.deepEqual(me.identities.map((i) => i.provider), ["google"]);
  assert.ok(!JSON.stringify(me).includes("g-1"), "外部サービスでの ID は画面に返さない");
  // 同じ招待は2回使えない
  const r2 = await browser().login("google", G("g-2", "Other"), { invite });
  assert.equal(r2.to, "/account.html?r=badinvite");
});

test("Discord：身内サーバーのメンバーは招待なしで入れる。メンバーでなければ入れない", async (t) => {
  const { browser } = await boot(t);
  const a = browser();
  const r = await a.login("discord", D("d-1", "Croque"), { guilds: ["1", GUILD] });
  assert.equal(r.to, "/");
  assert.equal(r.params.get("scope"), "identify guilds");
  assert.equal((await a.me()).role, "member");
  const b = browser();
  const r2 = await b.login("discord", D("d-2", "Stranger"), { guilds: ["1"] });
  assert.equal(r2.to, "/account.html?r=notmember");
  assert.equal(await b.me(), null);
  // Google は招待なしでは入れない
  const c = browser();
  assert.equal((await c.login("google", G("g-9", "Nobody"))).to, "/account.html?r=needinvite");
});

test("2回目からは同じ人としてログインし、別の端末でも同じアカウントになる", async (t) => {
  const { browser } = await boot(t);
  const a = browser();
  await a.login("discord", D("d-1", "Croque"), { guilds: [GUILD] });
  const id = (await a.me()).id;
  const pc = browser();
  await pc.login("discord", D("d-1", "Croque!"), { guilds: [] }); // 2回目はメンバーかどうかを問わない
  const me = await pc.me();
  assert.equal(me.id, id);
  assert.equal(me.name, "Croque", "表示名は外部サービス側で変えても上書きしない");
});

test("Google を連携すると、どちらからでも同じ人として入れる。他の人の外部アカウントは連携できない", async (t) => {
  const { browser, local } = await boot(t);
  const a = browser();
  await a.login("discord", D("d-1", "Kaina"), { guilds: [GUILD] });
  const id = (await a.me()).id;
  // 連携はログイン中だけ
  const r = await a.login("google", G("g-1", "Kaina G"), { intent: "link" });
  assert.equal(r.to, "/account.html?r=linked");
  assert.deepEqual((await a.me()).identities.map((i) => i.provider).sort(), ["discord", "google"]);
  const pc = browser();
  await pc.login("google", G("g-1", "Kaina G"));
  assert.equal((await pc.me()).id, id);
  // 別の人：招待から Google で入り、Kaina の Discord を連携しようとする
  const iv = new URL((await local("/invite", {})).url).searchParams.get("invite");
  const b = browser();
  await b.login("google", G("g-2", "Bob"), { invite: iv });
  const r2 = await b.login("discord", D("d-1", "Kaina"), { intent: "link" });
  assert.equal(r2.to, "/account.html?r=taken");
  // ログインしていなければ連携は始まらない
  const c = browser();
  const s = await c.go("auth/google/start?intent=link");
  assert.equal(s.headers.get("location"), "/account.html?r=relogin");
});

test("連携を外せる（最後の1つは外せない）", async (t) => {
  const { browser } = await boot(t);
  const a = browser();
  await a.login("discord", D("d-1", "Kaina"), { guilds: [GUILD] });
  let r = await a.post("api/me/unlink", { provider: "discord" });
  assert.equal(r.status, 400);
  await a.login("google", G("g-1", "K"), { intent: "link" });
  r = await a.post("api/me/unlink", { provider: "discord" });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).user.identities.map((i) => i.provider), ["google"]);
});

test("ログインの横取りを防ぐ：state が違う・Cookie がない・外部サービスで取りやめた", async (t) => {
  const { browser, fp } = await boot(t);
  const a = browser();
  const s = await a.go("auth/discord/start");
  const ok = fp.approve(s.headers.get("location"), "discord", D("d-1", "X"), [GUILD]);
  // 別のブラウザ（Cookie なし）で戻り先を開かされた
  const evil = browser();
  assert.equal((await evil.go(ok.url)).headers.get("location"), "/account.html?r=state");
  // state を書き換えた
  assert.equal((await a.go(ok.url.replace(/state=[^&]+/, "state=zzz"))).headers.get("location"), "/account.html?r=state");
  // 外部サービスで「キャンセル」
  const s2 = await a.go("auth/discord/start");
  assert.equal((await a.go(fp.deny(s2.headers.get("location")))).headers.get("location"), "/account.html?r=cancel");
  assert.equal(await a.me(), null);
});

test("外部サービスとのやりとりに失敗したら、ログインさせない", async (t) => {
  const { browser, fp } = await boot(t);
  const a = browser();
  const s = await a.go("auth/google/start");
  const u = new URL(s.headers.get("location"));
  // 偽の code（外部サービスが知らない）
  const r = await a.go(`${u.searchParams.get("redirect_uri")}?code=bogus&state=${encodeURIComponent(u.searchParams.get("state"))}`);
  assert.equal(r.headers.get("location"), "/account.html?r=provider");
  assert.equal(await a.me(), null);
});

test("戻り先は、このアプリの中だけ", async (t) => {
  const { browser, fp } = await boot(t);
  for (const [next, want] of [
    ["https://evil.example/", "/account.html"],
    ["//evil.example/x", "/account.html"],
    ["/.//evil.example/x", "/account.html"],
    ["./?r=alp-1", "/?r=alp-1"],
  ]) {
    const a = browser();
    const s = await a.go("auth/discord/start?next=" + encodeURIComponent(next));
    const ok = fp.approve(s.headers.get("location"), "discord", D("d-1", "Kaina"), [GUILD]);
    assert.equal((await a.go(ok.url)).headers.get("location"), want, next);
  }
});

test("書き込みは、このサイトのページからだけ。ログアウトでセッションが消える", async (t) => {
  const { browser } = await boot(t);
  const a = browser();
  await a.login("discord", D("d-1", "Kaina"), { guilds: [GUILD] });
  assert.equal((await a.post("api/me", { name: "Hacked" }, "https://evil.example")).status, 403);
  assert.equal((await a.post("api/me", { name: "Hacked" }, "")).status, 403);
  assert.equal((await a.go("api/me", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 403, "Origin なしは断る");
  assert.equal((await a.post("api/me", { name: "かいな" })).status, 200);
  assert.equal((await a.me()).name, "かいな");
  const sid = a.jar.alp_sid;
  assert.equal((await a.post("auth/logout")).status, 200);
  assert.equal(await a.me(), null);
  // 消したセッションの合言葉を使い回しても入れない
  a.jar.alp_sid = sid;
  assert.equal(await a.me(), null);
});

test("表示名：重なると番号が付く・変えるときは重なりを断る・HTML に使う文字は落とす", async (t) => {
  const { browser } = await boot(t);
  const a = browser(), b = browser();
  await a.login("discord", D("d-1", "Kaina"), { guilds: [GUILD] });
  await b.login("discord", D("d-2", "kaina"), { guilds: [GUILD] });
  assert.equal((await b.me()).name, "kaina2");
  assert.equal((await b.post("api/me", { name: "KAINA" })).status, 400);
  await b.post("api/me", { name: "<b>Bob</b>" });
  assert.equal((await b.me()).name, "bBob/b");
});

test("管理者だけが招待・役割の変更・ログアウトさせるを使える", async (t) => {
  const { browser, local } = await boot(t);
  const admin = browser(), m = browser();
  await admin.login("google", G("g-1", "Kaina"), { invite: new URL((await local("/invite", { role: "admin" })).url).searchParams.get("invite") });
  await m.login("discord", D("d-1", "Croque"), { guilds: [GUILD] });
  assert.equal((await m.post("api/admin/invite", { role: "admin" })).status, 403);
  assert.equal((await m.post("api/admin/users")).status, 403);
  const users = (await (await admin.post("api/admin/users")).json()).users;
  assert.deepEqual(users.map((u) => [u.name, u.role]), [["Kaina", "admin"], ["Croque", "member"]]);
  // メンバー用の招待
  const iv = await (await admin.post("api/admin/invite", { role: "member" })).json();
  const g = browser();
  await g.login("google", G("g-5", "Guest"), { invite: new URL(iv.url).searchParams.get("invite") });
  assert.equal((await g.me()).role, "member");
  // 役割を変える。最後の管理者は外せない
  const kaina = users[0], croque = users[1];
  assert.equal((await admin.post("api/admin/role", { id: kaina.id, role: "member" })).status, 400);
  assert.equal((await admin.post("api/admin/role", { id: croque.id, role: "admin" })).status, 200);
  assert.equal((await m.me()).role, "admin");
  // ログアウトさせる
  assert.equal((await (await admin.post("api/admin/logout", { id: croque.id })).json()).ended, 1);
  assert.equal(await m.me(), null);
  // 止める：管理者は止められない。止めた人は入り直せず、解けば戻れる。おかしな id は受け付けない
  assert.equal((await admin.post("api/admin/disable", { id: croque.id, on: true })).status, 400);
  assert.equal((await admin.post("api/admin/role", { id: "__proto__", role: "admin" })).status, 400);
  assert.equal({}.role, undefined);
  const guest = (await (await admin.post("api/admin/users")).json()).users.find((u) => u.name == "Guest");
  assert.equal((await admin.post("api/admin/disable", { id: guest.id, on: true })).status, 200);
  assert.equal(await g.me(), null);
  assert.equal((await g.login("google", G("g-5", "Guest"))).to, "/account.html?r=disabled");
  assert.equal((await admin.post("api/admin/disable", { id: guest.id, on: false })).status, 200);
  await g.login("google", G("g-5", "Guest"));
  assert.equal((await g.me()).name, "Guest");
});

test("緊急ログインリンク：管理用の口で出し、1回だけ使える", async (t) => {
  const { browser, local } = await boot(t);
  const a = browser();
  await a.login("discord", D("d-1", "Kaina"), { guilds: [GUILD] });
  assert.equal((await local("/login-link", { user: "nobody" })).why, "その人は見つかりません");
  const l = await local("/login-link", { user: "kaina" });
  const pc = browser();
  // 開いただけ（リンクのプレビューなど）では使われない。確認のページでボタンを押すと入れる
  const page = await pc.go(l.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<form method="post"/);
  assert.equal(await pc.me(), null);
  assert.equal((await pc.go(l.url, { method: "POST", headers: { origin: "https://evil.example" } })).status, 403);
  const r = await pc.go(l.url, { method: "POST", headers: { origin: new URL(l.url).origin } });
  assert.equal(r.status, 302);
  assert.equal((await pc.me()).name, "Kaina");
  const again = browser();
  assert.equal((await again.go(l.url)).headers.get("location"), "/account.html?r=badlink");
});

test("管理用の口は、Origin 付きのリクエストを断る", async (t) => {
  const { srv } = await boot(t);
  const r = await fetch(`http://127.0.0.1:${srv.adminPort}/invite`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" });
  assert.equal(r.status, 403);
});

test("回数制限：短い間に何度もログインを始めると断る", async (t) => {
  const { browser } = await boot(t);
  const a = browser();
  let last;
  for (let i = 0; i < 25; i++) last = await a.go("auth/discord/start");
  assert.equal(last.status, 429);
});

test("アカウントは保存され、サーバーを立て直しても残る（ファイルは本人だけが読める）", async (t) => {
  const os = require("os"), fs = require("fs"), path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alp-acc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "accounts.json");
  const acc = openAccounts(file);
  const iv = acc.createInvite("admin");
  const r = acc.loginExternal({ provider: "google", sub: "g-1", name: "Kaina" }, { invite: iv.token });
  const s = acc.createSession(r.user.id, "test");
  acc.flush();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes(s.token) && !raw.includes(iv.token), "合言葉そのものは保存しない");
  const again = openAccounts(file);
  assert.equal(again.sessionUser(s.token).name, "Kaina");
  assert.ok(again.hasAdmin());
});

test("読めない Cookie や URL が来ても落ちない", async (t) => {
  const { browser, base } = await boot(t);
  const a = browser();
  await a.login("discord", D("d-1", "Kaina"), { guilds: [GUILD] });
  a.jar.other = "50%";
  assert.equal((await a.me()).name, "Kaina");
  // "//" は fetch では送れないので、生の HTTP で送る
  const net = require("net"), u = new URL(base);
  const status = await new Promise((resolve, reject) => {
    const s = net.connect(+u.port, u.hostname, () => s.write("GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
    let b = "";
    s.on("data", (c) => (b += c));
    s.on("end", () => resolve(b.split(" ")[1]));
    s.on("error", reject);
  });
  assert.equal(status, "400");
  assert.equal((await a.me()).name, "Kaina");
});

test("連携：途中でログアウトしていたら、紐づけない", async (t) => {
  const { browser, fp } = await boot(t);
  const a = browser();
  await a.login("discord", D("d-1", "Kaina"), { guilds: [GUILD] });
  const s = await a.go("auth/google/start?intent=link");
  await a.post("api/me/logout-all");
  const ok = fp.approve(s.headers.get("location"), "google", G("g-1", "Kaina"));
  assert.equal((await a.go(ok.url)).headers.get("location"), "/account.html?r=relogin");
});

test("accounts.json が壊れていたら、空で上書きせずに止まる", () => {
  const os = require("os"), fs = require("fs"), path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alp-acc-"));
  const file = path.join(dir, "accounts.json");
  fs.writeFileSync(file, '{"users":{"u1":');
  assert.throws(() => openAccounts(file), /読めません/);
  assert.equal(fs.readFileSync(file, "utf8"), '{"users":{"u1":');
  fs.rmSync(dir, { recursive: true, force: true });
});

test("外部サービスに断られたときは、エラーの種類だけをログに出す（秘密鍵は出さない）", async (t) => {
  const lines = [];
  const { browser } = await boot(t, { GOOGLE_CLIENT_SECRET: "wrong-secret-value", log: (...a) => lines.push(a.join(" ")) });
  const a = browser();
  const r = await a.login("google", G("g-1", "Kaina"));
  assert.equal(r.to, "/account.html?r=provider");
  const hit = lines.find((l) => l.includes("外部サービスとのやりとりに失敗"));
  assert.ok(hit && /google token 401 invalid_client/.test(hit), hit);
  assert.ok(!lines.join("\n").includes("wrong-secret-value"), "秘密鍵はログに出さない");
  assert.ok(!lines.join("\n").includes("The provided client secret"), "説明文も出さない");
});
