// net.js — 通信の層（ブラウザ用）。ゲームの中身は知らない。
//
// 「通信の口（link）」は次の2つを持つ。今は PeerJS 版（PeerLink）だけ。WebSocket 版も同じ形で作れば差し替えられる。
//   listen(cb) … 部屋を開く側（ホストのブラウザ）。
//       cb.ready(部屋ID) / cb.data(接続id, msg) / cb.closed(接続id) / cb.status(お知らせ文 or "") / cb.error(理由)
//       戻り値: { send(接続id, msg), close(接続id), destroy() }
//   dial(部屋ID, cb) … 入室する側。
//       cb.open() / cb.data(msg) / cb.close() / cb.error(理由)
//       戻り値: { send(msg), destroy() }
// 入室の手順（joinRoom）と部屋の受付（room.js の createHost）は、どの link でも同じものを使う。
const PeerLink = {
  listen(cb) {
    let peer, ready = false, rt;
    const conns = {}; // 接続id(peerId) -> DataConnection
    const rid = () => Math.random().toString(36).slice(2, 7);
    // シグナリングサーバーとの接続が切れたら、つながるまで数秒おきに張り直す
    // （参加者との接続は P2P なので、その間もゲームは続く。新しい入室・復帰だけができなくなる）
    const retry = () => {
      clearTimeout(rt);
      rt = setTimeout(() => {
        if (!peer || peer.destroyed) return;
        if (!peer.disconnected) return cb.status && cb.status("");
        try {
          peer.reconnect();
        } catch (e) {}
        retry();
      }, 3000);
    };
    const open = () => {
      peer && peer.destroy();
      peer = new Peer("alp-" + rid());
      peer.on("open", (id) => {
        if (ready) return cb.status && cb.status(""); // 再接続できた
        ready = true;
        cb.ready && cb.ready(id);
      });
      peer.on("disconnected", () => {
        if (!ready) return;
        cb.status && cb.status("サーバーとの接続が切れました。再接続しています…（新しい入室・復帰はできません）");
        retry();
      });
      peer.on("error", (e) => {
        if (e.type === "unavailable-id" && !ready) return open(); // 部屋IDがかぶったら作り直す
        if (!ready) return cb.error && cb.error(e.type);
        if (peer.disconnected) retry();
      });
      peer.on("connection", (c) => {
        conns[c.peer] = c;
        c.on("data", (m) => conns[c.peer] === c && cb.data(c.peer, m));
        c.on("close", () => {
          if (conns[c.peer] !== c) return; // こちらから閉じた接続
          delete conns[c.peer];
          cb.closed(c.peer);
        });
      });
    };
    open();
    return {
      send: (id, m) => conns[id] && conns[id].open && conns[id].send(m),
      close: (id) => {
        const c = conns[id];
        delete conns[id];
        c && c.close();
      },
      destroy: () => peer && peer.destroy(),
    };
  },
  dial(room, cb) {
    const peer = new Peer();
    let dc = null, dead = false;
    peer.on("error", (e) => {
      if (dead || (dc && dc.open)) return; // つながっていればサーバー側のエラーは無視
      cb.error(e.type === "peer-unavailable" ? "部屋が見つかりません" : "通信エラー：" + e.type);
    });
    peer.on("open", () => {
      if (dead) return;
      dc = peer.connect(room, { reliable: true });
      dc.on("open", () => !dead && cb.open());
      dc.on("data", (m) => !dead && cb.data(m));
      dc.on("close", () => !dead && cb.close());
    });
    return {
      send: (m) => dc && dc.open && dc.send(m),
      close: () => dc && dc.close(),
      destroy: () => {
        dead = true;
        peer.destroy();
      },
    };
  },
};

// 入室の手順。o: { name, pw, role, tok }（tok は復帰用の合言葉。なければ空）
// cb.joined(ok) / cb.roster(一覧) / cb.msg(msg) / cb.error(理由, fatal) / cb.closed(理由)
//   fatal=1 は、入り直しても無駄な失敗（パスワード違い・退出させられた）
// 戻り値: { send(msg), leave() }
const JOIN_MS = 15000; // 入室の応答を待つ時間
function joinRoom(link, room, o, cb) {
  let st = 0, // 0: 応答待ち / 1: 入室済み / 2: 終わり（失敗・切断・退出を伝えた）
    dead = false;
  const fail = (why, fatal) => {
    if (dead || st == 2) return;
    st = 2;
    clearTimeout(tm);
    cb.error && cb.error(why, fatal);
  };
  const lost = (why) => {
    if (dead || st == 2) return;
    if (st == 0) return fail(why);
    st = 2;
    cb.closed && cb.closed(why);
  };
  const tm = setTimeout(() => {
    if (dead || st) return;
    fail("接続できませんでした（タイムアウト）");
    conn.destroy();
  }, JOIN_MS);
  const conn = link.dial(room, {
    open: () => !dead && conn.send({ t: "join", name: o.name, pw: o.pw, role: o.role, tok: o.tok }),
    data: (m) => {
      if (dead || !m || st == 2) return;
      if (m.t === "ok") {
        st = 1;
        clearTimeout(tm);
        cb.joined && cb.joined(m);
      } else if (m.t === "no") {
        fail(m.why, 1);
        conn.close();
      } else if (m.t === "roster") cb.roster && cb.roster(m.r);
      else if (m.t === "kick") {
        st = 0;
        fail("ホストにより退出させられました", 1);
        conn.close();
      } else cb.msg && cb.msg(m);
    },
    close: () => lost(st ? "ホストとの接続が切れました" : "接続が切れました"),
    error: (why) => lost(why),
  });
  return {
    send: (m) => conn.send(m),
    leave: () => {
      dead = true;
      clearTimeout(tm);
      conn.destroy();
    },
  };
}

// 画面側から使う窓口。use() で link を差し替えられる
const Net = (() => {
  let link = PeerLink, cur = null;
  return {
    use: (l) => (link = l),
    listen: (cb) => link.listen(cb),
    // 入室（前の入室は打ち切る）
    join: (room, o, cb) => {
      cur && cur.leave();
      cur = joinRoom(link, room, o, cb);
    },
    send: (m) => cur && cur.send(m),
    leave: () => {
      cur && cur.leave();
      cur = null;
    },
  };
})();

// Node（テスト・将来のサーバー）から使うとき
if (typeof module == "object" && module.exports) module.exports = { PeerLink, joinRoom, Net, JOIN_MS };
