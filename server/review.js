// review.js — 振り返り（過去の大会・ハンド）と、打ち方の傾向・身内CPUの材料の HTTP の口
// どれも、ログインしている人が、このサイトのページから使うときだけ（読むだけなので auth.readerUser。別のサイトと分かるものは断る）
//   GET api/review/tournaments           … 自分が参加した大会の一覧
//   GET api/review/hands?t=大会ID         … その大会のハンド。参加した大会だけ
//        みんなで遊ぶ大会がまだ続いているあいだは、自分が配られたハンドだけ・自分の手札と公開された手札だけ
//        終わった（途中で閉じた）大会と、ひとり用は、全員の手札つき
//   GET api/style?u=アカウントID&since=ms … 打ち方の傾向（合算・対人・対CPU）。自分か、「身内CPU化に使ってよい」にした人だけ
//   GET api/style/members                 … 傾向を見られる人の一覧（自分と、使ってよいにした人）
//   GET api/style/profile?u=…&src=all|mp|solo … 身内CPUの材料（alpoker-profile。ひとり用のエクスポートと同じ形）
"use strict";
const { histView, analyzeRows, REC_KEYS, ME_DECAY, ME_PRIOR } = require("../engine.js");

function createReview({ auth, accounts, records, json, log }) {
  const DAY = 864e5;
  // 傾向を見てよいか：自分か、使ってよいにした人
  const canSee = (me, uid) => {
    if (uid === me.id) return true;
    const u = accounts.getUser(uid);
    return !!(u && u.share && !u.disabled);
  };
  const sinceOf = (url) => {
    const s = +url.searchParams.get("since");
    return Number.isFinite(s) && s > 0 ? s : 0;
  };
  // 他の人を見るときは、続いているみんなで遊ぶ大会を数えない（大会中に隠れている手札の情報が、傾向の数の増え方から漏れるため）
  const style = (uid, since, done) => {
    const r = records.analyzeUser(uid, { since, done });
    const pack = (a) => ({ rows: analyzeRows(a.all), pos: a.pos, depth: a.depth, counts: a.all });
    return { all: pack(r.all), mp: pack(r.mp), solo: pack(r.solo), hands: r.hands };
  };

  return function handle(req, res, url) {
    const p = url.pathname;
    if (!p.startsWith("/api/review/") && !p.startsWith("/api/style")) return false;
    if (req.method !== "GET") return json(res, 405, { why: "GET だけです" }), true;
    const me = auth.readerUser(req);
    if (!me) return json(res, 401, { why: "ログインしてください" }), true;
    try {
      if (p === "/api/review/tournaments") return json(res, 200, { tournaments: records.tournamentsOf(me.id) }), true;
      if (p === "/api/review/hands") {
        const tid = +url.searchParams.get("t");
        const e = Number.isInteger(tid) && records.entryOf(tid, me.id);
        if (!e) return json(res, 404, { why: "その大会は見られません（参加した大会だけ）" }), true;
        const running = e.t.source === "mp" && !e.t.finished && !e.t.closed;
        const hands = histView(records.handsIn(tid), running ? e.oid : null);
        // 大会の行は、画面に要るものだけ返す（部屋を作った人のアカウント ID などは出さない）
        const { id, source, started_at, finished_at, finished, closed, entries, blind_min } = e.t;
        const tournament = { id, source, started_at, finished_at, finished, closed, entries, blind_min, oid: e.oid };
        return json(res, 200, { tournament, running: running ? 1 : 0, hands }), true;
      }
      if (p === "/api/style/members") {
        const list = accounts.sharedUsers().filter((u) => u.id !== me.id);
        return json(res, 200, { me: { id: me.id, name: me.name, share: me.share ? 1 : 0 }, members: list }), true;
      }
      if (p === "/api/style" || p === "/api/style/profile") {
        const uid = url.searchParams.get("u") || me.id;
        if (!canSee(me, uid)) return json(res, 403, { why: "その人は、身内CPU化に使ってよいにしていません" }), true;
        const u = accounts.getUser(uid), since = sinceOf(url), done = uid !== me.id;
        if (p === "/api/style") return json(res, 200, { user: { id: uid, name: u ? u.name : "?" }, since, ...style(uid, since, done) }), true;
        // 身内CPUの材料：ひとり用の「あなたの傾向」のエクスポートと同じ形（all・recent・summary）に、位置別・深さ別を足す
        const src = ["mp", "solo"].includes(url.searchParams.get("src")) ? url.searchParams.get("src") : "all";
        const { all: allTime, recent } = records.profileOf(uid, { src, done, recentSince: Date.now() - 30 * DAY });
        const ts = records.tournamentsOf(uid).filter((t) => src === "all" || t.source === src);
        const body = {
          format: "alpoker-profile",
          version: 1,
          name: u ? u.name : "?",
          exportedAt: new Date().toISOString(),
          source: src, // all: 合算 / mp: 対人 / solo: 対CPU
          tournaments: ts.length,
          blend: { decay: ME_DECAY, prior: ME_PRIOR },
          keys: REC_KEYS,
          all: allTime.all,
          recent: recent.all, // 直近30日
          summary: Object.fromEntries(analyzeRows(allTime.all).map((r) => [r.name, r.value])),
          pos: allTime.pos,
          depth: allTime.depth,
        };
        log && log("style: profile", me.id, "->", uid, src);
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "content-disposition": `attachment; filename="alpoker-profile-${uid}-${src}.json"`,
        });
        res.end(JSON.stringify(body, null, 1));
        return true;
      }
    } catch (e) {
      log && log("review error", e.stack || e.message);
      return json(res, 500, { why: "読み出せませんでした" }), true;
    }
    return json(res, 404, { why: "not found" }), true;
  };
}

module.exports = { createReview };
