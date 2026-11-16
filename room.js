// room.js — みんなで遊ぶ「部屋」の中身。画面にも通信方式にも触らない（ブラウザでも Node でも動く）。
//   createRoom: 大会の進行。全卓が同じタイミングで1ハンドずつ進む（ラウンド制）。人間のいない卓は即座に進む。
//               各人には「自分の視点の画面データ（view）」だけを送る（他の人の手札は送らない）。
//   createHost: 入室の受付（パスワード・名前・復帰用の合言葉・退出）と、createRoom をつなぐ。
//               「誰にどう届けるか」は send / close として外から渡す。PeerJS でも WebSocket でも同じものを使う。
// ブラウザでは <script> で読み込むと AlpRoom という名前で使える。Node では require("./room.js")。
(function (root) {
"use strict";
const E = typeof AlpEngine != "undefined" ? AlpEngine : require("./engine.js");
const { LV, CPU0, TYC, NM, NC, fromType, shf, alive, itm, hand, bust, bal, advanceLevel, autoAct, playHand, loadMem, histView, ringSeats, potOf } = E;
const ACT_MS = 25000, // 1回の持ち時間。切れたらチェック（できなければフォールド）して離席扱いにする
  ASK_MS = 20000; // リエントリーを選ぶ時間
const realClock = {
  now: () => Date.now(),
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (id) => clearTimeout(id),
};
const memStore = () => {
  const m = new Map();
  return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v) };
};

