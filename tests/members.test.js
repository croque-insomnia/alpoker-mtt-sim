// 段階2：ログインしている人（アカウント）で部屋を作り・入る。ゲストとの混在、なりすまし防止、記録のアカウント ID
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const WebSocket = require("ws");
const { startServer } = require("../server/server.js");
const { openAccounts } = require("../server/accounts.js");
const { wsLink, joinRoom } = require("../net.js");

const until = async (f, ms = 3000) => {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};
async function boot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alp-mem-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const accounts = openAccounts();
  // PUBLIC_URL は待ち受けのポートが決まってから作る（Origin の確認に使う）
  const tmp = await startServer({ PORT: 0, HOST: "127.0.0.1", quiet: 1, accounts, store: { get: () => null, set() {} } });
  const port = tmp.port;
  await tmp.close();
  const srv = await startServer({
    PORT: port, HOST: "127.0.0.1", quiet: 1, accounts, store: { get: () => null, set() {} }, DATA_DIR: dir, CREATE_KEY: "key",
    PUBLIC_URL: `http://127.0.0.1:${port}/`,
  });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${port}/`, origin = `http://127.0.0.1:${port}`;
  // アカウントを作ってログインした状態（セッションの合言葉）を返す
  const member = (name, role = "member") => {
    const iv = accounts.createInvite(role);
    const { user } = accounts.loginExternal({ provider: "discord", sub: name + "-id", name }, { invite: iv.token });
    return { user, sid: accounts.createSession(user.id, "test").token };
  };
  // その人のブラウザ役：Cookie と Origin を付けて WebSocket・HTTP を使う
  const as = (m, o = {}) => {
    class WS extends WebSocket {
      constructor(url) {
        super(url, { headers: { ...(m ? { cookie: "alp_sid=" + m.sid } : {}), origin: o.origin || origin } });
      }
    }
    const link = wsLink(base, WS);
    return {
      create: (body) =>
        fetch(base + "api/rooms", {
          method: "POST",
          headers: { "content-type": "application/json", origin: o.origin || origin, ...(m ? { cookie: "alp_sid=" + m.sid } : {}) },
          body: JSON.stringify(body),
        }).then(async (r) => ({ status: r.status, ...(await r.json()) })),
      join(room, j = {}) {
        const c = { ev: [], views: [], raw: [] };
        c.last = (k) => c.ev.filter((e) => e[0] == k).pop();
        c.j = joinRoom(link, room, { role: "player", ...j }, {
          joined: (x) => c.ev.push(["joined", x]),
          roster: (x) => c.ev.push(["roster", x]),
          msg: (x) => (c.ev.push(["msg", x]), c.raw.push(JSON.stringify(x)), x.t == "view" && c.views.push(x.v)),
          error: (why, fatal) => c.ev.push(["error", why, fatal]),
          closed: (why) => c.ev.push(["closed", why]),
        });
        return c;
      },
    };
  };
  return { srv, accounts, member, as, dir };
}

test("ログインしている人は、合言葉なしで「メンバー専用」の部屋を作れる。名前もパスワードも要らない", async (t) => {
  const { srv, member, as } = await boot(t);
  const kaina = member("Kaina"), croque = member("Croque");
  const r = await as(kaina).create({ guests: false });
  assert.equal(r.status, 200);
  assert.ok(r.room && !r.adm, "作った人の合言葉は要らない（アカウントで分かる）");
  const A = as(kaina).join(r.room);
  await until(() => A.last("joined"));
  const ok = A.last("joined")[1];
  assert.deepEqual([ok.name, ok.admin, ok.member, ok.role], ["Kaina", 1, 1, "player"]);
  const B = as(croque).join(r.room, { name: "なんでも", pw: "" });
  await until(() => B.last("joined"));
  assert.deepEqual([B.last("joined")[1].name, B.last("joined")[1].admin], ["Croque", 0]);
  // ゲストは入れない
  const G = as(null).join(r.room, { name: "Guest", pw: "" });
  await until(() => G.last("error"));
  assert.match(G.last("error")[1], /メンバー専用/);
  assert.equal(G.last("error")[2], 1);
  // 作った人が開始できる。作っていないメンバーはできない
  B.j.send({ t: "admin", a: "start", dur: 5 });
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!srv.rooms.get(r.room).host.room.started());
  A.j.send({ t: "admin", a: "start", dur: 5 });
  await until(() => A.views.length && B.views.length);
  [A, B].forEach((c) => c.j.leave());
});

