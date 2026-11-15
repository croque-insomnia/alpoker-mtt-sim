// solo.js — ひとり用の記録を受け取るときの検め。ブラウザが作って送るものなので、決まった形・数・大きさだけを通す
// 通したものは、サーバーが作り直した写し（知らない欄は捨てる）。「あなた」の席のアカウント ID はサーバーが付ける
"use strict";
const { REC_KEYS } = require("../engine.js");

const MAX_HANDS = 50, // 1回に送れるハンドの数
  MAX_ACTS = 200;
const int = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;
const str = (x, n) => typeof x === "string" && x.length <= n;
const card = (c) => int(c, 0, 51);

// 1ハンドを検めて写しを返す。おかしければ null
function cleanHand(H, uid) {
  if (!H || typeof H !== "object") return null;
  const { n, at, lv, sb, bb, an, tb, seats, acts, bd, sd, win } = H;
  if (!int(n, 1, 1e5) || !(typeof at === "number" && Number.isFinite(at)) || !int(lv, 1, 13) || !int(tb, 1, 8)) return null;
  if (![sb, bb, an].every((x) => int(x, 0, 1e8))) return null;
  if (!Array.isArray(seats) || seats.length < 2 || seats.length > 10) return null;
  if (!Array.isArray(acts) || acts.length > MAX_ACTS || !Array.isArray(bd) || bd.length > 5 || !bd.every(card)) return null;
  if (!Array.isArray(sd) || sd.length > 10 || !Array.isArray(win) || win.length > 10) return null;
  const S = [];
  for (const s of seats) {
    if (!s || !str(s.name, 20) || !str(s.oid, 20) || !int(s.st, 0, 1e9) || !int(s.end, 0, 1e9)) return null;
    if (s.pos != null && !str(s.pos, 10)) return null;
    if (s.h != null && !(Array.isArray(s.h) && s.h.length === 2 && s.h.every(card))) return null;
    const hero = s.hero ? 1 : 0;
    S.push({ name: s.name, oid: s.oid, uid: hero ? uid : null, hero, pos: s.pos || "", st: s.st, end: s.end, h: s.h || null, ...(s.shown ? { shown: 1 } : {}) });
  }
  // ひとり用は「あなた」が1人だけ
  if (S.filter((s) => s.hero).length !== 1 || S.find((s) => s.hero).oid !== "hero") return null;
  const A = [];
  for (const a of acts) {
    if (!a || ![0, 3, 4, 5].includes(a.s) || !int(a.i, 0, S.length - 1) || !"fkcbr".includes(a.a) || a.a.length !== 1) return null;
    if (!int(a.x, 0, 1e9) || !int(a.to, 0, 1e9)) return null;
    A.push({ s: a.s, i: a.i, a: a.a, x: a.x, to: a.to, ai: a.ai ? 1 : 0 });
  }
  const SD = [];
  for (const x of sd) {
    if (!x || !int(x.i, 0, S.length - 1) || !str(x.r, 20)) return null;
    SD.push({ i: x.i, r: x.r });
  }
  const W = [];
  for (const w of win) {
    if (!w || !int(w.x, 0, 1e9) || !Array.isArray(w.w) || !w.w.length || !w.w.every((i) => int(i, 0, S.length - 1))) return null;
    W.push({ x: w.x, w: w.w.slice() });
  }
  return { n, at, lv, sb, bb, an, tb, seats: S, acts: A, bd: bd.slice(), sd: SD, win: W };
}
// 打ち方の記録：決まった項目（REC_KEYS）の、0 以上の数だけ
function cleanStats(st) {
  const o = {};
  if (!st || typeof st !== "object") return o;
  for (const k of Object.keys(REC_KEYS)) {
    const v = st[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e7) o[k] = v;
  }
  return o;
}
// 送られてきたもの全体を検める。戻り値: { ok: 写し } または { error }
function cleanSync(b, uid) {
  if (!b || typeof b !== "object") return { error: "送信内容が読めません" };
  if (!(typeof b.key === "string" && /^[\w-]{16,64}$/.test(b.key))) return { error: "大会の目印がおかしいです" };
  const hands = Array.isArray(b.hands) ? b.hands : [];
  if (hands.length > MAX_HANDS) return { error: `一度に送れるのは ${MAX_HANDS} ハンドまでです` };
  const H = [];
  for (const h of hands) {
    const c = cleanHand(h, uid);
    if (!c) return { error: "ハンドの形がおかしいです" };
    H.push(c);
  }
  const num = (x, lo, hi) => (int(x, lo, hi) ? x : null);
  return {
    ok: {
      key: b.key,
      startedAt: typeof b.startedAt === "number" && Number.isFinite(b.startedAt) ? b.startedAt : null,
      blindMin: [1, 2, 5].includes(b.blindMin) ? b.blindMin : null,
      entries: num(b.entries, 1, 1000),
      re: num(b.re, 0, 10) || 0,
      place: num(b.place, 1, 1000),
      over: b.over ? 1 : 0,
      stats: cleanStats(b.stats),
      hands: H,
    },
  };
}

module.exports = { cleanSync, cleanHand, cleanStats, MAX_HANDS };
