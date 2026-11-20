// 段階3a：記録の DB（SQLite）。表の形・大会の記録・以前のファイルの取り込み・毎日の写し
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const WebSocket = require("ws");
const { openDb, backupDaily, MIGRATIONS } = require("../server/db.js");
const { openRecords } = require("../server/records.js");
const { createRoom } = require("../room.js");
const { startServer } = require("../server/server.js");
const { openAccounts } = require("../server/accounts.js");
const { wsLink, joinRoom } = require("../net.js");
const { fakeClock } = require("./helpers.js");

const tmpdir = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "alp-rec-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const until = async (f, ms = 3000) => {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("表の形：番号順に1回だけ当て、開き直しても同じ。知らない新しい形なら開かない", (t) => {
  const file = path.join(tmpdir(t), "a.db");
  const db = openDb(file);
  assert.equal(db.pragma("user_version", { simple: true }), MIGRATIONS.length);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(tables, ["entries", "hand_players", "hands", "spot_answers", "spot_favs", "spot_votes", "spots", "tournaments"]);
  assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, "本人だけが読める");
  db.close();
  const again = openDb(file);
  assert.equal(again.pragma("user_version", { simple: true }), MIGRATIONS.length);
  again.pragma(`user_version = ${MIGRATIONS.length + 1}`);
  again.close();
  assert.throws(() => openDb(file), /新しいです/);
});

// 部屋の進行（早送り）をつないで、大会を最後まで回す
function playRoom(records, { humans = 2, stopAfterHands = 0 } = {}) {
  const clock = fakeClock(), last = {}, ids = [...Array(humans)].map((_, i) => "p" + i);
  let tid = null;
  const room = createRoom({
    deliver: (id, m) => m.t == "view" && (last[id] = m.v),
    members: () => ids,
    clock,
    onStart: (g) => (tid = records.start(g, { source: "mp", room: "alp-t", ownerUid: "u0" })),
    onHand: (g, H) => records.hand(tid, g, H),
    onRound: (g) => records.update(tid, g),
    onOver: (g) => records.finish(tid, g, "over"),
  });
  room.start(ids.map((id, i) => ({ id, name: "H" + i, uid: i ? "u" + i : null })), 1);
  const g = room.state();
  const act = () => {
    for (const id of ids) {
      const v = last[id];
      if (v && v.req) room.msg(id, { t: "act", a: { t: v.req.toCall && v.req.toCall > v.req.stack / 3 ? "f" : "c" } });
      else if (v && v.ask) room.msg(id, { t: "re", y: true });
    }
  };
  let n = 0;
  while (n++ < 5e5 && !g.over && clock.step()) {
    act();
    if (stopAfterHands && g.hist.length >= stopAfterHands) break;
  }
  return { g, tid: () => tid };
}

test("大会の記録：大会・参加者・全ハンド・誰が配られたか・順位・打ち方の記録", () => {
  const db = openDb(":memory:"), records = openRecords(db);
  const { g, tid } = playRoom(records);
  assert.ok(g.over);
  const T = db.prepare("SELECT * FROM tournaments WHERE id = ?").get(tid());
  assert.deepEqual([T.source, T.room, T.owner_uid, T.finished, T.closed, T.entries, T.blind_min], ["mp", "alp-t", "u0", 1, 0, g.entries, 1]);
  assert.ok(T.started_at && T.finished_at >= T.started_at);
  const E = db.prepare("SELECT * FROM entries WHERE tournament_id = ? ORDER BY oid").all(tid());
  assert.equal(E.length, 2);
  for (const e of E) {
    const p = g.P.find((x) => x.oid == e.oid);
    assert.deepEqual([e.uid, e.name, e.place, e.rebuys], [p.uid, p.name, p.place, p.re]);
    assert.deepEqual(JSON.parse(e.stats), p.rec[0]);
  }
  const hands = db.prepare("SELECT n, data FROM hands WHERE tournament_id = ? ORDER BY n").all(tid());
  assert.equal(hands.length, g.hist.length);
  hands.forEach((h, i) => assert.deepEqual(JSON.parse(h.data), g.hist[i]));
  // 誰がどのハンドに配られたか（人間だけ）
  const hp = db.prepare("SELECT COUNT(*) n FROM hand_players WHERE tournament_id = ? AND oid = 'h1' AND uid = 'u1'").get(tid()).n;
  assert.equal(hp, g.hist.filter((H) => H.seats.some((s) => s.oid == "h1")).length);
  assert.ok(hp > 0);
});

