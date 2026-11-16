// mp.js — みんなで遊ぶ（ホスト型マルチプレイ）の画面とロビー。engine.js・room.js・net.js・game.js の後に読み込む。
// 大会の進行と入室の受付は room.js、通信は net.js にある。ここは「見せる」と「つなぐ」だけ。
// ホストのブラウザでは room.js の部屋をそのまま動かし、参加者には通信で画面データ（view）を送る。
let HOST = null; // ホストのブラウザで部屋を持っているとき：room.js の createHost
const MP = { me: "", roster: [], admin: 0 }; // admin: 簡易サーバーで部屋を作った人（開始・退出の操作ができる）
// 簡易サーバー（server/server.js）から配信されているか。そうなら部屋はサーバーが持ち、通信は WebSocket にする
// そうでなければ（ファイルを直接開いた・静的なホスティング）、これまでどおり PeerJS でホストのブラウザが部屋を持つ
const SRV = /^https?:$/.test(location.protocol)
  ? fetch("api/hello", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (j && j.server ? j : null))
      .catch(() => null)
  : Promise.resolve(null);
const mpEsc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// 自分の操作を部屋へ送る（ホストなら手元の部屋へ、参加者ならホストへ）
const mpSend = (m) => (HOST ? HOST.localMsg(m) : Net.send(m));
// 部屋から自分あてに届いたもの（ホストは手元の部屋から、参加者は通信で）
function mpRecv(m) {
  if (m.t == "start") mpShowGame();
  else if (m.t == "view") mpRender(m.v);
  else if (m.t == "hands" && MP.hx) {
    const kind = MP.hx;
    MP.hx = "";
    if (m.busy) return ($("hxm").textContent = "少し待ってから、もう一度押してください");
    saveHands(Array.isArray(m.h) ? m.h : [], kind, m.over ? "（全員の手札つき）" : "（大会中なので、自分の手札と公開された手札だけ）");
  }
}
// ハンド履歴を部屋に頼む（届いたら mpRecv で保存する）
function mpHands(kind) {
  MP.hx = kind;
  $("hxm").textContent = "ハンド履歴を取得しています…";
  mpSend({ t: "hands" });
}

// ================= 画面（ホストも参加者も同じ描画） =================
// ホストから届いた画面データを、そのまま HTML に入れても安全な形に直す
// 数値は数値に、札は 0〜51 の整数に、文字はエスケープ済みに。ログは札の表示（cd の出力）だけを許す
const mpN = (x) => (Number.isFinite(+x) ? +x : 0),
  mpCards = (a) => (Array.isArray(a) ? a.map((c) => c | 0).filter((c) => c >= 0 && c < 52) : null),
  mpLog = (s) =>
    mpEsc(s).replace(
      /&lt;i class=&quot;c s([0-3])&quot;&gt;([2-9TJQKA][♠♥♦♣])&lt;\/i&gt;/g,
      '<i class="c s$1">$2</i>',
    );
function mpClean(v) {
  const o = {};
  for (const k of ["lv", "bb", "an", "rem", "al", "en", "itm", "avg", "rk", "st", "re", "pot", "bets", "ask", "away", "place", "over", "ti", "tn", "spec", "wait"])
    o[k] = mpN(v[k]);
  o.lv = Math.min(Math.max(0, o.lv | 0), LV.length - 1);
  o.bb = o.bb || 1;
  o.tn = Math.max(1, o.tn | 0);
  o.ti = Math.min(Math.max(0, o.ti | 0), o.tn - 1);
  o.bd = mpCards(v.bd) || [];
  o.lg = (Array.isArray(v.lg) ? v.lg : []).slice(-14).map(mpLog);
  o.pl = (Array.isArray(v.pl) ? v.pl : []).map((p) => ({
    name: mpEsc(p.name), ty: mpEsc(p.ty == null ? "" : p.ty), lab: mpEsc(p.lab || ""),
    col: /^#[0-9a-f]{3,8}$/i.test(p.col) ? p.col : "",
    stack: mpN(p.stack), bet: mpN(p.bet), fold: p.fold ? 1 : 0, alive: p.alive ? 1 : 0,
    me: p.me ? 1 : 0, act: p.act ? 1 : 0, hd: p.hd ? 1 : 0, h: mpCards(p.h),
  }));
  const q = v.req;
  o.req = q && typeof q == "object" ? Object.fromEntries(["toCall", "cur", "minR", "pot", "mx", "stack", "rem"].map((k) => [k, mpN(q[k])])) : null;
  return o;
}
const MA = (t) => mpSend({ t: "act", a: t == "r" ? { t, x: MP.rx } : { t } }),
  MR = (y) => mpSend({ t: "re", y }),
  MB = () => mpSend({ t: "back" }),
  MW = (i) => mpSend({ t: "watch", i }),
  MX = (v, s) => {
    v = Math.max(MP.mn, Math.min(MP.mx, +v));
    MP.rx = v;
    $("rv").textContent = +(v / MP.bb).toFixed(1);
    if (s) $("sl").value = v;
  };