test("ゲストも入れる部屋：ゲストはパスワードで入る。メンバーの名前は使えない", async (t) => {
  const { member, as } = await boot(t);
  const kaina = member("Kaina");
  assert.equal((await as(kaina).create({ guests: true })).status, 400, "ゲストを入れるならパスワードが要る");
  const { room } = await as(kaina).create({ guests: true, pw: "gpw" });
  const A = as(kaina).join(room);
  await until(() => A.last("joined"));
  const bad = as(null).join(room, { name: "Guest", pw: "x" });
  await until(() => bad.last("error"));
  assert.match(bad.last("error")[1], /パスワード/);
  const fake = as(null).join(room, { name: "kaina", pw: "gpw" });
  await until(() => fake.last("error"));
  assert.match(fake.last("error")[1], /メンバーが使っています/);
  // まだその部屋にいないメンバーの名前も、ゲストは使えない
  member("Croque");
  const fake2 = as(null).join(room, { name: "CROQUE", pw: "gpw" });
  await until(() => fake2.last("error"));
  assert.match(fake2.last("error")[1], /メンバーが使っています/);
  const g = as(null).join(room, { name: "Guest", pw: "gpw" });
  await until(() => g.last("joined"));
  assert.deepEqual([g.last("joined")[1].name, g.last("joined")[1].member], ["Guest", 0]);
  [A, g].forEach((c) => c.j.leave());
});

test("別のサイトからの接続は、Cookie が付いていてもゲスト扱い（なりすまし防止）", async (t) => {
  const { member, as } = await boot(t);
  const kaina = member("Kaina");
  const { room } = await as(kaina).create({ guests: false });
  const evil = as(kaina, { origin: "https://evil.example" }).join(room);
  await until(() => evil.last("error"));
  assert.match(evil.last("error")[1], /メンバー専用/);
  // 部屋を作るのも、別のサイトからならログインしていない扱い（合言葉が要る）
  const r = await as(kaina, { origin: "https://evil.example" }).create({ guests: false });
  assert.equal(r.status, 403);
});

test("同じアカウントで別の画面から入ると、同じ席に戻り、前の画面は止まる（奪い合わない）", async (t) => {
  const { srv, member, as } = await boot(t);
  const kaina = member("Kaina");
  const { room } = await as(kaina).create({ guests: false });
  const pc = as(kaina).join(room);
  await until(() => pc.last("joined"));
  pc.j.send({ t: "admin", a: "start", dur: 5 });
  await until(() => pc.views.length);
  const g = srv.rooms.get(room).host.room.state(), me = g.P.find((p) => p.name == "Kaina");
  const phone = as(kaina).join(room);
  await until(() => phone.last("joined"));
  assert.equal(phone.last("joined")[1].back, 1);
  assert.equal(phone.last("joined")[1].admin, 1, "作った人の権限も一緒に移る");
  await until(() => pc.last("error"));
  assert.deepEqual(pc.last("error").slice(1), ["別の画面でこの部屋に入りました", 1], "前の画面には、入り直しても無駄な理由として伝わる");
  assert.equal(me.pid, phone.last("joined")[1].id);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(srv.rooms.get(room).host.roster().length, 1, "席は1つのまま");
  phone.j.leave();
});

test("退出させたアカウントは、その部屋に入り直せない", async (t) => {
  const { member, as } = await boot(t);
  const kaina = member("Kaina"), croque = member("Croque");
  const { room } = await as(kaina).create({ guests: false });
  const A = as(kaina).join(room), B = as(croque).join(room);
  await until(() => A.last("joined") && B.last("joined"));
  A.j.send({ t: "admin", a: "kick", id: B.last("joined")[1].id });
  await until(() => B.last("error"));
  const B2 = as(croque).join(room);
  await until(() => B2.last("error"));
  assert.match(B2.last("error")[1], /退出させられています/);
  A.j.leave();
});

