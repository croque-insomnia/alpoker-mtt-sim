// records.js — 大会・参加者・ハンドを DB に書く係。部屋の進行（room.js）から呼ばれる
//   start(g, {...})   … 大会が始まったとき。大会の行と、人間の参加者の行を作る
//   hand(tid, g, H)   … ハンドが1つ終わるたびに。ハンドを1件足し、そのハンドに配られた人間の打ち方の記録を更新する
//   update(tid, g)    … ラウンドごとに。順位・リエントリー回数・エントリー数を更新する
//   finish(tid, g, how) … 終わった（"over"）・途中で閉じた（"closed"）とき
// ハンドを終わるたびに書くので、サーバーが突然落ちても、そこまでのハンドは残る
// 書き込みに失敗しても、ゲームは止めない（ログに残すだけ。呼ぶ側で try する）
"use strict";
const fs = require("fs"),
  path = require("path");
const { analyze } = require("../engine.js");

function openRecords(db) {
  const q = {
    tour: db.prepare(`INSERT INTO tournaments (source, room, owner_uid, started_at, entries, blind_min) VALUES (?, ?, ?, ?, ?, ?)`),
    entry: db.prepare(`INSERT INTO entries (tournament_id, oid, uid, name) VALUES (?, ?, ?, ?)`),
    hand: db.prepare(`INSERT OR IGNORE INTO hands (tournament_id, n, at, lv, tb, data) VALUES (?, ?, ?, ?, ?, ?)`),
    hp: db.prepare(`INSERT OR IGNORE INTO hand_players (hand_id, tournament_id, oid, uid) VALUES (?, ?, ?, ?)`),
    stats: db.prepare(`UPDATE entries SET stats = ? WHERE tournament_id = ? AND oid = ?`),
    place: db.prepare(`UPDATE entries SET place = ?, rebuys = ? WHERE tournament_id = ? AND oid = ?`),
    tourEntries: db.prepare(`UPDATE tournaments SET entries = ? WHERE id = ?`),
    fin: db.prepare(`UPDATE tournaments SET finished_at = ?, finished = ?, closed = ?, entries = ? WHERE id = ?`),
    file: db.prepare(`UPDATE tournaments SET file = ? WHERE id = ?`),
    hasFile: db.prepare(`SELECT 1 FROM tournaments WHERE file = ?`),
    stale: db.prepare(`UPDATE tournaments SET closed = 1 WHERE source = 'mp' AND finished = 0 AND closed = 0`),
    soloFind: db.prepare(`SELECT id FROM tournaments WHERE source = 'solo' AND owner_uid = ? AND client_key = ?`),
    soloNew: db.prepare(`INSERT INTO tournaments (source, owner_uid, client_key, started_at, entries, blind_min) VALUES ('solo', ?, ?, ?, ?, ?)`),
    soloEntry: db.prepare(`INSERT OR IGNORE INTO entries (tournament_id, oid, uid, name) VALUES (?, 'hero', ?, ?)`),
    soloMeta: db.prepare(`UPDATE tournaments SET entries = COALESCE(?, entries) WHERE id = ?`),
    soloEnd: db.prepare(`UPDATE tournaments SET finished = 1, finished_at = ? WHERE id = ? AND finished = 0`),
    soloEntryUpd: db.prepare(`UPDATE entries SET stats = ?, rebuys = ?, place = COALESCE(?, place), name = ? WHERE tournament_id = ? AND oid = 'hero'`),
    // 読み出し（振り返り・傾向）
    // done=1：続いているみんなで遊ぶ大会のハンドは入れない（他の人の傾向を見るとき。大会中に隠れている手札の情報を出さないため）
    handsOf: db.prepare(
      `SELECT h.data, t.source FROM hand_players hp JOIN hands h ON h.id = hp.hand_id JOIN tournaments t ON t.id = hp.tournament_id
       WHERE hp.uid = @uid AND (@source IS NULL OR t.source = @source) AND (@since = 0 OR h.at >= @since)
         AND (@done = 0 OR t.source = 'solo' OR t.finished = 1 OR t.closed = 1)
       ORDER BY h.at, h.id`,
    ),
    // 傾向の覚えを使い回してよいかの目印：その人のハンドの数と、終わった・閉じた大会の数
    sig: db.prepare(`SELECT (SELECT COUNT(*) FROM hand_players WHERE uid = ?) AS n, (SELECT COUNT(*) FROM tournaments WHERE finished = 1 OR closed = 1) AS d`),
    tournamentsOf: db.prepare(
      `SELECT t.id, t.source, t.room, t.started_at, t.finished_at, t.finished, t.closed, t.entries, t.blind_min,
              e.oid, e.place, e.rebuys,
              (SELECT COUNT(*) FROM hand_players hp WHERE hp.tournament_id = t.id AND hp.uid = e.uid) AS hands
       FROM entries e JOIN tournaments t ON t.id = e.tournament_id
       WHERE e.uid = ? ORDER BY t.started_at DESC, t.id DESC LIMIT ?`,
    ),
    entryOf: db.prepare(`SELECT t.*, e.oid FROM entries e JOIN tournaments t ON t.id = e.tournament_id WHERE e.tournament_id = ? AND e.uid = ?`),
    handsIn: db.prepare(`SELECT data FROM hands WHERE tournament_id = ? ORDER BY n`),
    // 取り込み：同じ部屋で、最初のハンドより前の1日以内に始まり、まだファイルと結びついていない大会（DB に先に入っていた同じ大会）
    findRoom: db.prepare(`SELECT id FROM tournaments WHERE source = 'mp' AND room = ? AND file IS NULL AND started_at BETWEEN ? AND ? ORDER BY started_at DESC LIMIT 1`),
    entryIgn: db.prepare(`INSERT OR IGNORE INTO entries (tournament_id, oid, uid, name) VALUES (?, ?, ?, ?)`),
  };
  const DAY = 864e5;
  // 傾向の覚え（key -> { sig, r }）。ハンドが増えたり、大会が終わったりしたら作り直す
  const cache = new Map();
  // analyze の結果どうしを足す（対人と対CPU を足して合算にする）
  const addA = (a, b) => {
    const sum = (x, y) => {
      const o = { ...x };
      for (const [k, v] of Object.entries(y)) o[k] = typeof v === "object" ? sum(o[k] || {}, v) : (o[k] || 0) + v;
      return o;
    };
    return { all: sum(a.all, b.all), pos: sum(a.pos, b.pos), depth: sum(a.depth, b.depth) };
  };
  const humans = (g) => g.P.filter((p) => p.hero);
  const places = db.transaction((tid, g) => {
    for (const p of humans(g)) q.place.run(p.place || null, p.re || 0, tid, p.oid);
    q.tourEntries.run(g.entries, tid);
  });
  return {
    start: db.transaction((g, o = {}) => {
      const tid = Number(q.tour.run(o.source || "mp", o.room || null, o.ownerUid || null, o.at || Date.now(), g.entries, g.dur ? g.dur / 6e4 : null).lastInsertRowid);
      for (const p of humans(g)) q.entry.run(tid, p.oid, p.uid || null, p.name);
      return tid;
    }),
    hand: db.transaction((tid, g, H) => {
      const r = q.hand.run(tid, H.n, H.at || null, H.lv || null, H.tb || null, JSON.stringify(H));
      if (!r.changes) return; // 同じハンドはもう入っている
      const hid = Number(r.lastInsertRowid);
      for (const s of H.seats)
        if (s.hero) {
          q.hp.run(hid, tid, s.oid, s.uid || null);
          const p = g && g.P.find((x) => x.oid === s.oid);
          if (p && p.rec) q.stats.run(JSON.stringify(p.rec[0] || {}), tid, s.oid);
        }
    }),
    update: (tid, g) => places(tid, g),
    // 起動したとき：前のプロセスで遊んでいた大会（部屋はメモリにしかないので、もう続かない）を「途中で閉じた」にする
    // サーバーが突然落ちたときも、そこまでのハンドは残っている。戻り値: 閉じた数
    closeStale: () => q.stale.run().changes,
    finish: db.transaction((tid, g, how, at) => {
      places(tid, g);
      for (const p of humans(g)) if (p.rec) q.stats.run(JSON.stringify(p.rec[0] || {}), tid, p.oid);
      q.fin.run(at || Date.now(), how === "over" ? 1 : 0, how === "closed" ? 1 : 0, g.entries, tid);
    }),
    // ひとり用：ブラウザから届いた記録（solo.js で検め済み）を入れる。同じものが2回届いても増えない
    // 戻り値: { tid, saved: 新しく入ったハンドの数 }
    solo: db.transaction((user, s, at) => {
      let row = q.soloFind.get(user.id, s.key);
      const tid = row ? row.id : Number(q.soloNew.run(user.id, s.key, s.startedAt || at || Date.now(), s.entries, s.blindMin).lastInsertRowid);
      q.soloEntry.run(tid, user.id, user.name);
      let saved = 0;
      for (const H of s.hands) {
        const r = q.hand.run(tid, H.n, H.at, H.lv, H.tb, JSON.stringify(H));
        if (!r.changes) continue;
        saved++;
        q.hp.run(Number(r.lastInsertRowid), tid, "hero", user.id);
      }
      q.soloMeta.run(s.entries, tid);
      q.soloEntryUpd.run(JSON.stringify(s.stats), s.re, s.place, user.name, tid);
      if (s.over) q.soloEnd.run(at || Date.now(), tid);
      return { tid, saved };
    }),
    // その人が配られたハンド（古い順）。source: "mp" / "solo" / 省略で両方、since: この時刻（ms）以降
    // done: 続いているみんなで遊ぶ大会のハンドは入れない
    handsOf(uid, o = {}) {
      return q.handsOf
        .all({ uid, source: o.source || null, since: o.since || 0, done: o.done ? 1 : 0 })
        .map((r) => Object.assign(JSON.parse(r.data), { source: r.source }));
    },
    // その人が参加した大会（新しい順）。自分の順位・リエントリー・配られたハンドの数つき
    tournamentsOf: (uid, limit = 200) => q.tournamentsOf.all(uid, limit),
    // その人がその大会に参加していれば { t: 大会, oid: その人の席 }。していなければ null
    entryOf(tid, uid) {
      const r = q.entryOf.get(tid, uid);
      return r ? { t: r, oid: r.oid } : null;
    },
    handsIn: (tid) => q.handsIn.all(tid).map((r) => JSON.parse(r.data)),
    // その人の打ち方の傾向（engine.js の analyze）。対人（mp）と対CPU（solo）を分けたものと、合わせたもの
    //   o.done: 続いているみんなで遊ぶ大会は数えない（他の人を見るとき）
    //   since は日の単位に切り下げて数え、結果は覚えておく（ハンドが増えるか大会が終わるまで使い回す）
    analyzeUser(uid, o = {}) {
      const since = o.since ? Math.floor(o.since / DAY) * DAY : 0,
        key = `${uid}|${since}|${o.done ? 1 : 0}`,
        s = q.sig.get(uid),
        sig = s.n + "/" + s.d,
        c = cache.get(key);
      if (c && c.sig === sig) return c.r;
      const hs = this.handsOf(uid, { since, done: o.done }), mine = (x) => x.uid === uid;
      const mp = analyze(hs.filter((h) => h.source === "mp"), mine),
        solo = analyze(hs.filter((h) => h.source === "solo"), mine);
      const r = { all: addA(mp, solo), mp, solo, hands: hs.length };
      if (cache.size > 500) cache.clear();
      cache.set(key, { sig, r });
      return r;
    },
    // 身内CPUの材料用：src（"all" / "mp" / "solo"）だけを、全期間と recentSince 以降で数える（ハンドは1回だけ読む）
    profileOf(uid, o = {}) {
      const hs = this.handsOf(uid, { source: o.src && o.src !== "all" ? o.src : null, done: o.done }), mine = (x) => x.uid === uid;
      return { all: analyze(hs, mine), recent: analyze(hs.filter((h) => h.at >= (o.recentSince || 0)), mine) };
    },
    // ハンド履歴ファイルと大会を結びつける（取り込みのとき、同じ大会を2回入れないため）
    markFile: (tid, file) => q.file.run(path.basename(file), tid),
    // DATA_DIR/hands/*.json（版1・版2）のうち、まだ入っていないものを取り込む。戻り値: 取り込んだ数
    importDir(dir, log = () => {}) {
      let n = 0;
      let files = [];
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
      } catch (e) {
        return 0;
      }
      for (const f of files) {
        if (q.hasFile.get(f)) continue;
        try {
          importOne(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")), f);
          n++;
        } catch (e) {
          log("records: 取り込めませんでした", f, e.message);
        }
      }
      return n;
    },
  };
  // 1ファイルを1大会として取り込む。参加者の oid はファイルにないので、ハンドの席の名前から引く（版1はアカウント ID もない）
  function importOne(body, f) {
    if (!body || body.format !== "alpoker-hands" || !Array.isArray(body.hands)) throw new Error("形が違います");
    db.transaction(() => {
      const hands = body.hands,
        first = hands[0],
        fin = Date.parse(body.finishedAt) || (hands.length ? hands[hands.length - 1].at : null),
        done = body.finished === undefined ? 1 : body.finished ? 1 : 0;
      // DB に同じ大会が先に入っていれば（大会中に書いた分。写しから戻したあとや、ファイルとの結びつけに失敗したとき）、そこへ足りない分を足す
      const same = body.room && first && first.at ? q.findRoom.get(body.room, first.at - DAY, first.at) : null;
      const tid = same ? same.id : Number(q.tour.run("mp", body.room || null, null, first ? first.at : fin, body.entries || null, null).lastInsertRowid);
      q.fin.run(fin, done, done ? 0 : 1, body.entries || null, tid);
      q.file.run(f, tid);
      // 名前 → 席の番号（人間の席から）
      const oidOf = {};
      for (const H of hands) for (const s of H.seats || []) if (s.hero && !oidOf[s.name]) oidOf[s.name] = s.oid;
      const players = Array.isArray(body.players) ? body.players : [];
      players.forEach((p, i) => {
        const oid = oidOf[p.name] || "x" + i;
        q.entryIgn.run(tid, oid, p.uid || null, String(p.name || "?"));
        q.place.run(p.place || null, p.re || 0, tid, oid);
        if (p.stats) q.stats.run(JSON.stringify(p.stats), tid, oid);
      });
      hands.forEach((H, i) => {
        const r = q.hand.run(tid, H.n || i + 1, H.at || null, H.lv || null, H.tb || null, JSON.stringify(H));
        if (!r.changes) return;
        const hid = Number(r.lastInsertRowid);
        for (const s of H.seats || []) if (s.hero) q.hp.run(hid, tid, s.oid, s.uid || null);
      });
    })();
  }
}

module.exports = { openRecords };