// ================= 大会の進行 =================
// o.deliver(id, msg): その人へメッセージを届ける
// o.members(): 画面データを送る相手の id 一覧（プレイヤーも観戦者も）
// o.local: ホスト自身がこの場で遊ぶときの id（その人の画面は最後に更新する）。サーバーでは不要
// o.store: ネームドCPUの記憶の保存先 { get, set }（省略するとその場限り）
// o.clock: { now, setTimeout, clearTimeout }（テストで時間を早送りするため。省略すると本物の時計）
// o.onOver(g): 大会が終わったとき（サーバーでハンド履歴をファイルに残すのに使う）
// 記録用（サーバーで DB に書くのに使う。どれも省略できる）
// o.onStart(g): 大会が始まったとき / o.onHand(g, H): ハンドが1つ終わって g.hist に入ったとき
// o.onRound(g): ラウンドの処理（バスト・順位・リエントリー）が済んだとき
function createRoom(o) {
  const ck0 = o.clock || realClock,
    // stop() のあとは、残っているタイマーが来ても何もしない（サーバーで部屋を片付けるとき用）
    ck = { now: ck0.now, setTimeout: (f, ms) => ck0.setTimeout(() => !stopped && f(), ms), clearTimeout: ck0.clearTimeout },
    store = o.store || memStore(),
    watch = {}, // 観戦中の人が見ている卓
    asked = {}; // ハンド履歴を最後に求められた時刻（続けて何度も送らないため）
  let stopped = false,
    g = null, // 大会の状態（開始前は null）
    open = 0, // このラウンドで人間の操作を待っている卓の数
    at = 0, // リエントリー確認の締め切りタイマー
    overHist = null; // 大会が終わったあとに送るハンド履歴の写し
  const tableOf = (p) => g.tables.find((t) => t.p.includes(p));
  // 席に着いていて、操作を待つ必要がある人間（離席中の人は自動で進める）
  const here = (p) => p.hero && p.alive && !p.away;
  const tlog = (t) => (s) => (t.lg ||= []).push(s);
  // ポットを数える席：直前のハンドの席（T.ps）のうち、今もこの卓にいる人（バストした人も含む）
  // （卓の組み替えでほかの卓へ移った人は、その卓で新しいハンドを打っているかもしれないので数えない）
  const potSeats = (T) => (T.ps || []).filter((p) => T.p.includes(p) || (T.gone || []).includes(p));

  // players: [{ id, name, uid }]（人間のプレイヤー。順番どおりに番号を振る。uid はアカウントの ID、ゲストは null）
  // durMin: ブラインド間隔（分）
  function start(players, durMin) {
    if (g || !players.length) return false;
    g = { dur: durMin * 6e4, lv: 0, entries: 40, mp: 1, hist: [], now: ck.now };
    g.lvEnd = ck.now() + g.dur;
    const nh = players.length,
      used = new Set(players.map((h) => h.name.toLowerCase())),
      nm = shf(NM.filter((n) => !used.has(n.toLowerCase())));
    // rec: 打ち方の記録（VPIP など。engine.js の track が数える。大会結果と一緒に残し、身内CPU作りに使う）
    g.P = players.map((h, i) => ({
      id: i, oid: "h" + i, name: h.name, uid: h.uid || null, hero: 1, pid: h.id, ty: ["—"], stack: 1e4, re: 0, alive: 1, rec: [{}],
    }));
    for (let j = 0; j < 40 - nh; j++) {
      const id = nh + j, nc = NC[j];
      g.P.push(
        nc
          ? { ...CPU0, ...nc, id, k: nc.name, oid: nc.name, ty: ["ネームド"], stack: 1e4, re: 0, alive: 1 }
          : { ...fromType(TYC[j % TYC.length]), id, name: nm[j] || "CPU" + j, oid: "c" + id, stack: 1e4, re: 0, alive: 1 },
      );
    }
    g.P.filter((p) => p.k).forEach((p) => loadMem(p, store));
    // 人間を各卓に散らし、残りの席をCPUで埋める
    const tb = [...Array(8)].map(() => ({ p: [], btn: -1 }));
    shf(g.P.filter((p) => p.hero)).forEach((p, i) => tb[i % 8].p.push(p));
    const cp = shf(g.P.filter((p) => !p.hero));
    let k = 0;
    tb.forEach((t) => {
      while (t.p.length < 5 && k < cp.length) t.p.push(cp[k++]);
    });
    g.tables = tb;
    each((id) => o.deliver(id, { t: "start" }));
    o.onStart && o.onStart(g);
    round();
    return true;
  }
  // 終わったハンドを、記録の係（onHand）へ1件ずつ渡す
  let handed = 0;
  function flush() {
    if (!o.onHand) return;
    while (handed < g.hist.length) o.onHand(g, g.hist[handed++]);
  }
  function round() {
    g.wait = 0;
    advanceLevel(g, ck.now());
    const live = [];
    g.tables.forEach((t) => {
      t.gone = [];
      t.lg = [];
      t.req = null;
      if (t.p.some(here)) live.push(t);
      else {
        playHand(g, t, tlog(t)); // 操作する人間のいない卓は即座に1ハンド進める
        bust(g, t);
        flush();
      }
    });
    open = live.length;
    if (!live.length) return after();
    live.forEach((t) => {
      t.g = hand(g, t, tlog(t));
      step(t);
    });
  }
  function step(t, v) {
    ck.clearTimeout(t.to);
    t.req = null;
    let r = t.g.next(v);
    while (!r.done) {
      const y = r.value;
      if (y.k == "hero") {
        if (y.p.away) {
          r = t.g.next(autoAct(y.c));
          continue;
        }
        t.req = y;
        t.rt = ck.now() + ACT_MS;
        t.to = ck.setTimeout(() => {
          y.p.away = 1; // 時間切れの人は、本人が「戻る」を押すまで自動で進める
          step(t, autoAct(y.c));
        }, ACT_MS);
        return push();
      }
      if (y.k == "tick") {
        push();
        const inHand = t.ps.some((p) => p.hero && !p.away && !p.fold && !p.allin);
        t.to = ck.setTimeout(() => step(t), inHand ? 480 : 140);
        return;
      }
      r = t.g.next();
    }
    bust(g, t);
    flush();
    t.req = null;
    t.g = null;
    push();
    if (--open <= 0) after();
  }
  function act(pid, a) {
    const t = g.tables.find((t) => t.req && t.req.p.pid == pid);
    if (!t || !a) return;
    step(t, { t: "frc".includes(a.t) ? a.t : "c", x: Math.round(+a.x) || 0 });
  }
  function after() {
    g.wait = 1;
    push();
    ck.setTimeout(process, 2500);
  }
  function elim(list) {
    list.forEach((p) => {
      p.alive = 0;
      p.ask = 0;
    });
    const pl = alive(g) + 1; // 同じラウンドで落ちた人は同順位
    list.forEach((p) => (p.place = pl));
  }
  function process() {
    const out = g.P.filter((p) => p.hero && p.alive && p.stack <= 0),
      ask = out.filter((p) => g.lv < 2 && !p.re && !p.away);
    elim(out.filter((p) => !ask.includes(p)));
    if (!ask.length) return next();
    ask.forEach((p) => (p.ask = 1));
    at = ck.setTimeout(() => {
      elim(g.P.filter((p) => p.ask));
      next();
    }, ASK_MS);
    push();
  }
  function re(pid, y) {
    const p = g.P.find((p) => p.pid == pid && p.ask);
    if (!p) return;
    if (y) {
      p.ask = 0;
      p.stack = 1e4;
      p.re++;
      g.entries++;
    } else elim([p]);
    if (!g.P.some((q) => q.ask)) {
      ck.clearTimeout(at);
      next();
    }
  }
  function next() {
    bal(g);
    flush();
    o.onRound && o.onRound(g);
    if (alive(g) <= 1 || !g.P.some((p) => p.hero && p.alive)) {
      g.over = 1;
      const w = g.P.find((p) => p.alive);
      if (w && w.hero) w.place = 1;
      push();
      return o.onOver && o.onOver(g);
    }
    push();
    ck.setTimeout(round, 800);
  }
  // 離席から戻る
  function back(pid) {
    const p = g.P.find((p) => p.pid == pid);
    if (!p || !p.away) return;
    p.away = 0;
    push();
  }
  // 参加者からのメッセージ
  function msg(from, m) {
    if (!m || !g) return;
    if (m.t == "act") act(from, m.a);
    else if (m.t == "re") re(from, !!m.y);
    else if (m.t == "back") back(from);
    else if (m.t == "hands") hands(from);
    else if (m.t == "watch") {
      watch[from] = m.i | 0;
      push();
    }
  }
  // ハンド履歴を送る。大会中は「自分が配られたハンド」だけで、見えるのは自分の手札と公開された手札だけ。
  // 大会が終わったら、全ハンドを全員の手札つきで送る（終わってから振り返るため）
  function hands(from) {
    const now = ck.now();
    if (now - (asked[from] || 0) < 2000) return o.deliver(from, { t: "hands", busy: 1 }); // 中身は送らないが、待っている画面には知らせる
    asked[from] = now;
    const me = g.P.find((p) => p.pid == from);
    // 終わったあとは履歴が変わらないので、写し（uid を外したもの）は1回だけ作る
    const h = g.over ? (overHist ||= histView(g.hist, null)) : histView(g.hist, me ? me.oid : "");
    o.deliver(from, { t: "hands", over: g.over ? 1 : 0, h });
  }
  // 接続が切れた人（退出させた人も）は、自動でチェック/フォールドにする
  function left(id) {
    const p = g && g.P.find((p) => p.pid == id);
    if (!p) return;
    p.away = 1;
    // リエントリーの確認中なら、締め切りまで待つ（その間に戻ってくれば選べる）
    const t = g.tables.find((t) => t.req && t.req.p == p);
    if (t) step(t, autoAct(t.req.c));
  }
  // 合言葉で入り直した人：席の持ち主を新しい接続に付け替えて、離席を解く
  function rejoin(old, id) {
    if (watch[old] != null) watch[id] = watch[old];
    delete watch[old];
    if (!g) return;
    const p = g.P.find((p) => p.pid == old);
    if (p) {
      p.pid = id;
      p.away = 0;
    }
  }

  // ---- 各人への画面データ ----
  function view(pid) {
    const me = g.P.find((p) => p.pid == pid),
      al = g.P.filter((p) => p.alive),
      [, bb, an] = LV[g.lv],
      play = me && me.alive,
      now = ck.now();
    let ti, T;
    if (play) {
      T = tableOf(me);
      ti = g.tables.indexOf(T);
    } else {
      ti = Math.min(Math.max(0, watch[pid] | 0), g.tables.length - 1);
      T = g.tables[ti];
    }
    const rq = T.req && T.req.p == me ? T.req : null;
    return {
      lv: g.lv, bb, an,
      rem: Math.max(0, g.lvEnd - now),
      al: al.length, en: g.entries, itm: itm(g),
      avg: Math.round(al.reduce((s, p) => s + p.stack, 0) / Math.max(1, al.length)),
      rk: play ? [...al].sort((a, b) => b.stack - a.stack).indexOf(me) + 1 : 0,
      st: play ? me.stack : 0,
      re: play && g.lv < 2 && !me.re ? 1 : 0,
      // 手札は「自分の手札」と「公開された手札」だけを入れる（他の人の手札は送らない）
      // 席は卓の絵の順（直前のハンドの席順。バストした人もその位置に残す）
      pl: ringSeats(T.p, T.ps, T.gone).map((p) => ({
        name: p.name, col: p.col, ty: p.ty[0], stack: p.stack, bet: p.bet, fold: p.fold, lab: p.lab,
        alive: p.alive ? 1 : 0, me: p == me ? 1 : 0, act: T.req && T.req.p == p ? 1 : 0, hd: p.h ? 1 : 0,
        h: (p == me || p.show) && p.h ? p.h : null,
      })),
      bd: T.bd || [],
      // 卓の合計と、このストリートのベット（同じ席の一覧から数える。画面の POT は pot − bets）
      ...(({ total, bets }) => ({ pot: total, bets }))(potOf(potSeats(T))),
      lg: (T.lg || []).slice(-14),
      req: rq
        ? {
            toCall: rq.c.toCall, cur: rq.c.cur, minR: rq.c.minR, pot: rq.c.pot,
            mx: rq.p.bet + rq.p.stack, stack: rq.p.stack, rem: Math.max(0, T.rt - now),
          }
        : null,
      ask: me && me.ask ? 1 : 0,
      away: play && me.away ? 1 : 0,
      place: me && !me.alive ? me.place || 0 : 0,
      over: g.over ? 1 : 0, ti, tn: g.tables.length, spec: play ? 0 : 1, wait: g.wait ? 1 : 0,
    };
  }
  // 全員（ホスト自身は最後）へ
  function each(f) {
    const ids = o.members();
    ids.forEach((id) => id != o.local && f(id));
    if (o.local != null && ids.includes(o.local)) f(o.local);
  }
  function push() {
    if (g) each((id) => o.deliver(id, { t: "view", v: view(id) }));
  }

  return {
    start, msg, left, rejoin, push, view, potSeats,
    started: () => !!g,
    state: () => g,
    stop: () => (stopped = true),
  };
}

