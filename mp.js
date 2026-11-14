// mp.js — みんなで遊ぶ（ホスト型マルチプレイ）の画面とロビー。engine.js・room.js・net.js・game.js の後に読み込む。
// 大会の進行と入室の受付は room.js、通信は net.js にある。ここは「見せる」と「つなぐ」だけ。
// ホストのブラウザでは room.js の部屋をそのまま動かし、参加者には通信で画面データ（view）を送る。
let HOST = null; // ホストのブラウザで部屋を持っているとき：room.js の createHost
const MP = { me: "", roster: [] };
const mpEsc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// 自分の操作を部屋へ送る（ホストなら手元の部屋へ、参加者ならホストへ）
const mpSend = (m) => (HOST ? HOST.localMsg(m) : Net.send(m));
// 部屋から自分あてに届いたもの（ホストは手元の部屋から、参加者は通信で）
function mpRecv(m) {
  if (m.t == "start") mpShowGame();
  else if (m.t == "view") mpRender(m.v);
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
  for (const k of ["lv", "bb", "an", "rem", "al", "en", "itm", "avg", "rk", "st", "re", "pot", "ask", "away", "place", "over", "ti", "tn", "spec", "wait"])
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
  const hs =
    `<b>Lv${v.lv + 1}</b>（BB=${v.bb}点・ante ${+(v.an / v.bb).toFixed(2)}BB） ・ 次Lvまで <b id=tm></b> ・ 残り <b>${v.al}</b>/${v.en}人 ・ ITM ${v.itm}位 ・ 平均 ${f(v.avg)}BB` +
    (v.spec ? " ・ <b>観戦中</b>" : ` ・ あなた <b>${v.rk}位</b>（${f(v.st)}BB）${v.re ? " ・ <b>RE可</b>" : ""}`);
  if (G.hs != hs) {
    G.hs = hs;
    $("hd").innerHTML = hs;
    tmr();
  }
  const seat = (p) =>
    `<div class="s${p.fold ? " f" : ""}${p.act ? " a" : ""}${p.me ? " h" : ""}"><b style="color:${p.col || "inherit"}">${p.name}</b> <small>${p.me || !G.ty ? "" : p.ty} ${p.lab}${p.alive ? "" : " バスト"}</small><div>${f(p.stack)} BB</div><div>${p.h ? p.h.map((c) => cd(c)).join("") : p.hd ? cd(0, 1) + cd(0, 1) : "&nbsp;"}</div><em>${p.bet ? "bet " + f(p.bet) : ""}</em></div>`;
  const me = v.pl.find((p) => p.me);
  $("tb").innerHTML = `<div class=row>${v.pl.filter((p) => !p.me).map(seat).join("")}</div><div class=bd>${v.bd.map((c) => cd(c)).join("") || "&nbsp;"}<span>POT ${f(v.pot)} BB</span></div>${me ? seat(me) : ""}`;
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
setInterval(() => {
  const e = $("rtv");
  if (e && MP.rt) e.textContent = Math.max(0, Math.ceil((MP.rt - Date.now()) / 1000));
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
  if (HOST) {
    // ホストはゲーム中も参加者一覧（退出させるボタン付き）を見られるように、ゲーム画面の下へ移す
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
    if (HOST && !p.host) {
      const b = document.createElement("button");
      b.className = "g";
      b.textContent = "退出させる";
      // ゲーム中に退出させた人の席は、以後自動でチェック/フォールドになる
      b.onclick = () => (!G.mp || confirm(p.name + " を退出させますか？（戻ってこられなくなります）")) && HOST.kick(p.id);
      li.appendChild(b);
    }
    ul.appendChild(li);
  });
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
<p id="mpBk"><a href="${location.pathname}">ひとりで遊ぶに戻る</a></p>`;
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
        const url = location.origin + location.pathname + "?r=" + id;
        $("mpI").innerHTML = '<p>部屋ID：<code></code> <button class="g" id="mcp">招待URLをコピー</button></p><p class="mu">パスワードは別の方法で伝えてください。</p>';
        $("mpI").querySelector("code").textContent = id;
        $("mcp").onclick = () => navigator.clipboard && navigator.clipboard.writeText(url).then(() => ($("mcp").textContent = "コピーしました"));
        $("mpC").innerHTML = '<button id="mgo">ゲーム開始</button>';
        $("mgo").onclick = () => HOST.start(+$("mps").value);
      },
      data: (id, m) => HOST && HOST.data(id, m),
      closed: (id) => HOST && HOST.closed(id),
      error: (e) => err("エラー：" + e),
      status: (s) => mpNote(s),
    });
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
    Net.join(j.id, { name: j.n, pw: j.p, role: j.role, tok: tokGet(j.id) }, {
      joined: (m) => {
        MP.me = m.id;
        MP.in = 1;
        MP.retry = 0;
        tokSet(j.id, m.tok);
        err("");
        mpNote("");
        inRoom();
        $("mpI").textContent = `部屋 ${m.room} に入室しました（${m.name || j.n}・${m.role === "spec" ? "観戦" : "プレイヤー"}）。` + (m.started ? "" : "ホストの開始を待っています。");
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
  $("mjb").onclick = () => {
    const id = $("mjr").value.trim(), n = $("mjn").value.trim(), p = $("mjp").value;
    if (!id || !n || !p) return err("すべて入力してください");
    err("接続中…");
    MP.jp = { id, n, p, role: document.querySelector("input[name=mro]:checked").value };
    MP.retry = 0;
    connect();
  };
}
mpUI();