function mpRender(v) {
  MP.v = v; // 描き直し用に、届いたままの形で持っておく
  v = mpClean(v);
  G.mp = 1;
  MP.bb = v.bb;
  if (G.ty === undefined) G.ty = ls();
  const f = (x) => +(x / v.bb).toFixed(1);
  G.lvEnd = Date.now() + v.rem;
  const hs = hdHtml({ lv: v.lv, bb: v.bb, an: v.an, al: v.al, en: v.en, itm: v.itm, avg: f(v.avg), rk: v.rk, st: f(v.st), re: v.re, spec: v.spec && !v.place, done: !!v.place, place: v.place });
  if (G.hs != hs) {
    G.hs = hs;
    $("hd").innerHTML = hs;
    tmr();
  }
  const seat = (p) =>
    seatHtml({
      name: p.name,
      col: p.col,
      sub: [p.me || !G.ty ? "" : p.ty, p.alive ? "" : "バスト"].filter(Boolean).join(" "),
      lab: p.lab,
      stack: f(p.stack),
      cards: p.h ? p.h.map((c) => cd(c)).join("") : p.hd ? cd(0, 1) + cd(0, 1) : "",
      fold: p.fold,
      act: p.act,
      me: p.me,
      bet: p.bet ? f(p.bet) : 0,
    });
  // 席の順に円に並べる。あなたを下に置き、そこから時計回り（観戦では卓の最初の席が下）
  $("tb").className = "ring";
  $("tb").innerHTML = tableHtml(
    fromMe(v.pl, (p) => p.me).map(seat),
    `<div class=bd>${v.bd.map((c) => cd(c)).join("") || "&nbsp;"}${potHtml(v.pot, v.bets, f)}</div>`,
  );
  const q = v.req;
  MP.rt = q ? Date.now() + q.rem : 0;
  // 操作欄は、中身が変わったときだけ作り直す（他の卓が進むたびに画面データが届くため。
  // 毎回作り直すと、動かしかけたスライダーや選びかけたレイズ額が最小に戻ってしまう）
  const ck = JSON.stringify([q && { ...q, rem: 0 }, v.bb, v.ask, v.away, v.spec, v.ti, v.tn, v.wait]);
  if (ck != MP.ck) {
    MP.ck = ck;
    $("ct").innerHTML = mpControls(v, f);
  }
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
function mpControls(v, f) {
  let c = "";
  const q = v.req;
  if (q) {
    const mn = Math.min(q.cur + q.minR, q.mx);
    MP.mn = MP.rx = mn;
    MP.mx = q.mx;
    c = `<div class="turn">あなたの番です　残り <b id=rtv></b> 秒</div>`;
    c += actHtml("MA", "MX", { toCall: q.toCall, call: f(Math.min(q.toCall, q.stack)), cur: q.cur, mn, mx: q.mx, pot: q.pot, f });
  }
  if (!q && v.ask)
    c = '<p>バストしました。リエントリー（開始スタック）しますか？</p><button onclick="MR(1)">リエントリー</button><button class=g onclick="MR(0)">終了</button>';
  else if (!q && v.spec)
    c = `<button class=g onclick="MW(${(v.ti + v.tn - 1) % v.tn})">◀</button> 卓 ${v.ti + 1} / ${v.tn} <button class=g onclick="MW(${(v.ti + 1) % v.tn})">▶</button><p class=mu>観戦では、公開された手札だけが見えます</p>`;
  else if (!q && v.away)
    c = '<p>離席中です（あなたの番は自動でチェック/フォールドします）</p><button onclick="MB()">戻る</button>';
  else if (!q) c = `<span class=mu>${v.wait ? "他の卓の終了を待っています…" : "他のプレイヤーのアクション中…"}</span>`;
  return c;
}
// ひとり用の render() は残し、みんなで遊ぶ間だけ最後のviewで描き直す（CPUタイプ表示の切替など）
const _render = render;
render = () => (G.mp && MP.v ? mpRender(MP.v) : _render());
// 自分の番の残り時間。残りが少なくなったら目立たせる
setInterval(() => {
  const e = $("rtv");
  if (!e || !MP.rt) return;
  const sec = Math.max(0, Math.ceil((MP.rt - Date.now()) / 1000));
  e.textContent = sec;
  e.parentNode.classList.toggle("warn", sec <= 8);
}, 300);

// ================= ロビー =================
// 接続状態のお知らせ（ゲーム中も見える位置に出す）。html を渡すとボタンなども置ける
function mpNote(s, html) {
  const e = $("nb");
  e.hidden = !s;
  e.textContent = s || "";
  if (html) e.insertAdjacentHTML("beforeend", html);
}
function mpShowGame() {
  $("start").hidden = 1;
  $("game").hidden = 0;
  if (HOST || MP.admin) {
    // ホスト（部屋を作った人）はゲーム中も参加者一覧（退出させるボタン付き）を見られるように、ゲーム画面の下へ移す
    $("game").appendChild($("mp"));
    $("mpC").hidden = 1;
    $("mpBk").hidden = 1;
    $("mp").hidden = 0;
  } else $("mp").hidden = 1;
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
    if ((HOST || MP.admin) && !p.host && p.id !== MP.me) {
      const b = document.createElement("button");
      b.className = "g";
      b.textContent = "退出させる";
      // ゲーム中に退出させた人の席は、以後自動でチェック/フォールドになる
      b.onclick = () =>
        (!G.mp || confirm(p.name + " を退出させますか？（戻ってこられなくなります）")) &&
        (HOST ? HOST.kick(p.id) : Net.send({ t: "admin", a: "kick", id: p.id }));
      li.appendChild(b);
    }
    ul.appendChild(li);
  });
}
// 簡易サーバーでログインが使えるとき、最初の画面に「ログイン中：名前」かログインへのリンクを出す
// ログインしていれば、入室・部屋作りの画面から名前とパスワードの欄をなくす（mpMember）
function mpAccount() {
  return fetch("api/me", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((me) => {
      if (!me || !me.enabled) return;
      const e = $("acct"), a = document.createElement("a");
      a.href = "account.html";
      e.textContent = me.user ? `ログイン中：${me.user.name}　` : "";
      a.textContent = me.user ? "アカウント" : "ログイン（Discord / Google）";
      e.appendChild(a);
      if (me.user) {
        const r = document.createElement("a");
        r.href = "review.html";
        r.textContent = "振り返り・傾向";
        e.append("　", r);
        // トップ画面の「ハンドを見返す」（ログインしている人だけ）
        const h = $("hxb");
        if (h) h.hidden = false;
      }
      e.hidden = false;
      if (me.user) mpMember(me.user);
    })
    .catch(() => {});
}
// 入力欄をラベルごと出す・隠す
function mpField(id, on) {
  const e = $(id), f = e.closest(".fld, .chk");
  e.hidden = !on;
  if (f) f.hidden = !on;
}
function mpMember(u) {
  MP.user = u;
  // 入室：名前もパスワードも要らない
  mpField("mjn", false);
  mpField("mjp", false);
  $("mjx").textContent = `ログイン中なので、名前とパスワードは要りません（${u.name} として入ります）。`;
  $("mjb").textContent = u.name + " として入室";
  // 部屋を作る：名前と合言葉は要らない。ゲストも入れるときだけ、ゲスト用のパスワードを決める
  mpField("mhn", false);
  mpField("mhk", false);
  mpField("mhg", true);
  $("mhpL").textContent = "ゲスト用のパスワード（ゲストに伝える）";
  const sync = () => mpField("mhp", $("mhg").checked);
  $("mhg").onchange = sync;
  sync();
  $("mhx").textContent = "ログイン中なので、合言葉は要りません。ゲストも入れるときだけ、ゲスト用のパスワードを決めます。";
  $("mhb").textContent = u.name + " として部屋を作る";
}
function mpUI() {
  const qs = new URLSearchParams(location.search),
    HM = qs.has("host"),
    RM = qs.get("r"),
    err = (s) => ($("mpM").textContent = s || "");
  // 「部屋に入る」「部屋を作る」をタブで切り替える。入力欄にはラベルを付ける（入力したあとも、何の欄か分かるように）
  $("mp").innerHTML = `<h3 style="margin-top:0">みんなで遊ぶ</h3><div id="mpE">
<p class="tabs2"><button id="mtJ" type="button">部屋に入る</button><button id="mtH" type="button">部屋を作る</button></p>
<div id="mpJ">
<p class="mu" id="mjx">部屋を作った人から、招待URL（または部屋ID）とパスワードを聞いてください。</p>
<label class="fld"><span>部屋ID</span><input id="mjr" type="text" placeholder="例: alp-xxxxx（招待URLを開くと自動で入ります）"></label>
<label class="fld"><span>あなたの名前</span><input id="mjn" type="text" maxlength="12" placeholder="12文字まで"></label>
<label class="fld"><span>部屋のパスワード</span><input id="mjp" type="password" placeholder="部屋を作った人から聞いたもの"></label>
<p class="fld">参加のしかた：<label><input type="radio" name="mro" value="player" checked> プレイヤーとして</label> <label><input type="radio" name="mro" value="spec"> 観戦だけ</label></p>
<button id="mjb">入室</button>
</div>
<div id="mpH">
<p class="mu" id="mhx">部屋を作って、招待URLとパスワードを仲間に伝えます。</p>
<label class="fld"><span>あなたの名前</span><input id="mhn" type="text" maxlength="12" placeholder="12文字まで"></label>
<label class="fld"><span id="mhpL">部屋のパスワード（参加する人に伝える）</span><input id="mhp" type="password"></label>
<label class="fld" hidden><span>部屋を作る合言葉（管理者から聞いたもの）</span><input id="mhk" type="password" hidden></label>
<label class="chk" hidden><input id="mhg" type="checkbox"> ゲスト（ログインしていない人）も入れる</label>
<label class="fld"><span>ブラインド間隔</span><select id="mps"><option value="5">5分（標準）</option><option value="2">2分</option><option value="1">1分</option></select></label>
<button id="mhb">部屋を作る</button>
</div>
<p id="mpM" class="err"></p></div>
<div id="mpRm" hidden><div id="mpI"></div><h4>参加者</h4><ul id="mpR" style="padding-left:20px"></ul><div id="mpC"></div><p id="mpS" class="ok"></p></div>
<p id="mpBk"><a href="${location.pathname}">← トップに戻る</a></p>`;
  // タブ：?host なら「部屋を作る」から
  const tab = (host) => {
    $("mpH").hidden = !host;
    $("mpJ").hidden = host;
    $("mtH").className = host ? "on" : "g";
    $("mtJ").className = host ? "g" : "on";
    $("mpM").textContent = "";
  };
  $("mtJ").onclick = () => tab(false);
  $("mtH").onclick = () => tab(true);
  tab(HM);
  if (RM) $("mjr").value = RM;
  if (HM || RM) {
    $("mp").hidden = 0;
    $("start").hidden = 1;
  }
  const inRoom = () => {
    $("mpE").hidden = 1;
    $("mpRm").hidden = 0;
  };
  SRV.then((s) => {
    if (!s) return;
    Net.use(wsLink(location.href));
    if (!MP.user) mpField("mhk", !!s.needKey);
    if (s.needKey) $("mhx").textContent = "部屋を作るには、管理者から聞いた「部屋を作る合言葉」が必要です（ログインしていれば要りません）。";
    if (s.auth) MP.acct = mpAccount();
  });
  // 招待用の表示（部屋IDと招待URL）
  const invite = (id) => {
    const url = location.origin + location.pathname + "?r=" + id;
    $("mpI").innerHTML = '<p>部屋ID：<code></code> <button class="g" id="mcp">招待URLをコピー</button></p><p class="mu">パスワードは別の方法で伝えてください。</p>';
    $("mpI").querySelector("code").textContent = id;
    $("mcp").onclick = () => navigator.clipboard && navigator.clipboard.writeText(url).then(() => ($("mcp").textContent = "コピーしました"));
  };
  $("mhb").onclick = async () => {
    await MP.acct;
    if (MP.user) {
      if ($("mhg").checked && !$("mhp").value) return err("ゲスト用のパスワードを決めてください");
      err("部屋を作成中…");
      return createOnServer(MP.user.name, $("mhg").checked ? $("mhp").value : "", $("mhg").checked);
    }
    const n = $("mhn").value.trim(), p = $("mhp").value;
    if (!n || !p) return err("名前とパスワードを入力してください");
    err("部屋を作成中…");
    if (await SRV) return createOnServer(n, p);
    const link = Net.listen({
      ready: (id) => {
        MP.me = id;
        HOST = AlpRoom.createHost({
          password: p,
          roomId: id,
          send: link.send,
          close: link.close,
          local: { id, name: n, deliver: mpRecv },
          onRoster: mpRoster,
          store: LS,
        });
        err("");
        inRoom();
        invite(id);
        $("mpC").innerHTML = '<button id="mgo">ゲーム開始</button>';
        $("mgo").onclick = () => HOST.start(+$("mps").value);
      },
      data: (id, m) => HOST && HOST.data(id, m),
      closed: (id) => HOST && HOST.closed(id),
      error: (e) => err("エラー：" + e),
      status: (s) => mpNote(s),
    });
  };
  // 簡易サーバーに部屋を作ってもらい、作った人として入室する
  const createOnServer = async (n, p, guests) => {
    let r;
    try {
      const res = await fetch("api/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pw: p, key: $("mhk").value, guests: !!guests }),
      });
      r = await res.json();
      if (!res.ok) return err(r.why || "部屋を作れませんでした");
    } catch (e) {
      return err("サーバーに接続できません");
    }
    MP.jp = { id: r.room, n, p, role: "player", adm: r.adm };
    MP.retry = 0;
    connect();
  };
  // 復帰用の合言葉は部屋ごとにタブへ保存する（再読み込みしても同じ席に戻れる。別のタブとは共有しない）
  const tokKey = (id) => "alp-tok:" + id,
    tokGet = (id) => {
      try {
        return sessionStorage.getItem(tokKey(id)) || "";
      } catch (e) {
        return "";
      }
    },
    tokSet = (id, t) => {
      try {
        t ? sessionStorage.setItem(tokKey(id), t) : sessionStorage.removeItem(tokKey(id));
      } catch (e) {}
    };
  // 入室。一度入室できたあとに切れたら、合言葉で自動的に入り直す（数回まで）
  const RETRY = 6;
  const connect = () => {
    const j = MP.jp;
    clearTimeout(MP.rtT);
    Net.join(j.id, { name: j.n, pw: j.p, role: j.role, tok: tokGet(j.id), adm: j.adm }, {
      joined: (m) => {
        MP.me = m.id;
        MP.in = 1;
        MP.retry = 0;
        tokSet(j.id, m.tok);
        err("");
        mpNote("");
        inRoom();
        // 再読み込みしたときに入室画面（部屋ID入り）が出るよう、アドレスを招待URLにしておく
        try {
          history.replaceState(null, "", "?r=" + encodeURIComponent(m.room));
        } catch (e) {}
        MP.admin = m.admin ? 1 : 0;
        if (MP.admin) {
          invite(m.room);
          if (!m.started) {
            $("mpC").innerHTML = '<button id="mgo">ゲーム開始</button>';
            $("mgo").onclick = () => Net.send({ t: "admin", a: "start", dur: +$("mps").value });
          }
        } else
          $("mpI").textContent =
            `部屋 ${m.room} に入室しました（${m.name || j.n}・${m.role === "spec" ? "観戦" : "プレイヤー"}）。` +
            (m.started ? "" : "ホストの開始を待っています。");
        if (m.started) mpShowGame();
      },
      roster: mpRoster,
      msg: mpRecv,
      error: (e, fatal) => {
        if (fatal) {
          tokSet(j.id, "");
          MP.in = 0;
          err(e);
          return mpNote(e);
        }
        MP.in ? lost(e) : err(e);
      },
      closed: lost,
    });
  };
  const lost = (why) => {
    if (MP.v && MP.v.over) return mpNote("大会が終了し、ホストとの接続が切れました");
    if (++MP.retry > RETRY) {
      mpNote(why + "。再接続できませんでした。", ' <button id="mrc">もう一度つなぐ</button>');
      $("mrc").onclick = () => {
        MP.retry = 0;
        mpNote("再接続しています…");
        connect();
      };
      return;
    }
    mpNote(`${why}。再接続しています…（${MP.retry}/${RETRY}）`);
    clearTimeout(MP.rtT);
    MP.rtT = setTimeout(connect, 1000 * Math.min(2 * MP.retry, 6));
  };
  $("mjb").onclick = async () => {
    await MP.acct;
    const id = $("mjr").value.trim(), n = MP.user ? MP.user.name : $("mjn").value.trim(), p = MP.user ? "" : $("mjp").value;
    if (!id) return err("部屋IDを入力してください");
    if (!n || (!p && !MP.user)) return err("すべて入力してください");
    err("接続中…");
    MP.jp = { id, n, p, role: document.querySelector("input[name=mro]:checked").value };
    MP.retry = 0;
    connect();
  };
}
mpUI();
