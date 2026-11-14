// net.js — ホスト型マルチプレイの通信層（PeerJS / WebRTC）
// ホストのブラウザが部屋の親になり、参加者は部屋ID＋パスワード＋名前で入室する。
// ゲーム本体とは cb.msg / Net.to / Net.bc でつなぐ（通信層はゲームの中身を知らない）。
// 入室が通ると「復帰用の合言葉（tok）」を渡す。切断後に同じ tok で入り直すと、同じ名前・同じ席に戻れる。
const Net = (() => {
  let peer, hostConn, isHost = false, pw = '', room = '', started = false, cb = {};
  const conns = {}; // 入室済みの参加者: peerId -> DataConnection
  const toks = {}; // 発行した合言葉: tok -> { name, role, id }（id は今つながっている peerId）
  let roster = []; // [{id,name,role,host}]
  let jg = 0; // 参加者側：入室を試みた回数。古い接続のイベントを無視するのに使う
  const JOIN_MS = 15000; // 入室の応答を待つ時間
  const rid = () => Math.random().toString(36).slice(2, 7);
  const secret = () => [...crypto.getRandomValues(new Uint32Array(4))].map((x) => x.toString(36)).join('');
  const hostAlias = 'u' + rid();
  const say = (c, m) => c && c.open && c.send(m);
  const tokOf = (id) => Object.keys(toks).find((k) => toks[k].id === id);

  function pushRoster() {
    const full = roster.map(({ id, name, role, host }) => ({ id, name, role, host: !!host }));
    // 参加者には「ホスト」の印を送らない。ホストのIDは部屋IDと同じなので、別の仮IDに置き換える
    const pub = roster.map(({ id, name, role, host }) => ({ id: host ? hostAlias : id, name, role }));
    Object.values(conns).forEach((c) => say(c, { t: 'roster', r: pub }));
    cb.roster && cb.roster(full);
  }
  function drop(id) {
    delete conns[id];
    roster = roster.filter((p) => p.id !== id);
    pushRoster();
    cb.left && cb.left(id);
  }

  // ---- ホスト ----
  function host(name, password, cbs) {
    cb = cbs; isHost = true; pw = password;
    let ready = false, rt;
    // シグナリングサーバーとの接続が切れたら、つながるまで数秒おきに張り直す
    // （参加者との接続は P2P なので、その間もゲームは続く。新しい入室・復帰だけができなくなる）
    const retry = () => {
      clearTimeout(rt);
      rt = setTimeout(() => {
        if (!peer || peer.destroyed) return;
        if (!peer.disconnected) return cb.status && cb.status('');
        try { peer.reconnect(); } catch (e) {}
        retry();
      }, 3000);
    };
    const open = () => {
      peer && peer.destroy();
      room = 'alp-' + rid();
      peer = new Peer(room);
      peer.on('open', () => {
        if (ready) return cb.status && cb.status(''); // 再接続できた
        ready = true;
        roster = [{ id: peer.id, name, role: 'player', host: true }];
        pushRoster();
        cb.ready && cb.ready(room);
      });
      peer.on('disconnected', () => {
        if (!ready) return;
        cb.status && cb.status('サーバーとの接続が切れました。再接続しています…（新しい入室・復帰はできません）');
        retry();
      });
      peer.on('error', (e) => {
        if (e.type === 'unavailable-id' && !ready) return open();
        if (!ready) return cb.error && cb.error(e.type);
        if (peer.disconnected) retry();
      });
      peer.on('connection', (c) => {
        c.on('data', (m) => onHost(c, m));
        c.on('close', () => conns[c.peer] === c && drop(c.peer));
      });
    };
    open();
  }
  function onHost(c, m) {
    if (m && m.t === 'join') {
      if (conns[c.peer]) return; // 入室済みの接続からの2回目の join は無視
      if (m.pw !== pw) return refuse(c, 'パスワードが違います');
      const tk = typeof m.tok === 'string' && toks[m.tok];
      if (tk) return rejoin(c, m.tok, tk);
      const name = String(m.name || '').replace(/[<>&"'`]/g, '').trim().slice(0, 12);
      if (!name) return refuse(c, '名前を入力してください');
      // 切断中の人の名前も、本人が戻ってこられるように取っておく
      const taken = roster.map((p) => p.name).concat(Object.values(toks).map((t) => t.name));
      if (taken.some((n) => n.toLowerCase() === name.toLowerCase())) return refuse(c, 'その名前は使われています');
      // 開始後はプレイヤー参加不可（観戦のみ）
      const role = m.role === 'player' && !started ? 'player' : 'spec';
      const tok = secret();
      toks[tok] = { name, role, id: c.peer };
      conns[c.peer] = c;
      roster.push({ id: c.peer, name, role });
      say(c, { t: 'ok', id: c.peer, room, role, started, tok, name });
      pushRoster();
      return;
    }
    if (conns[c.peer] === c) cb.msg && cb.msg(c.peer, m); // 入室済みの人のメッセージだけゲーム側へ渡す
  }
  // 合言葉での復帰。前の接続がまだ残っていれば（切断に気づく前に入り直した場合）、そちらを閉じて置き換える
  function rejoin(c, tok, tk) {
    const old = tk.id, oc = conns[old];
    delete conns[old];
    oc && oc.close();
    roster = roster.filter((p) => p.id !== old);
    tk.id = c.peer;
    conns[c.peer] = c;
    roster.push({ id: c.peer, name: tk.name, role: tk.role });
    say(c, { t: 'ok', id: c.peer, room, role: tk.role, started, tok, name: tk.name, back: 1 });
    cb.rejoin && cb.rejoin(old, c.peer);
    pushRoster();
  }
  const refuse = (c, why) => { say(c, { t: 'no', why }); setTimeout(() => c.close(), 300); };

  // ---- 参加者 ----
  // cb.error(理由, 1) の「1」は、入り直しても無駄な失敗（パスワード違い・退出させられた）
  function join(id, name, password, role, tok, cbs) {
    cb = cbs; isHost = false;
    const g = ++jg, live = () => g === jg;
    let st = 0; // 0: 応答待ち / 1: 入室済み / 2: 終わり（失敗・切断・退出を伝えた）
    const fail = (why, fatal) => {
      if (!live() || st == 2) return;
      st = 2;
      clearTimeout(tm);
      cb.error && cb.error(why, fatal);
    };
    const lost = (why) => {
      if (!live() || st == 2) return;
      if (st == 0) return fail(why);
      st = 2;
      cb.closed && cb.closed(why);
    };
    const tm = setTimeout(() => {
      if (!live() || st) return;
      fail('接続できませんでした（タイムアウト）');
      peer && peer.destroy();
    }, JOIN_MS);
    peer && peer.destroy();
    peer = new Peer();
    const me = peer;
    peer.on('error', (e) => {
      if (st == 1 && hostConn && hostConn.open) return; // つながっていればサーバー側のエラーは無視
      lost(e.type === 'peer-unavailable' ? '部屋が見つかりません' : '通信エラー：' + e.type);
    });
    peer.on('open', () => {
      if (!live()) return;
      const hc = (hostConn = me.connect(id, { reliable: true }));
      hc.on('open', () => live() && hc.send({ t: 'join', name, pw: password, role, tok }));
      hc.on('data', (m) => {
        if (!live() || !m || st == 2) return;
        if (m.t === 'ok') {
          st = 1;
          clearTimeout(tm);
          cb.joined && cb.joined(m);
        } else if (m.t === 'no') { fail(m.why, 1); hc.close(); }
        else if (m.t === 'roster') cb.roster && cb.roster(m.r);
        else if (m.t === 'kick') { st = 0; fail('ホストにより退出させられました', 1); hc.close(); }
        else cb.msg && cb.msg('host', m);
      });
      hc.on('close', () => lost(st ? 'ホストとの接続が切れました' : '接続が切れました'));
    });
  }

  return {
    host, join,
    isHost: () => isHost,
    send: (m) => say(hostConn, m),                    // 参加者 → ホスト
    to: (id, m) => say(conns[id], m),                 // ホスト → 特定の人
    bc: (m) => Object.values(conns).forEach((c) => say(c, m)), // ホスト → 全員
    kick: (id) => {
      const t = tokOf(id);
      if (t) delete toks[t]; // 退出させた人は合言葉で戻れない
      say(conns[id], { t: 'kick' });
      const c = conns[id];
      c && setTimeout(() => c.close(), 300);
      drop(id);
    },
    setStarted: (v) => (started = v),
    leave: () => { jg++; peer && peer.destroy(); },
  };
})();