test("ハンドが終わるたびに書くので、途中で落ちてもそこまでは残る。途中で閉じたら closed", () => {
  const db = openDb(":memory:"), records = openRecords(db);
  const { g, tid } = playRoom(records, { stopAfterHands: 5 });
  assert.ok(!g.over);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM hands WHERE tournament_id = ?").get(tid()).n, g.hist.length);
  const st = JSON.parse(db.prepare("SELECT stats FROM entries WHERE tournament_id = ? AND oid = 'h0'").get(tid()).stats);
  assert.ok(st.hands > 0, "打ち方の記録もハンドごとに更新される");
  records.finish(tid(), g, "closed");
  assert.deepEqual(db.prepare("SELECT finished, closed FROM tournaments WHERE id = ?").get(tid()), { finished: 0, closed: 1 });
  // 同じハンドを2回足しても増えない
  records.hand(tid(), g, g.hist[0]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM hands WHERE tournament_id = ?").get(tid()).n, g.hist.length);
});

test("以前のハンド履歴ファイル（版1・版2）を一度だけ取り込む。DB と結びついたファイルは取り込まない", (t) => {
  const dir = tmpdir(t), db = openDb(":memory:"), records = openRecords(db);
  const seat = (oid, name, uid, h) => ({ name, oid, hero: 1, uid, st: 1e4, end: 1e4, h, pos: "D" });
  const H = (n, seats) => ({ n, at: 1e12 + n, lv: 1, sb: 100, bb: 200, an: 50, tb: 1, seats, acts: [], bd: [], sd: [], win: [] });
  fs.writeFileSync(path.join(dir, "20261101-1200-alp-v1.json"), JSON.stringify({
    format: "alpoker-hands", version: 1, room: "alp-v1", finishedAt: "2026-11-01T12:00:00Z", entries: 41,
    players: [{ name: "Kaina", place: 3, re: 1 }], hands: [H(1, [seat("h0", "Kaina", undefined, [1, 2]), { name: "cpu", oid: "c5", hero: 0, st: 1, end: 1, h: [3, 4] }])],
  }));
  fs.writeFileSync(path.join(dir, "20261102-1200-alp-v2.json"), JSON.stringify({
    format: "alpoker-hands", version: 2, room: "alp-v2", finishedAt: "2026-11-02T12:00:00Z", finished: false, entries: 40,
    players: [{ uid: "uK", name: "Kaina", place: 0, re: 0, stats: { hands: 2 } }, { uid: null, name: "Guest", place: 9, re: 0, stats: {} }],
    hands: [H(1, [seat("h0", "Kaina", "uK", [5, 6]), seat("h1", "Guest", null, [7, 8])]), H(2, [seat("h0", "Kaina", "uK", [9, 10])])],
  }));
  fs.writeFileSync(path.join(dir, "broken.json"), "{");
  const logs = [];
  assert.equal(records.importDir(dir, (...a) => logs.push(a.join(" "))), 2);
  assert.ok(logs.some((l) => l.includes("broken.json")), "壊れたファイルはログに残して飛ばす");
  assert.equal(records.importDir(dir), 0, "2回目は何もしない");
  const T = db.prepare("SELECT room, finished, closed, entries, file FROM tournaments ORDER BY room").all();
  assert.deepEqual(T, [
    { room: "alp-v1", finished: 1, closed: 0, entries: 41, file: "20261101-1200-alp-v1.json" },
    { room: "alp-v2", finished: 0, closed: 1, entries: 40, file: "20261102-1200-alp-v2.json" },
  ]);
  const E = db.prepare("SELECT t.room, e.oid, e.uid, e.name, e.place, e.rebuys, e.stats FROM entries e JOIN tournaments t ON t.id = e.tournament_id ORDER BY t.room, e.oid").all();
  assert.deepEqual(E, [
    { room: "alp-v1", oid: "h0", uid: null, name: "Kaina", place: 3, rebuys: 1, stats: "{}" },
    { room: "alp-v2", oid: "h0", uid: "uK", name: "Kaina", place: null, rebuys: 0, stats: '{"hands":2}' },
    { room: "alp-v2", oid: "h1", uid: null, name: "Guest", place: 9, rebuys: 0, stats: "{}" },
  ]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM hands").get().n, 3);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM hand_players WHERE uid = 'uK'").get().n, 2);
  // 大会中に DB へ書いた大会のファイル（markFile 済み）は、取り込まない
  const g = { P: [], entries: 40, dur: 6e4 };
  const tid = records.start(g, {});
  fs.writeFileSync(path.join(dir, "20261103-1200-alp-live.json"), JSON.stringify({ format: "alpoker-hands", version: 2, hands: [], players: [] }));
  records.markFile(tid, path.join(dir, "20261103-1200-alp-live.json"));
  assert.equal(records.importDir(dir), 0);
});

