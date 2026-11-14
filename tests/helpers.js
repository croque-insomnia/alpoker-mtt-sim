// テスト用の道具：早送りできる時計と、メモリ上でつながる通信の口（link）
// 時計：タイマーを登録順・時刻順に並べ、run() で全部（または上限まで）一気に進める
function fakeClock(t0 = 1e12) {
  let now = t0, seq = 0, q = [];
  return {
    now: () => now,
    setTimeout: (f, ms) => {
      q.push({ id: ++seq, at: now + (ms || 0), f });
      return seq;
    },
    clearTimeout: (id) => (q = q.filter((t) => t.id != id)),
    // 1つ進める。進めたら true
    step() {
      if (!q.length) return false;
      q.sort((a, b) => a.at - b.at || a.id - b.id);
      const t = q.shift();
      now = Math.max(now, t.at);
      t.f();
      return true;
    },
    run(max = 1e6, each) {
      let n = 0;
      while (n < max && this.step()) {
        n++;
        each && each();
      }
      return n;
    },
    pending: () => q.length,
    advance(ms) {
      now += ms;
    },
  };
}

// メモリ上の link。net.js の PeerLink と同じ形（listen / dial）
// 届けるのは非同期（queueMicrotask）にして、本物の通信に近い順番にする
function memoryLink() {
  const rooms = {};
  let seq = 0;
  const later = (f) => queueMicrotask(f);
  return {
    listen(cb) {
      const id = "room" + ++seq, conns = {};
      rooms[id] = { cb, conns };
      later(() => cb.ready(id));
      return {
        send: (cid, m) => conns[cid] && later(() => conns[cid] && conns[cid].client.data(structuredClone(m))),
        close: (cid) => {
          const c = conns[cid];
          if (!c) return;
          delete conns[cid];
          later(() => c.client.close());
        },
        destroy: () => delete rooms[id],
      };
    },
    dial(room, client) {
      const cid = "c" + ++seq;
      let dead = false;
      later(() => {
        const r = rooms[room];
        if (dead) return;
        if (!r) return client.error("部屋が見つかりません");
        r.conns[cid] = { client };
        client.open();
      });
      const toHost = (f) => later(() => rooms[room] && rooms[room].conns[cid] && f(rooms[room]));
      return {
        id: cid,
        send: (m) => !dead && toHost((r) => r.cb.data(cid, structuredClone(m))),
        close: () => toHost((r) => {
          delete r.conns[cid];
          r.cb.closed(cid);
          later(() => client.close());
        }),
        destroy: () => {
          if (dead) return;
          dead = true;
          const r = rooms[room];
          if (r && r.conns[cid]) {
            delete r.conns[cid];
            later(() => r.cb.closed(cid));
          }
        },
        // テスト用：接続が突然切れたことにする（ホスト側にも参加者側にも close が届く）
        drop: () => {
          const r = rooms[room];
          if (r && r.conns[cid]) {
            delete r.conns[cid];
            later(() => r.cb.closed(cid));
          }
          later(() => client.close());
        },
      };
    },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

module.exports = { fakeClock, memoryLink, flush };