// ================= 入室の受付 =================
// o.password: 部屋のパスワード
// o.send(id, msg) / o.close(id): 接続 id へ送る・接続を閉じる（通信方式ごとに用意する）
// o.local: { id, name, deliver(msg) } ホスト自身がこの場で遊ぶとき（ブラウザのホスト）。サーバーでは省略
// o.onRoster(full): 参加者一覧が変わったとき（ホストの画面用。full には host の印も入る）
// o.adminKey: 部屋を作った人の合言葉（サーバー用）。join でこれを送った人は、開始・退出をメッセージで操作できる
// ---- アカウント（簡易サーバーでログインしているとき。どれも省略できる） ----
// o.userOf(id): その接続のアカウント { id, name, role } か null（ゲスト）
//   アカウントで入る人は、名前もパスワードも要らない。同じアカウントで入り直すと同じ席に戻る（端末をまたいでも）
// o.ownerUid: 部屋を作った人のアカウント ID。その人と、サイトの管理者（role "admin"）は開始・退出を操作できる
// o.guests: false ならゲスト（アカウントなし）は入れない（既定は入れる）
// o.reservedName(name): その名前がアカウントの表示名と重なるか（ゲストには使わせない）
// o.store, o.clock, o.onOver, o.onStart, o.onHand, o.onRound: createRoom と同じ
function createHost(o) {
  const ck = o.clock || realClock,
    rid = () => Math.random().toString(36).slice(2, 7),
    secret = () => [...globalThis.crypto.getRandomValues(new Uint32Array(4))].map((x) => x.toString(36)).join(""),
    hostAlias = "u" + rid(),
    conns = new Set(), // 入室済みの接続
    kicked = new Set(), // 退出させた接続（閉じるまでの間に入り直させない）
    toks = {}, // 発行した合言葉: tok -> { name, role, id, admin, uid }（id は今つながっている接続）
    admins = new Set(), // 開始・退出を操作できる接続
    banned = new Set(); // 退出させたアカウント（この部屋には入り直せない）
  let started = false,
    roster = []; // [{ id, name, role, host, uid }]
  const local = o.local;
  if (local) roster.push({ id: local.id, name: local.name, role: "player", host: true });
  const say = (id, m) => (local && id == local.id ? local.deliver(m) : conns.has(id) && o.send(id, m));
  const room = createRoom({
    deliver: say,
    members: () => roster.map((p) => p.id),
    local: local && local.id,
    store: o.store,
    clock: ck,
    onOver: o.onOver && ((g) => o.onOver(g, roster.slice())),
    onStart: o.onStart,
    onHand: o.onHand,
    onRound: o.onRound,
  });
  const tokOf = (id) => Object.keys(toks).find((k) => toks[k].id === id);

  function pushRoster() {
    const full = roster.map(({ id, name, role, host }) => ({ id, name, role, host: !!host }));
    // 参加者には「ホスト」の印を送らない。ホストの id は部屋 ID と同じなので、別の仮 id に置き換える
    const pub = roster.map(({ id, name, role, host }) => ({ id: host ? hostAlias : id, name, role }));
    conns.forEach((id) => o.send(id, { t: "roster", r: pub }));
    o.onRoster && o.onRoster(full);
    room.push(); // 開始後に入った観戦者へ最初の画面を送る
  }
  function drop(id) {
    conns.delete(id);
    admins.delete(id);
    roster = roster.filter((p) => p.id !== id);
    pushRoster();
    room.left(id);
  }
  const refuse = (id, why) => {
    o.send(id, { t: "no", why });
    ck.setTimeout(() => o.close(id), 300);
  };
  // 操作できる人：部屋を作った人の合言葉（keyOk）か、部屋を作ったアカウント・サイトの管理者（acctAdmin）
  const keyOk = (m) => !!o.adminKey && m.adm === o.adminKey,
    acctAdmin = (u) => !!u && (u.id === o.ownerUid || u.role === "admin");
  const cleanName = (s) => String(s || "").replace(/[<>&"'`]/g, "").trim().slice(0, 12);
  // 切断中の人の名前も、本人が戻ってこられるように取っておく
  const nameUsed = (name) =>
    roster.map((p) => p.name).concat(Object.values(toks).map((t) => t.name)).some((n) => n.toLowerCase() === name.toLowerCase());
  function join(id, m) {
    if (conns.has(id) || kicked.has(id)) return; // 入室済みの接続からの2回目の join は無視
    const u = (o.userOf && o.userOf(id)) || null;
    if (u) {
      if (banned.has(u.id)) return refuse(id, "この部屋からは退出させられています");
      // ゲストとして座っていた人が途中でログインしたとき：復帰用の合言葉があれば、その席に戻す（アカウントの席がまだないときだけ）
      const g = typeof m.tok === "string" && Object.prototype.hasOwnProperty.call(toks, m.tok) && toks[m.tok];
      if (g && g.uid == null && !Object.values(toks).some((x) => x.uid === u.id)) return rejoin(id, m.tok, g);
      return joinAccount(id, m, u);
    }
    if (o.guests === false) return refuse(id, "この部屋はメンバー専用です。ログインしてから入ってください");
    if (m.pw !== o.password) return refuse(id, "パスワードが違います");
    const tk = typeof m.tok === "string" && Object.prototype.hasOwnProperty.call(toks, m.tok) && toks[m.tok];
    if (tk) return rejoin(id, m.tok, tk);
    const name = cleanName(m.name);
    if (!name) return refuse(id, "名前を入力してください");
    if (o.reservedName && o.reservedName(name)) return refuse(id, "その名前はメンバーが使っています。別の名前にするか、ログインしてください");
    if (nameUsed(name)) return refuse(id, "その名前は使われています");
    enter(id, { name, role: m.role, key: keyOk(m), admin: keyOk(m), uid: null });
  }
  // アカウントで入る：パスワードも名前も要らない。同じアカウントの席がすでにあれば、そこへ戻る
  function joinAccount(id, m, u) {
    const t = Object.keys(toks).find((k) => toks[k].uid === u.id);
    if (t) {
      const tk = toks[t];
      tk.key = tk.key || keyOk(m);
      tk.admin = tk.key || acctAdmin(u); // アカウントの権限は、入り直すたびに今の役割で決め直す
      if (!started) tk.role = m.role === "player" ? "player" : "spec"; // 開始前なら、プレイヤー/観戦を選び直せる
      return rejoin(id, t, tk, "別の画面でこの部屋に入りました");
    }
    // 先にいるゲストと名前が重なったら、後ろに番号を付ける（メンバーは名前を入力できないので、断らない）
    const base = cleanName(u.name) || "player";
    let name = base;
    for (let i = 2; nameUsed(name); i++) name = base.slice(0, 12 - String(i).length) + i;
    enter(id, { name, role: m.role, key: keyOk(m), admin: keyOk(m) || acctAdmin(u), uid: u.id });
  }
  function enter(id, { name, role, key, admin, uid }) {
    // 開始後はプレイヤー参加不可（観戦のみ）
    role = role === "player" && !started ? "player" : "spec";
    const tok = secret();
    toks[tok] = { name, role, id, key, admin, uid };
    conns.add(id);
    if (admin) admins.add(id);
    roster.push({ id, name, role, uid });
    o.send(id, { t: "ok", id, room: o.roomId, role, started, tok, name, admin: admin ? 1 : 0, member: uid ? 1 : 0 });
    pushRoster();
  }
  // 合言葉（またはアカウント）での復帰。前の接続がまだ残っていれば、そちらを閉じて置き換える
  //   why を渡すと、前の接続に「入り直しても無駄」な理由として伝える（別の画面と席を奪い合い続けないように）
  function rejoin(id, tok, tk, why) {
    const old = tk.id;
    if (conns.delete(old)) {
      if (why) o.send(old, { t: "no", why });
      o.close(old);
    }
    admins.delete(old);
    roster = roster.filter((p) => p.id !== old);
    tk.id = id;
    conns.add(id);
    if (tk.admin) admins.add(id);
    roster.push({ id, name: tk.name, role: tk.role, uid: tk.uid });
    o.send(id, { t: "ok", id, room: o.roomId, role: tk.role, started, tok, name: tk.name, back: 1, admin: tk.admin ? 1 : 0, member: tk.uid ? 1 : 0 });
    room.rejoin(old, id);
    pushRoster();
  }

  // 部屋を作った人の操作：開始（ブラインド間隔は 1・2・5 分から）・退出させる
  function admin(id, m) {
    if (m.a === "start") api.start([1, 2, 5].includes(+m.dur) ? +m.dur : 5);
    else if (m.a === "kick" && m.id !== id) api.kick(m.id);
  }
  if (local) pushRoster(); // ホスト自身を一覧に出す
  const api = {
    // 接続 id からメッセージが届いた
    data(id, m) {
      if (!m) return;
      if (m.t === "join") return join(id, m);
      if (!conns.has(id)) return; // 入室済みの人のメッセージだけ受け付ける
      // アカウントで入った人：今もログインしているか（止められた・ログアウトさせられた人は、ここで外す。席は残り、入り直せば戻れる）
      const tk = toks[tokOf(id)], u = tk && tk.uid ? (o.userOf && o.userOf(id)) || null : null;
      if (tk && tk.uid && (!u || u.id !== tk.uid)) {
        o.send(id, { t: "no", why: "ログインが切れました。ログインし直してから入ってください" });
        ck.setTimeout(() => o.close(id), 300);
        return drop(id);
      }
      // 操作の権限は、今の役割で確かめる（サイトの管理者から外された人は、すぐ操作できなくなる）
      if (m.t === "admin") return admins.has(id) && (!tk || !tk.uid || tk.key || acctAdmin(u)) && admin(id, m);
      room.msg(id, m);
    },
    // 接続 id が切れた
    closed(id) {
      kicked.delete(id);
      if (conns.has(id)) drop(id);
    },
    // ホスト自身の操作
    localMsg: (m) => local && room.msg(local.id, m),
    kick(id) {
      if (!conns.has(id)) return;
      const t = tokOf(id);
      if (t) {
        if (toks[t].uid) banned.add(toks[t].uid); // アカウントなら、この部屋には入り直せない
        delete toks[t]; // 退出させた人は合言葉で戻れない
      }
      o.send(id, { t: "kick" });
      kicked.add(id);
      ck.setTimeout(() => o.close(id), 300);
      drop(id);
    },
    // 開始。プレイヤー役の人で大会を作る
    start(durMin) {
      const hum = roster.filter((r) => r.role == "player");
      if (started || !hum.length) return false;
      started = true;
      return room.start(hum.map(({ id, name, uid }) => ({ id, name, uid })), durMin);
    },
    roster: () => roster.slice(),
    // 誰もつながっていないか（サーバーで空き部屋を片付ける目安）
    empty: () => conns.size == 0,
    stop: () => room.stop(),
    room,
  };
  return api;
}

const api = { createRoom, createHost, ACT_MS, ASK_MS };
if (typeof module == "object" && module.exports) module.exports = api;
else root.AlpRoom = api;
})(this);
