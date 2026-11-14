// 入室の受付（room.js の createHost）。通信は使わず、send / close を記録するだけ
const test = require("node:test");
const assert = require("node:assert");
const { createHost } = require("../room.js");
const { fakeClock } = require("./helpers.js");

function setup(opt = {}) {
  const clock = fakeClock(), out = [], closed = [], local = [];
  let roster = [];
  const host = createHost({
    password: "pw",
    roomId: "alp-test",
    send: (id, m) => out.push([id, m]),
    close: (id) => closed.push(id),
    local: opt.noLocal ? null : { id: "alp-test", name: "Host", deliver: (m) => local.push(m) },
    onRoster: (r) => (roster = r),
    clock,
  });
  const last = (id, t) => out.filter(([i, m]) => i == id && (!t || m.t == t)).pop()?.[1];
  return { host, out, closed, local, clock, last, roster: () => roster };
}

test("パスワード・名前の確認", () => {
  const s = setup();
  s.host.data("c1", { t: "join", name: "A", pw: "x" });
  assert.equal(s.last("c1").t, "no");
  s.clock.run();
  assert.deepEqual(s.closed, ["c1"]);
  s.host.data("c2", { t: "join", name: "  ", pw: "pw" });
  assert.match(s.last("c2").why, /名前/);
  s.host.data("c3", { t: "join", name: "host", pw: "pw" });
  assert.match(s.last("c3").why, /使われています/, "ホストと同じ名前（大文字小文字は区別しない）");
  s.host.data("c4", { t: "join", name: "<b>Al&ice</b>", pw: "pw", role: "player" });
  const ok = s.last("c4", "ok");
  assert.equal(ok.name, "bAlice/b");
  assert.ok(ok.tok && ok.tok.length > 10);
  assert.equal(s.roster().length, 2);
});

test("同じ接続から2回目の join は無視する", () => {
  const s = setup();
  s.host.data("c1", { t: "join", name: "A", pw: "pw" });
  s.host.data("c1", { t: "join", name: "B", pw: "pw" });
  assert.equal(s.roster().length, 2);
});

test("参加者に届く一覧にはホストの印がない", () => {
  const s = setup();
  s.host.data("c1", { t: "join", name: "A", pw: "pw" });
  const r = s.last("c1", "roster").r;
  assert.ok(r.every((p) => !("host" in p)));
  assert.ok(!r.some((p) => p.id == "alp-test"), "ホストの id（＝部屋ID）は送らない");
});

test("開始後の入室は観戦のみ。開始前の人で大会を作る", () => {
  const s = setup();
  s.host.data("c1", { t: "join", name: "A", pw: "pw", role: "player" });
  s.host.data("c2", { t: "join", name: "S", pw: "pw", role: "spec" });
  assert.ok(s.host.start(5));
  assert.ok(!s.host.start(5), "2回は始められない");
  assert.equal(s.last("c1", "start").t, "start");
  assert.equal(s.local[0].t, "start");
  const g = s.host.room.state();
  assert.equal(g.P.filter((p) => p.hero).length, 2, "ホストと A");
  s.host.data("c3", { t: "join", name: "B", pw: "pw", role: "player" });
  assert.equal(s.last("c3", "ok").role, "spec");
  assert.ok(s.last("c3", "view"), "途中から入った観戦者にも画面が届く");
});

test("合言葉で入り直すと、同じ名前・同じ席に戻る", () => {
  const s = setup();
  s.host.data("c1", { t: "join", name: "A", pw: "pw", role: "player" });
  const tok = s.last("c1", "ok").tok;
  s.host.start(5);
  const a = s.host.room.state().P.find((p) => p.name == "A");
  s.host.closed("c1");
  assert.equal(a.away, 1);
  // 切断中の人の名前は他の人が使えない
  s.host.data("c2", { t: "join", name: "a", pw: "pw" });
  assert.equal(s.last("c2").t, "no");
  // 別の名前を入れても、合言葉があれば元の名前で戻る
  s.host.data("c3", { t: "join", name: "Other", pw: "pw", tok });
  const ok = s.last("c3", "ok");
  assert.equal(ok.name, "A");
  assert.equal(ok.role, "player");
  assert.equal(ok.back, 1);
  assert.equal(a.pid, "c3");
  assert.equal(a.away, 0);
  // パスワードが違えば合言葉があっても入れない
  s.host.data("c4", { t: "join", pw: "x", tok });
  assert.equal(s.last("c4").t, "no");
});

test("切断に気づく前に入り直したら、古い接続を閉じて置き換える", () => {
  const s = setup();
  s.host.data("c1", { t: "join", name: "A", pw: "pw" });
  const tok = s.last("c1", "ok").tok;
  s.host.data("c2", { t: "join", pw: "pw", tok });
  assert.deepEqual(s.closed, ["c1"]);
  assert.deepEqual(s.roster().map((p) => p.id), ["alp-test", "c2"]);
  // 古い接続からのメッセージはもう受け付けない
  s.host.data("c1", { t: "join", name: "Z", pw: "pw" });
  assert.equal(s.roster().length, 3, "c1 は新しい人として入り直すことはできる");
});

test("退出させた人は合言葉で戻れない", () => {
  const s = setup();
  s.host.data("c1", { t: "join", name: "A", pw: "pw" });
  const tok = s.last("c1", "ok").tok;
  s.host.kick("c1");
  assert.equal(s.last("c1", "kick").t, "kick");
  s.host.data("c1", { t: "join", name: "A", pw: "pw" });
  assert.equal(s.roster().length, 1, "閉じるまでの間に入り直させない");
  s.clock.run();
  assert.deepEqual(s.closed, ["c1"]);
  s.host.data("c2", { t: "join", name: "B", pw: "pw", tok });
  assert.equal(s.last("c2", "ok").name, "B", "合言葉は無効になり、新しい人として扱う");
});

test("入室前の接続のメッセージはゲームへ渡さない", () => {
  const s = setup();
  s.host.data("c1", { t: "join", name: "A", pw: "pw" });
  s.host.start(5);
  const before = s.out.length;
  s.host.data("zz", { t: "watch", i: 3 });
  assert.equal(s.out.length, before);
});

test("ホストがいない部屋（サーバー向け）でも動く", () => {
  const s = setup({ noLocal: true });
  s.host.data("c1", { t: "join", name: "A", pw: "pw", role: "player" });
  assert.equal(s.roster().length, 1);
  assert.ok(s.host.start(1));
  assert.ok(s.last("c1", "view"));
});
