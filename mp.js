// mp.js — みんなで遊ぶ（ホスト型マルチプレイ）。net.js と game.js の後に読み込む。
// ホストのブラウザが全卓の進行を持ち、各人には「自分の視点の画面データ（view）」だけを送る。
// 全卓が同じタイミングで1ハンドずつ進む（ラウンド制）。人間のいない卓は即座に進む。
const ACT_MS = 25000, // 1回の持ち時間。切れたらチェック（できなければフォールド）
  ASK_MS = 20000, // リエントリーを選ぶ時間
  MP = { watch: {}, me: "", roster: [], open: 0 };
const mpEsc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const mpAuto = (c) => (c.toCall ? { t: "f" } : { t: "c" });
const mpTable = (p) => G.tables.find((t) => t.p.includes(p));
const mpSend = (m) => (Net.isHost() ? mpOnMsg(MP.me, m) : Net.send(m));

// ================= ホスト側：進行 =================
function mpStart() {
  const hum = MP.roster.filter((r) => r.role == "player");
  if (!hum.length) return;
  Net.setStarted(true);
  G = { dur: +$("mps").value * 6e4, lv: 0, entries: 40, lg: [], ty: ls(), mp: 1 };
  G.lvEnd = Date.now() + G.dur;
  const nh = hum.length,
    used = new Set(hum.map((h) => h.name.toLowerCase())),
    nm = shf(NM.filter((n) => !used.has(n.toLowerCase())));
  G.P = hum.map((h, i) => ({
    id: i, oid: "h" + i, name: h.name, hero: 1, pid: h.id, ty: ["—"], stack: 1e4, re: 0, alive: 1,
  }));
  for (let j = 0; j < 40 - nh; j++) {
    const id = nh + j, nc = NC[j];
    G.P.push(
      nc
        ? { ...CPU0, ...nc, id, k: nc.name, oid: nc.name, ty: ["ネームド"], stack: 1e4, re: 0, alive: 1 }
        : { ...fromType(TYC[j % TYC.length]), id, name: nm[j] || "CPU" + j, oid: "c" + id, stack: 1e4, re: 0, alive: 1 },
    );
  }
  G.P.filter((p) => p.k).forEach(loadMem);
  // 人間を各卓に散らし、残りの席をCPUで埋める
  const tb = [...Array(8)].map(() => ({ p: [], btn: -1 }));
  shf(G.P.filter((p) => p.hero)).forEach((p, i) => tb[i % 8].p.push(p));
  const cp = shf(G.P.filter((p) => !p.hero));
  let k = 0;
  tb.forEach((t) => {
    while (t.p.length < 5 && k < cp.length) t.p.push(cp[k++]);
  });
  G.tables = tb;
  Net.bc({ t: "start" });
  mpShowGame();
  mpRound();
}
function mpRound() {
  G.wait = 0;
  while (Date.now() >= G.lvEnd && G.lv < 12) {
    G.lv++;
    G.lvEnd += G.dur;
  }
  const live = [];
  G.tables.forEach((t) => {
    t.gone = [];
    t.lg = [];
    t.req = null;
    if (t.p.some((p) => p.hero && p.alive)) live.push(t);
    else {
      const g = hand(t); // 人間のいない卓は即座に1ハンド進める
      while (!g.next().done);
      bust(t);
    }
  });
  MP.open = live.length;
  if (!live.length) return mpAfter();
  live.forEach((t) => {
    t.g = hand(t);
    mpStep(t);
  });
}
function mpStep(t, v) {
  clearTimeout(t.to);
  t.req = null;
  let r = t.g.next(v);
  while (!r.done) {
    const y = r.value;
    if (y.k == "hero") {
      if (y.p.away) {
        r = t.g.next(mpAuto(y.c));
        continue;
      }
      t.req = y;
      t.rt = Date.now() + ACT_MS;
      t.to = setTimeout(() => mpStep(t, mpAuto(y.c)), ACT_MS);
      return mpPush();
    }
    if (y.k == "tick") {
      mpPush();
      const inHand = t.ps.some((p) => p.hero && !p.fold && !p.allin);
      t.to = setTimeout(() => mpStep(t), inHand ? 480 : 140);
      return;
    }
    r = t.g.next();
  }
  bust(t);
  t.req = null;
  t.g = null;
  mpPush();
  if (--MP.open <= 0) mpAfter();
}
function mpAct(pid, a) {
  const t = G.tables.find((t) => t.req && t.req.p.pid == pid);
  if (!t || !a) return;
  mpStep(t, { t: "frc".includes(a.t) ? a.t : "c", x: Math.round(+a.x) || 0 });
}
function mpAfter() {
  G.wait = 1;
  mpPush();
  setTimeout(mpProcess, 2500);
}
function mpElim(list) {
  list.forEach((p) => {
    p.alive = 0;
    p.ask = 0;
  });
  const pl = alive() + 1; // 同じラウンドで落ちた人は同順位
  list.forEach((p) => (p.place = pl));
}
function mpProcess() {
  const out = G.P.filter((p) => p.hero && p.alive && p.stack <= 0),
    ask = out.filter((p) => G.lv < 2 && !p.re && !p.away);
  mpElim(out.filter((p) => !ask.includes(p)));
  if (!ask.length) return mpNext();
  ask.forEach((p) => (p.ask = 1));
  MP.at = setTimeout(() => {
    mpElim(G.P.filter((p) => p.ask));
    mpNext();
  }, ASK_MS);
  mpPush();
}
function mpRe(pid, y) {
  const p = G.P.find((p) => p.pid == pid && p.ask);
  if (!p) return;
  if (y) {
    p.ask = 0;
    p.stack = 1e4;
    p.re++;
    G.entries++;
  } else mpElim([p]);
  if (!G.P.some((q) => q.ask)) {
    clearTimeout(MP.at);
    mpNext();
  }
}
function mpNext() {
  bal();
  if (alive() <= 1 || !G.P.some((p) => p.hero && p.alive)) {
    G.over = 1;
    const w = G.P.find((p) => p.alive);
    if (w && w.hero) w.place = 1;
    return mpPush();
  }
  mpPush();
  setTimeout(mpRound, 800);
}
function mpOnMsg(from, m) {
  if (!m || !G.mp) return;
  if (m.t == "act") mpAct(from, m.a);
  else if (m.t == "re") mpRe(from, !!m.y);
  else if (m.t == "watch") {
    MP.watch[from] = m.i | 0;
    mpPush();
  }
}
function mpLeft(id) {
  const p = G.mp && G.P.find((p) => p.pid == id);
  if (!p) return;
  p.away = 1; // 切断した人は自動でチェック/フォールド
  if (p.ask) mpRe(id, 0);
  const t = G.tables.find((t) => t.req && t.req.p == p);
  if (t) mpStep(t, mpAuto(t.req.c));
}

