// net.js — ホスト型マルチプレイの通信層（PeerJS / WebRTC）
// ホストのブラウザが部屋の親になり、参加者は部屋ID＋パスワード＋名前で入室する。
// ゲーム本体とは cb.msg / Net.to / Net.bc でつなぐ（通信層はゲームの中身を知らない）。
const Net = (() => {
  let peer, hostConn, isHost = false, pw = '', room = '', started = false, cb = {};
  const conns = {}; // 入室済みの参加者: peerId -> DataConnection
  let roster = []; // [{id,name,role,host}]
  const rid = () => Math.random().toString(36).slice(2, 7);
  const say = (c, m) => c && c.open && c.send(m);

  function pushRoster() {
    const r = roster.map(({ id, name, role, host }) => ({ id, name, role, host: !!host }));
    Object.values(conns).forEach((c) => say(c, { t: 'roster', r }));
    cb.roster && cb.roster(r);
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
    const open = () => {
      peer && peer.destroy();
      room = 'alp-' + rid();
      peer = new Peer(room);
      peer.on('open', () => {
        roster = [{ id: peer.id, name, role: 'player', host: true }];
        pushRoster();
        cb.ready && cb.ready(room);
      });
      peer.on('error', (e) => (e.type === 'unavailable-id' ? open() : cb.error && cb.error(e.type)));
      peer.on('connection', (c) => {
        c.on('data', (m) => onHost(c, m));
        c.on('close', () => conns[c.peer] && drop(c.peer));
      });
    };
    open();
  }
  function onHost(c, m) {
    if (m && m.t === 'join') {
      const name = String(m.name || '').trim().slice(0, 12);
      if (m.pw !== pw) return refuse(c, 'パスワードが違います');
      if (!name) return refuse(c, '名前を入力してください');
      if (roster.some((p) => p.name.toLowerCase() === name.toLowerCase())) return refuse(c, 'その名前は使われています');
      // 開始後はプレイヤー参加不可（観戦のみ）
      const role = m.role === 'player' && !started ? 'player' : 'spec';
      conns[c.peer] = c;
      roster.push({ id: c.peer, name, role });
      say(c, { t: 'ok', id: c.peer, room, role });
      pushRoster();
      return;
    }
    if (conns[c.peer]) cb.msg && cb.msg(c.peer, m); // 入室済みの人のメッセージだけゲーム側へ渡す
  }
  const refuse = (c, why) => { say(c, { t: 'no', why }); setTimeout(() => c.close(), 300); };

  // ---- 参加者 ----
  function join(id, name, password, role, cbs) {
    cb = cbs; isHost = false;
    peer = new Peer();
    peer.on('error', (e) => cb.error && cb.error(e.type === 'peer-unavailable' ? '部屋が見つかりません' : e.type));
    peer.on('open', () => {
      hostConn = peer.connect(id, { reliable: true });
      hostConn.on('open', () => hostConn.send({ t: 'join', name, pw: password, role }));
      hostConn.on('data', (m) => {
        if (m.t === 'ok') cb.joined && cb.joined(m);
        else if (m.t === 'no') { cb.error && cb.error(m.why); hostConn.close(); }
        else if (m.t === 'roster') cb.roster && cb.roster(m.r);
        else if (m.t === 'kick') { cb.error && cb.error('ホストにより退出させられました'); hostConn.close(); }
        else cb.msg && cb.msg('host', m);
      });
      hostConn.on('close', () => cb.closed && cb.closed());
    });
  }

  return {
    host, join,
    isHost: () => isHost,
    send: (m) => say(hostConn, m),                    // 参加者 → ホスト
    to: (id, m) => say(conns[id], m),                 // ホスト → 特定の人
    bc: (m) => Object.values(conns).forEach((c) => say(c, m)), // ホスト → 全員
    kick: (id) => { say(conns[id], { t: 'kick' }); conns[id] && conns[id].close(); drop(id); },
    setStarted: (v) => (started = v),
    leave: () => peer && peer.destroy(),
  };
})();