test("サイトの管理者は、他の人が作った部屋でも開始・退出を操作できる", async (t) => {
  const { srv, member, as } = await boot(t);
  const croque = member("Croque"), boss = member("Boss", "admin");
  const { room } = await as(croque).create({ guests: false });
  const C = as(croque).join(room), A = as(boss).join(room);
  await until(() => C.last("joined") && A.last("joined"));
  assert.equal(A.last("joined")[1].admin, 1);
  A.j.send({ t: "admin", a: "start", dur: 5 });
  await until(() => srv.rooms.get(room).host.room.started());
  [A, C].forEach((c) => c.j.leave());
});

test("記録：サーバーのファイルにはアカウント ID と打ち方の記録が入り、参加者に送る履歴には入らない", async (t) => {
  const { srv, member, as, dir } = await boot(t);
  const kaina = member("Kaina");
  const { room } = await as(kaina).create({ guests: true, pw: "gpw" });
  const A = as(kaina).join(room), G = as(null).join(room, { name: "Guest", pw: "gpw" });
  await until(() => A.last("joined") && G.last("joined"));
  A.j.send({ t: "admin", a: "start", dur: 5 });
  // 何ハンドか打つ
  const g = () => srv.rooms.get(room).host.room.state();
  const act = (c) => {
    const v = c.views.at(-1);
    if (v && v.req && !v._sent) (v._sent = 1), c.j.send({ t: "act", a: { t: "c" } });
  };
  // 本物の時計なので、Kaina が配られたハンドが1つ終わるまでで十分（ゲストの卓のハンドが先に終わることもある）
  const mine = (H) => H.seats.some((s) => s.uid == kaina.user.id);
  await until(() => (act(A), act(G), g() && g().hist.some(mine)), 40000);
  // 参加者に送る履歴（大会中）にアカウント ID は入らない
  A.j.send({ t: "hands" });
  await until(() => A.raw.some((x) => x.includes('"t":"hands"')));
  const sent = A.raw.find((x) => x.includes('"t":"hands"'));
  assert.ok(JSON.parse(sent).h.length > 0);
  assert.ok(!sent.includes("uid") && !sent.includes(kaina.user.id), "アカウント ID は送らない");
  // サーバーのファイル
  srv.saveHands(room, g());
  const f = fs.readdirSync(path.join(dir, "hands"))[0];
  const body = JSON.parse(fs.readFileSync(path.join(dir, "hands", f), "utf8"));
  assert.equal(body.version, 2);
  const pk = body.players.find((p) => p.name == "Kaina"), pg = body.players.find((p) => p.name == "Guest");
  assert.equal(pk.uid, kaina.user.id);
  assert.equal(pg.uid, null);
  assert.ok(pk.stats.hands >= 1, "打ち方の記録（配られたハンド数など）");
  assert.ok(body.hands.some(mine), "ハンドの席にもアカウント ID");
  assert.ok(body.hands.every((H) => H.seats.every((s) => s.uid == null || s.uid == kaina.user.id)), "ゲスト・CPU の席には ID がない");
  [A, G].forEach((c) => c.j.leave());
});

test("ログインしていない人は、これまでどおり合言葉とパスワードで部屋を作れる", async (t) => {
  const { as } = await boot(t);
  const r = await as(null).create({ pw: "pw", key: "key" });
  assert.equal(r.status, 200);
  assert.ok(r.adm);
  assert.equal((await as(null).create({ pw: "pw", key: "bad" })).status, 403);
});

test("止めたアカウントは、部屋に入るときもログインしていない扱いになる", async (t) => {
  const { accounts, member, as } = await boot(t);
  const kaina = member("Kaina"), croque = member("Croque");
  const { room } = await as(kaina).create({ guests: false });
  accounts.setDisabled(croque.user.id, true);
  const C = as(croque).join(room);
  await until(() => C.last("error"));
  assert.match(C.last("error")[1], /メンバー専用/);
  assert.equal((await as(croque).create({ guests: false })).status, 403, "部屋も作れない（合言葉が要る）");
});