// ================= ホスト側：各人への画面データ =================
function mpView(pid) {
  const me = G.P.find((p) => p.pid == pid),
    al = G.P.filter((p) => p.alive),
    [, bb, an] = LV[G.lv],
    play = me && me.alive;
  let ti, T;
  if (play) {
    T = mpTable(me);
    ti = G.tables.indexOf(T);
  } else {
    ti = Math.min(Math.max(0, MP.watch[pid] | 0), G.tables.length - 1);
    T = G.tables[ti];
  }
  const rq = T.req && T.req.p == me ? T.req : null;
  return {
    lv: G.lv, bb, an,
    rem: Math.max(0, G.lvEnd - Date.now()),
    al: al.length, en: G.entries, itm: itm(),
    avg: Math.round(al.reduce((s, p) => s + p.stack, 0) / Math.max(1, al.length)),
    rk: play ? [...al].sort((a, b) => b.stack - a.stack).indexOf(me) + 1 : 0,
    st: play ? me.stack : 0,
    re: play && G.lv < 2 && !me.re ? 1 : 0,
    // 手札は「自分の手札」と「公開された手札」だけを入れる（他の人の手札は送らない）
    pl: T.p.concat(T.gone || []).map((p) => ({
      name: p.name, col: p.col, ty: p.ty[0], stack: p.stack, bet: p.bet, fold: p.fold, lab: p.lab,
      alive: p.alive ? 1 : 0, me: p == me ? 1 : 0, act: T.req && T.req.p == p ? 1 : 0, hd: p.h ? 1 : 0,
      h: (p == me || p.show) && p.h ? p.h : null,
    })),
    bd: T.bd || [],
    pot: (T.ps || []).reduce((s, p) => s + p.tot, 0),
    lg: (T.lg || []).slice(-14),
    req: rq
      ? {
          toCall: rq.c.toCall, cur: rq.c.cur, minR: rq.c.minR, pot: rq.c.pot,
          mx: rq.p.bet + rq.p.stack, stack: rq.p.stack, rem: Math.max(0, T.rt - Date.now()),
        }
      : null,
    ask: me && me.ask ? 1 : 0,
    place: me && !me.alive ? me.place || 0 : 0,
    over: G.over ? 1 : 0, ti, tn: G.tables.length, spec: play ? 0 : 1, wait: G.wait ? 1 : 0,
  };
}
function mpPush() {
  MP.roster.forEach((r) => r.id != MP.me && Net.to(r.id, { t: "view", v: mpView(r.id) }));
  mpRender(mpView(MP.me));
}