test("毎日の写し：動いている DB の写しを1日1つ。14日分より古いものは消す", async (t) => {
  const dir = tmpdir(t), db = openDb(path.join(dir, "alpoker.db")), bk = path.join(dir, "backups");
  const records = openRecords(db);
  records.start({ P: [{ hero: 1, oid: "h0", name: "A" }], entries: 40 }, {});
  for (let d = 1; d <= 16; d++) await backupDaily(db, bk, 14, new Date(2026, 10, d, 12));
  const files = fs.readdirSync(bk).sort();
  assert.equal(files.length, 14);
  assert.equal(files[0], "alpoker-20261103.db");
  assert.equal(await backupDaily(db, bk, 14, new Date(2026, 10, 16, 18)), null, "同じ日の2回目は作らない");
  const copy = openDb(path.join(bk, files.at(-1)));
  assert.equal(copy.prepare("SELECT COUNT(*) n FROM entries").get().n, 1, "写しから読める");
  copy.close();
  db.close();
});

test("サーバー：以前のファイルを起動時に取り込み、遊んだ大会を DB に書き、止めるときは途中で閉じた扱いにする", async (t) => {
  const dir = tmpdir(t);
  fs.mkdirSync(path.join(dir, "hands"));
  fs.writeFileSync(path.join(dir, "hands", "20261101-1200-alp-old.json"), JSON.stringify({ format: "alpoker-hands", version: 1, room: "alp-old", entries: 40, players: [], hands: [] }));
  const boot = () => startServer({ PORT: 0, HOST: "127.0.0.1", quiet: 1, DATA_DIR: dir, CREATE_KEY: "key", accounts: openAccounts(), store: { get: () => null, set() {} } });
  let srv = await boot();
  const base = `http://127.0.0.1:${srv.port}/`;
  const count = (sql) => srv.db.prepare(sql).get().n;
  assert.equal(count("SELECT COUNT(*) n FROM tournaments WHERE room = 'alp-old'"), 1);
  assert.ok(fs.readdirSync(path.join(dir, "backups")).length >= 0);
  // 合言葉で部屋を作って遊ぶ
  const { room, adm } = await fetch(base + "api/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pw: "pw", key: "key" }) }).then((r) => r.json());
  const views = [];
  let joined = null;
  const j = joinRoom(wsLink(base, WebSocket), room, { name: "A", pw: "pw", role: "player", adm }, {
    joined: (m) => (joined = m),
    msg: (m) => m.t == "view" && views.push(m.v),
    error() {},
    closed() {},
  });
  await until(() => joined);
  j.send({ t: "admin", a: "start", dur: 5 });
  await until(() => {
    const v = views.at(-1);
    if (v && v.req && !v._s) (v._s = 1), j.send({ t: "act", a: { t: "f" } });
    return count(`SELECT COUNT(*) n FROM hands h JOIN tournaments t ON t.id = h.tournament_id WHERE t.room = '${room}'`) >= 1;
  }, 30000);
  j.leave();
  await srv.close();
  // 止めたので、途中で閉じた扱い。ファイルも残り、DB と結びついているので、次の起動で取り込み直さない
  srv = await boot();
  t.after(() => srv.close());
  assert.deepEqual(srv.db.prepare("SELECT finished, closed FROM tournaments WHERE room = ?").get(room), { finished: 0, closed: 1 });
  assert.equal(count(`SELECT COUNT(*) n FROM tournaments WHERE room = '${room}'`), 1);
  assert.equal(count("SELECT COUNT(*) n FROM tournaments"), 2);
  assert.equal(fs.readdirSync(path.join(dir, "backups")).filter((f) => f.endsWith(".db")).length, 1, "写しは1日1つ");
});

test("起動したとき、前のプロセスで遊んでいた大会（突然落ちたなど）を「途中で閉じた」にする", () => {
  const db = openDb(":memory:"), records = openRecords(db);
  const { g, tid } = playRoom(records, { stopAfterHands: 3 });
  const done = records.start({ P: [], entries: 40 }, { source: "mp" });
  records.finish(done, { P: [], entries: 40 }, "over");
  const solo = records.start({ P: [], entries: 40 }, { source: "solo" });
  assert.equal(records.closeStale(), 1, "終わっていない mp の大会だけ");
  assert.deepEqual(db.prepare("SELECT finished, closed FROM tournaments WHERE id = ?").get(tid()), { finished: 0, closed: 1 });
  assert.equal(db.prepare("SELECT closed FROM tournaments WHERE id = ?").get(done).closed, 0);
  assert.equal(db.prepare("SELECT closed FROM tournaments WHERE id = ?").get(solo).closed, 0, "ひとり用は別扱い（段階3b）");
  assert.ok(g.hist.length >= 3);
});

test("取り込み：DB に先に入っていた同じ大会（写しから戻した・ファイルとの結びつけに失敗した）は、二重にせず足りない分を足す", (t) => {
  const dir = tmpdir(t), db = openDb(":memory:"), records = openRecords(db);
  const seat = (oid, name, uid, h) => ({ name, oid, uid, hero: 1, pos: "D", st: 100, end: 100, h });
  const H = (n, at) => ({ n, at, lv: 1, sb: 50, bb: 100, an: 0, tb: 1, seats: [seat("h0", "Kaina", "uK", [1, 2]), seat("h1", "Ben", "uB", [3, 4])], acts: [], bd: [], sd: [], win: [] });
  const t0 = Date.parse("2026-11-03T10:00:00Z");
  // 大会中に DB へ2ハンドまで書いたところで、写しから戻した（ファイルとは結びついていない）
  const g = { P: [{ hero: 1, oid: "h0", uid: "uK", name: "Kaina", rec: [{}] }, { hero: 1, oid: "h1", uid: "uB", name: "Ben", rec: [{}] }], entries: 40, dur: 6e4 };
  const tid = records.start(g, { source: "mp", room: "alp-same", at: t0 });
  records.hand(tid, g, H(1, t0 + 1e3));
  records.hand(tid, g, H(2, t0 + 2e3));
  fs.writeFileSync(path.join(dir, "20261103-1200-alp-same.json"), JSON.stringify({
    format: "alpoker-hands", version: 2, room: "alp-same", finishedAt: "2026-11-03T11:00:00Z", finished: true, entries: 40,
    players: [{ uid: "uK", name: "Kaina", place: 1, re: 0, stats: {} }, { uid: "uB", name: "Ben", place: 2, re: 0, stats: {} }],
    hands: [H(1, t0 + 1e3), H(2, t0 + 2e3), H(3, t0 + 3e3)],
  }));
  assert.equal(records.importDir(dir), 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tournaments").get().n, 1, "大会は1つのまま");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM hands").get().n, 3, "足りないハンドだけ足す");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM hand_players WHERE uid = 'uK'").get().n, 3);
  assert.deepEqual(db.prepare("SELECT finished, file FROM tournaments").get(), { finished: 1, file: "20261103-1200-alp-same.json" });
  assert.equal(db.prepare("SELECT place FROM entries WHERE oid = 'h0'").get().place, 1);
});
