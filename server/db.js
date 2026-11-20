// db.js — 記録の DB（SQLite）を開く。表の形は MIGRATIONS で、番号順に1回ずつ当てる（PRAGMA user_version に今の番号）
// DB は1ファイル（DATA_DIR/alpoker.db）。WAL にしているので、遊んでいる最中でも読み書き・バックアップができる
"use strict";
const fs = require("fs"),
  path = require("path");
const Database = require("better-sqlite3");

// 表の形。あとから変えるときは、ここに新しい番号を足す（今ある番号は書き換えない）
const MIGRATIONS = [
  // 1: 大会・参加者・ハンド・「誰がどのハンドに配られたか」
  `
  CREATE TABLE tournaments (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,              -- "mp"（みんなで遊ぶ）/ "solo"（ひとり用）
    room TEXT,                         -- 部屋 ID（みんなで遊ぶとき）
    owner_uid TEXT,                    -- 部屋を作ったアカウント
    started_at INTEGER,                -- ms
    finished_at INTEGER,
    finished INTEGER NOT NULL DEFAULT 0, -- 1: 最後まで終わった
    closed INTEGER NOT NULL DEFAULT 0,   -- 1: 途中で閉じた
    entries INTEGER,                   -- エントリー数（リエントリー込み）
    blind_min REAL,                    -- ブラインド間隔（分）
    file TEXT UNIQUE                   -- 同じ大会のハンド履歴ファイル（取り込み済みかの目印にも使う）
  );
  CREATE TABLE entries (
    tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    oid TEXT NOT NULL,                 -- 大会の中の番号（h0 など）
    uid TEXT,                          -- アカウント ID（ゲストは NULL）
    name TEXT NOT NULL,
    place INTEGER,                     -- 順位（決まっていなければ NULL）
    rebuys INTEGER NOT NULL DEFAULT 0,
    stats TEXT NOT NULL DEFAULT '{}',  -- 打ち方の記録（engine.js の track が数えたもの）
    PRIMARY KEY (tournament_id, oid)
  );
  CREATE INDEX entries_uid ON entries(uid);
  CREATE TABLE hands (
    id INTEGER PRIMARY KEY,
    tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    n INTEGER NOT NULL,                -- 大会の中の通し番号
    at INTEGER,
    lv INTEGER,
    tb INTEGER,
    data TEXT NOT NULL,                -- 1ハンドの中身（engine.js の histText の上にある形の JSON）
    UNIQUE (tournament_id, n)
  );
  CREATE TABLE hand_players (
    hand_id INTEGER NOT NULL REFERENCES hands(id) ON DELETE CASCADE,
    tournament_id INTEGER NOT NULL,
    oid TEXT NOT NULL,
    uid TEXT,
    PRIMARY KEY (hand_id, oid)
  );
  CREATE INDEX hand_players_uid ON hand_players(uid, tournament_id);
  `,
  // 2: ひとり用の大会は、ブラウザが決めた目印（client_key）で見分ける（送り直しても同じ大会になる）
  `
  ALTER TABLE tournaments ADD COLUMN client_key TEXT;
  CREATE UNIQUE INDEX tournaments_client ON tournaments(owner_uid, client_key) WHERE client_key IS NOT NULL;
  `,
  // 3: スポット（同じ場面に、みんながどう打つか。server/spots.js）
  `
  CREATE TABLE spots (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,                -- "preflop" / "postflop"
    source TEXT NOT NULL,              -- "auto"（自動で作った）/ "manual"（手で投稿した）
    situation TEXT NOT NULL,           -- 場面（JSON。spots.js の makePreflop の形）
    hash TEXT NOT NULL UNIQUE,         -- 同じ問題を2度作らないための目印
    created_by TEXT,                   -- 投稿したアカウント（自動は NULL）
    created_at INTEGER NOT NULL
  );
  CREATE TABLE spot_answers (
    spot_id INTEGER NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
    uid TEXT NOT NULL,
    action TEXT NOT NULL,              -- fold / call / raise / allin
    size_bb REAL,                      -- raise のときの額（レイズ後の合計）
    comment TEXT NOT NULL,
    answered_at INTEGER NOT NULL,
    PRIMARY KEY (spot_id, uid)         -- 1人1回。結果を見たあとは直せない
  );
  CREATE INDEX spot_answers_uid ON spot_answers(uid);
  `,
  // 4: 問題の評価（良い問題 +1 / 悪い問題 -1。1人1票で、あとから変えられる）
  `
  CREATE TABLE spot_votes (
    spot_id INTEGER NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
    uid TEXT NOT NULL,
    vote INTEGER NOT NULL,             -- 1: 良い問題 / -1: 悪い問題
    voted_at INTEGER NOT NULL,
    PRIMARY KEY (spot_id, uid)
  );
  `,
];

// file: DB のファイル（":memory:" でメモリだけ。テスト用）
function openDb(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  if (file !== ":memory:") {
    db.pragma("journal_mode = WAL");
    try {
      fs.chmodSync(file, 0o600);
    } catch (e) {}
  }
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  const v = db.pragma("user_version", { simple: true });
  if (v > MIGRATIONS.length) throw new Error(`DB の形（${v}）が、このプログラムが知っているもの（${MIGRATIONS.length}）より新しいです。プログラムを更新してください`);
  for (let i = v; i < MIGRATIONS.length; i++)
    db.transaction(() => {
      db.exec(MIGRATIONS[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  return db;
}

// 動いている最中でも安全な写しを取る。dir に alpoker-日付.db を作り、keep 個より古いものは消す
// 戻り値: 作ったファイル（今日の分がもうあれば null）
async function backupDaily(db, dir, keep = 14, now = new Date()) {
  fs.mkdirSync(dir, { recursive: true });
  const two = (x) => String(x).padStart(2, "0"),
    name = `alpoker-${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}.db`,
    dest = path.join(dir, name);
  let made = null;
  if (!fs.existsSync(dest)) {
    await db.backup(dest + ".tmp");
    fs.renameSync(dest + ".tmp", dest);
    try {
      fs.chmodSync(dest, 0o600);
    } catch (e) {}
    made = dest;
  }
  const old = fs
    .readdirSync(dir)
    .filter((f) => /^alpoker-\d{8}\.db$/.test(f))
    .sort()
    .reverse()
    .slice(keep);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  return made;
}

module.exports = { openDb, backupDaily, MIGRATIONS };