// ================= 画面（ホストも参加者も同じ描画） =================
const MA = (t) => mpSend({ t: "act", a: t == "r" ? { t, x: MP.rx } : { t } }),
  MR = (y) => mpSend({ t: "re", y }),
  MW = (i) => {
    if (Net.isHost()) {
      MP.watch[MP.me] = i;
      mpPush();
    } else Net.send({ t: "watch", i });
  },
  MX = (v, s) => {
    v = Math.max(MP.mn, Math.min(MP.mx, +v));
    MP.rx = v;
    $("rv").textContent = +(v / MP.bb).toFixed(1);
    if (s) $("sl").value = v;
  };
function mpRender(v) {
  G.mp = 1;
  MP.v = v;
  MP.bb = v.bb;
  if (G.ty === undefined) G.ty = ls();
  const f = (x) => +(x / v.bb).toFixed(1);
  if (!Net.isHost()) G.lvEnd = Date.now() + v.rem;
  const hs =
    `<b>Lv${v.lv + 1}</b>（BB=${v.bb}点・ante ${+(v.an / v.bb).toFixed(2)}BB） ・ 次Lvまで <b id=tm></b> ・ 残り <b>${v.al}</b>/${v.en}人 ・ ITM ${v.itm}位 ・ 平均 ${f(v.avg)}BB` +
    (v.spec ? " ・ <b>観戦中</b>" : ` ・ あなた <b>${v.rk}位</b>（${f(v.st)}BB）${v.re ? " ・ <b>RE可</b>" : ""}`);
  if (G.hs != hs) {
    G.hs = hs;
    $("hd").innerHTML = hs;
    tmr();
  }
  const seat = (p) =>
    `<div class="s${p.fold ? " f" : ""}${p.act ? " a" : ""}${p.me ? " h" : ""}"><b style="color:${p.col || "inherit"}">${mpEsc(p.name)}</b> <small>${p.me || !G.ty ? "" : mpEsc(p.ty)} ${p.lab || ""}${p.alive ? "" : " バスト"}</small><div>${f(p.stack)} BB</div><div>${p.h ? p.h.map((c) => cd(c)).join("") : p.hd ? cd(0, 1) + cd(0, 1) : "&nbsp;"}</div><em>${p.bet ? "bet " + f(p.bet) : ""}</em></div>`;
  const me = v.pl.find((p) => p.me);
  $("tb").innerHTML = `<div class=row>${v.pl.filter((p) => !p.me).map(seat).join("")}</div><div class=bd>${v.bd.map((c) => cd(c)).join("") || "&nbsp;"}<span>POT ${f(v.pot)} BB</span></div>${me ? seat(me) : ""}`;
  let c = "";
  const q = v.req;
  if (q) {
    const mn = Math.min(q.cur + q.minR, q.mx);
    MP.mn = MP.rx = mn;
    MP.mx = q.mx;
    MP.rt = Date.now() + q.rem;
    c = `<div class=mu>残り <b id=rtv></b> 秒</div>`;
    c += q.toCall
      ? `<button class=g onclick="MA('f')">フォールド</button><button onclick="MA('c')">コール ${f(Math.min(q.toCall, q.stack))}BB</button>`
      : `<button onclick="MA('c')">チェック</button>`;
    if (q.mx > q.cur) {
      const pr = q.cur
        ? [[2, "2x"], [2.5, "2.5x"], [3, "3x"]].map(([k, n]) => [Math.round(q.cur * k), n])
        : [[1 / 3, "1/3 Pot"], [0.5, "1/2 Pot"], [1, "1 Pot"]].map(([k, n]) => [Math.round(q.pot * k), n]);
      c += `<div class=rs><input id=sl type=range min=${mn} max=${q.mx} value=${mn} oninput="MX(this.value)"><button onclick="MA('r')">${q.cur ? "レイズ" : "ベット"} <span id=rv>${f(mn)}</span>BB</button></div><div>${pr.map(([x, n]) => `<button class=g onclick="MX(${x},1)">${n}</button>`).join("")}<button class=g onclick="MX(${q.mx},1)">All-in</button></div>`;
    }
  } else MP.rt = 0;
  if (!q && v.ask)
    c = '<p>バストしました。リエントリー（開始スタック）しますか？</p><button onclick="MR(1)">リエントリー</button><button class=g onclick="MR(0)">終了</button>';
  else if (!q && v.spec)
    c = `<button class=g onclick="MW(${(v.ti + v.tn - 1) % v.tn})">◀</button> 卓 ${v.ti + 1} / ${v.tn} <button class=g onclick="MW(${(v.ti + 1) % v.tn})">▶</button><p class=mu>観戦では、公開された手札だけが見えます</p>`;
  else if (!q) c = `<span class=mu>${v.wait ? "他の卓の終了を待っています…" : "他のプレイヤーのアクション中…"}</span>`;
  $("ct").innerHTML = c;
  $("lg").innerHTML = v.lg.map((s) => `<div>${s}</div>`).join("");
  $("lg").scrollTop = 1e5;
  const ov = (t, s) => {
    $("ov").hidden = 0;
    $("ov").innerHTML = `<h2 style="margin-top:0">${t}</h2><p>${s}</p><button onclick="$('ov').hidden=1">閉じる（観戦を続ける）</button>`;
  };
  if (v.over && !MP.o2) {
    MP.o2 = MP.o1 = 1;
    ov(v.place == 1 ? "🏆 優勝！" : v.place ? `${v.place}位 でフィニッシュ` : "大会が終了しました", v.place ? (v.place <= v.itm ? "ITM（入賞）" : "ITM圏外") : "");
  } else if (v.place && !MP.o1) {
    MP.o1 = 1;
    ov(`${v.place}位 でフィニッシュ`, v.place <= v.itm ? "ITM（入賞）" : "ITM圏外");
  }
}
// ひとり用の render() は残し、みんなで遊ぶ間だけ最後のviewで描き直す（CPUタイプ表示の切替など）
const _render = render;
render = () => (G.mp && MP.v ? mpRender(MP.v) : _render());
setInterval(() => {
  const e = $("rtv");
  if (e && MP.rt) e.textContent = Math.max(0, Math.ceil((MP.rt - Date.now()) / 1000));
}, 300);

