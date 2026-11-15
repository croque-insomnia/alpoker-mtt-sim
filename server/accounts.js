// accounts.js — アカウント・外部ログインの紐づけ・セッション・招待を持つ。HTTP は知らない（auth.js が使う）。
// 保存は JSON 1ファイル（数十人まで想定）。人数や戦績が増えたら、このファイルの中だけ SQLite などに差し替える。
//
//   users:      { id: { id, name, role: "admin" | "member", createdAt, lastLogin } }
//   identities: { "discord:外部ID": { provider, sub, userId, name, avatar, linkedAt } }
//   sessions:   { ハッシュ: { userId, createdAt, expiresAt, seenAt, ua } }   … ブラウザに渡すのは元の合言葉だけ
//   invites:    { ハッシュ: { role, createdBy, createdAt, expiresAt, usedBy, usedAt } }
// 合言葉（セッション・招待）は十分に長い乱数なので、保存は SHA-256 のハッシュだけにする（漏れても使えない）
"use strict";
const fs = require("fs"),
  path = require("path"),
  crypto = require("crypto");

const DAY = 864e5,
  SESSION_DAYS = 180, // 使うたびに延長する
  INVITE_DAYS = 7,
  NAME_MAX = 12;
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const token = () => crypto.randomBytes(32).toString("base64url");
// 表示名：HTML に入れて困る文字は落とし、12文字まで
const cleanName = (s) => String(s || "").replace(/[<>&"'`\u0000-\u001f\u007f]/g, "").trim().slice(0, NAME_MAX);

// file を省略するとメモリだけ（テスト用）
function openAccounts(file, opt = {}) {
  const now = opt.now || (() => Date.now());
  let db = { users: {}, identities: {}, sessions: {}, invites: {} },
    timer = null;
  if (file)
    try {
      db = { ...db, ...JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch (e) {}
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + ".tmp", JSON.stringify(db), { mode: 0o600 });
      fs.renameSync(file + ".tmp", file);
    } catch (e) {
      console.error("accounts: 保存できませんでした", e.message);
    }
  };
  const dirty = () => (timer ||= setTimeout(flush, 1000));

  // 期限切れのセッション・招待を消す
  function sweep() {
    const t = now();
    for (const [k, s] of Object.entries(db.sessions)) if (s.expiresAt < t) delete db.sessions[k];
    for (const [k, v] of Object.entries(db.invites)) if (v.expiresAt < t && !v.usedBy) delete db.invites[k];
  }
  // 名前が他の人と重なっていれば、後ろに番号を付けて重ならないようにする
  function uniqueName(name, selfId) {
    const base = cleanName(name) || "player";
    const taken = (n) => Object.values(db.users).some((u) => u.id !== selfId && u.name.toLowerCase() === n.toLowerCase());
    if (!taken(base)) return base;
    for (let i = 2; ; i++) {
      const n = base.slice(0, NAME_MAX - String(i).length) + i;
      if (!taken(n)) return n;
    }
  }
  const publicUser = (u) =>
    u && {
      id: u.id,
      name: u.name,
      role: u.role,
      createdAt: u.createdAt,
      lastLogin: u.lastLogin,
      identities: Object.values(db.identities)
        .filter((i) => i.userId === u.id)
        .map(({ provider, name, avatar, linkedAt }) => ({ provider, name, avatar, linkedAt })),
    };

  return {
    flush,
    // ---- 招待 ----
    createInvite(role, createdBy) {
      const t = token(), at = now();
      db.invites[sha(t)] = { role: role === "admin" ? "admin" : "member", createdBy: createdBy || null, createdAt: at, expiresAt: at + INVITE_DAYS * DAY, usedBy: null };
      dirty();
      return { token: t, expiresAt: at + INVITE_DAYS * DAY };
    },
    // 使える招待か（使ってはいない）
    checkInvite(t) {
      const v = t && db.invites[sha(t)];
      return v && !v.usedBy && v.expiresAt >= now() ? { role: v.role } : null;
    },
    hasAdmin: () => Object.values(db.users).some((u) => u.role === "admin"),
    pendingAdminInvite: () => Object.values(db.invites).some((v) => v.role === "admin" && !v.usedBy && v.expiresAt >= now()),

    // ---- 外部ログイン ----
    // 外部アカウントからログインする。
    //   すでに紐づいていれば、その人。いなければ、invite（招待の合言葉）か autoJoin（Discord サーバーのメンバー）で新しく作る
    //   戻り値: { user } または { error }
    loginExternal({ provider, sub, name, avatar }, { invite, autoJoin } = {}) {
      sub = String(sub);
      const key = provider + ":" + sub, idn = db.identities[key];
      if (idn && db.users[idn.userId]) {
        Object.assign(idn, { name: cleanName(name) || idn.name, avatar: avatar || null });
        db.users[idn.userId].lastLogin = now();
        dirty();
        return { user: publicUser(db.users[idn.userId]) };
      }
      const iv = invite && db.invites[sha(invite)];
      const ok = iv && !iv.usedBy && iv.expiresAt >= now();
      if (!ok && !autoJoin) return { error: invite ? "招待リンクが無効です（使用済みか、期限切れ）" : "招待が必要です。招待リンクから入ってください" };
      const id = "u" + crypto.randomBytes(6).toString("hex"), at = now();
      db.users[id] = { id, name: uniqueName(name), role: ok ? iv.role : "member", createdAt: at, lastLogin: at };
      db.identities[key] = { provider, sub, userId: id, name: cleanName(name), avatar: avatar || null, linkedAt: at };
      if (ok) Object.assign(iv, { usedBy: id, usedAt: at });
      dirty();
      return { user: publicUser(db.users[id]) };
    },
    // ログイン中の人に、別の外部アカウントを紐づける
    linkExternal(userId, { provider, sub, name, avatar }) {
      const key = provider + ":" + String(sub), idn = db.identities[key];
      if (!db.users[userId]) return { error: "ログインし直してください" };
      if (idn && idn.userId !== userId) return { error: "その外部アカウントは、別の人に紐づいています" };
      if (!idn && Object.values(db.identities).some((i) => i.userId === userId && i.provider === provider))
        return { error: "同じ種類の外部アカウントは1つまでです。先に今の紐づけを外してください" };
      db.identities[key] = { provider, sub: String(sub), userId, name: cleanName(name), avatar: avatar || null, linkedAt: (idn && idn.linkedAt) || now() };
      dirty();
      return { user: publicUser(db.users[userId]) };
    },
    // 紐づけを外す（最後の1つは外せない。ログインできなくなるため）
    unlinkExternal(userId, provider) {
      const mine = Object.entries(db.identities).filter(([, i]) => i.userId === userId);
      if (mine.length <= 1) return { error: "最後のログイン方法は外せません" };
      const hit = mine.find(([, i]) => i.provider === provider);
      if (!hit) return { error: "紐づいていません" };
      delete db.identities[hit[0]];
      dirty();
      return { user: publicUser(db.users[userId]) };
    },

    // ---- セッション ----
    createSession(userId, ua) {
      const t = token(), at = now();
      db.sessions[sha(t)] = { userId, createdAt: at, seenAt: at, expiresAt: at + SESSION_DAYS * DAY, ua: String(ua || "").slice(0, 120) };
      dirty();
      return { token: t, maxAge: SESSION_DAYS * 86400 };
    },
    // 合言葉からログイン中の人を引く。使われたら期限を延ばす（書き込みは1時間に1回まで）
    sessionUser(t) {
      if (!t) return null;
      const k = sha(t), s = db.sessions[k], at = now();
      if (!s || s.expiresAt < at) return null;
      const u = db.users[s.userId];
      if (!u) return null;
      if (at - s.seenAt > 36e5) {
        s.seenAt = at;
        s.expiresAt = at + SESSION_DAYS * DAY;
        dirty();
      }
      return publicUser(u);
    },
    endSession(t) {
      if (t && delete db.sessions[sha(t)]) dirty();
    },
    endUserSessions(userId) {
      let n = 0;
      for (const [k, s] of Object.entries(db.sessions)) if (s.userId === userId) (delete db.sessions[k], n++);
      dirty();
      return n;
    },

    // ---- 人 ----
    getUser: (id) => publicUser(db.users[id]),
    listUsers: () =>
      Object.values(db.users)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((u) => ({ ...publicUser(u), sessions: Object.values(db.sessions).filter((s) => s.userId === u.id).length })),
    rename(userId, name) {
      const u = db.users[userId], n = cleanName(name);
      if (!u) return { error: "ログインし直してください" };
      if (!n) return { error: "名前を入力してください" };
      if (Object.values(db.users).some((x) => x.id !== userId && x.name.toLowerCase() === n.toLowerCase())) return { error: "その名前は使われています" };
      u.name = n;
      dirty();
      return { user: publicUser(u) };
    },
    setRole(userId, role) {
      const u = db.users[userId];
      if (!u) return { error: "見つかりません" };
      if (u.role === "admin" && role !== "admin" && Object.values(db.users).filter((x) => x.role === "admin").length <= 1)
        return { error: "最後の管理者は外せません" };
      u.role = role === "admin" ? "admin" : "member";
      dirty();
      return { user: publicUser(u) };
    },
    sweep() {
      sweep();
      dirty();
    },
  };
}

module.exports = { openAccounts, cleanName, sha };