// ================= ロビー =================
function mpShowGame() {
  $("mp").hidden = 1;
  $("start").hidden = 1;
  $("game").hidden = 0;
}
function mpOpen() {
  $("mp").hidden = 0;
  $("start").hidden = 1;
}
function mpRoster(r) {
  MP.roster = r;
  const ul = $("mpR");
  ul.textContent = "";
  r.forEach((p) => {
    const li = document.createElement("li");
    li.textContent = p.name + (p.id === MP.me ? "（あなた）" : "");
    const t = document.createElement("span");
    t.className = "tag";
    t.textContent = (p.host ? "ホスト・" : "") + (p.role === "spec" ? "観戦" : "プレイヤー");
    li.appendChild(t);
    if (Net.isHost() && !p.host && !G.mp) {
      const b = document.createElement("button");
      b.className = "g";
      b.textContent = "退出させる";
      b.onclick = () => Net.kick(p.id);
      li.appendChild(b);
    }
    ul.appendChild(li);
  });
  if (G.mp && Net.isHost()) mpPush(); // 開始後に入った観戦者へ最初の画面を送る
}
function mpUI() {
  const qs = new URLSearchParams(location.search),
    HM = qs.has("host"),
    RM = qs.get("r"),
    err = (s) => ($("mpM").textContent = s || "");
  $("mp").innerHTML = `<h3 style="margin-top:0">みんなで遊ぶ</h3><div id="mpE">
<div id="mpH" ${HM ? "" : "hidden"}><input id="mhn" type="text" maxlength="12" placeholder="プレイヤー名"><input id="mhp" type="password" placeholder="パスワード（参加者に伝える）"><p>ブラインド間隔：<select id="mps"><option value="5">5分（標準）</option><option value="2">2分</option><option value="1">1分</option></select></p><button id="mhb">部屋を作る</button></div>
<div id="mpJ" ${HM ? "hidden" : ""}><input id="mjr" type="text" placeholder="部屋ID（例: alp-xxxxx）"><input id="mjn" type="text" maxlength="12" placeholder="プレイヤー名"><input id="mjp" type="password" placeholder="パスワード"><label><input type="radio" name="mro" value="player" checked> プレイヤー</label> <label><input type="radio" name="mro" value="spec"> 観戦</label><br><button id="mjb">入室</button></div>
<p id="mpM" class="err"></p></div>
<div id="mpRm" hidden><div id="mpI"></div><h4>参加者</h4><ul id="mpR" style="padding-left:20px"></ul><div id="mpC"></div><p id="mpS" class="ok"></p></div>
<p><a href="${location.pathname}">ひとりで遊ぶに戻る</a></p>`;
  if (RM) $("mjr").value = RM;
  if (HM || RM) {
    $("mp").hidden = 0;
    $("start").hidden = 1;
  }
  const inRoom = () => {
    $("mpE").hidden = 1;
    $("mpRm").hidden = 0;
  };
  $("mhb").onclick = () => {
    const n = $("mhn").value.trim(), p = $("mhp").value;
    if (!n || !p) return err("名前とパスワードを入力してください");
    err("部屋を作成中…");
    Net.host(n, p, {
      ready: (id) => {
        MP.me = id;
        err("");
        inRoom();
        const url = location.origin + location.pathname + "?r=" + id;
        $("mpI").innerHTML = '<p>部屋ID：<code></code> <button class="g" id="mcp">招待URLをコピー</button></p><p class="mu">パスワードは別の方法で伝えてください。</p>';
        $("mpI").querySelector("code").textContent = id;
        $("mcp").onclick = () => navigator.clipboard && navigator.clipboard.writeText(url).then(() => ($("mcp").textContent = "コピーしました"));
        $("mpC").innerHTML = '<button id="mgo">ゲーム開始</button>';
        $("mgo").onclick = mpStart;
      },
      roster: mpRoster, msg: mpOnMsg, left: mpLeft, error: (e) => err("エラー：" + e),
    });
  };
  $("mjb").onclick = () => {
    const id = $("mjr").value.trim(), n = $("mjn").value.trim(), p = $("mjp").value;
    if (!id || !n || !p) return err("すべて入力してください");
    err("接続中…");
    Net.join(id, n, p, document.querySelector("input[name=mro]:checked").value, {
      joined: (m) => {
        MP.me = m.id;
        err("");
        inRoom();
        $("mpI").textContent = `部屋 ${m.room} に入室しました（${m.role === "spec" ? "観戦" : "プレイヤー"}）。ホストの開始を待っています。`;
        if (m.started) mpShowGame();
      },
      roster: mpRoster,
      msg: (f, m) => {
        if (m.t == "start") mpShowGame();
        else if (m.t == "view") mpRender(m.v);
      },
      error: (e) => err(e),
      closed: () => ($("mpS").textContent = "接続が切れました"),
    });
  };
}
mpUI();
