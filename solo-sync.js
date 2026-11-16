// solo-sync.js — ひとり用の記録を、ログインしているアカウントへ送る（簡易サーバーから配信されたページのときだけ）
// game.js から呼ばれる：soloSync.start(G)（大会の始まり）/ soloSync.hand(G)（ハンドが終わるたび）/ soloSync.finish(G, 順位)
// 送る前に、いったんブラウザ（localStorage。大会ごとに別のキー）に溜める。送れたら消す。送れなかったら、次のハンド・次に開いたとき・
// ネットにつながったときに送り直す。溜めたものには「誰のアカウントの分か」を付け、その人がログインしているときだけ送る
// 最初の画面に「ひとり用の記録を送る」のチェックを出す（はじめは ON）
const soloSync = (() => {
  // 溜める場所は大会ごとに別のキー（PRE + 大会の目印）。同じブラウザの別のタブで遊んでも、互いの分を上書きしない
  const PRE = "alp-solo:v2:", OLD = "alp-solo-outbox:v1", ON = "alp-solo-sync", CHUNK = 50,
    STALE = 6 * 36e5; // 送るものがなく、これだけ触られていない大会（途中でやめた大会）は消す
  let cur = null, // 今の大会の目印（送らないときは null）
    curUid = null,
    dropped = 0; // サーバーに断られて捨てたハンドの数（画面に出す）
  const ls = () => {
    try {
      return localStorage;
    } catch (e) {
      return null;
    }
  };
  const keys = () => {
    const L = ls(), out = [];
    if (!L) return out;
    for (let i = 0; i < L.length; i++) {
      const k = L.key(i);
      if (k && k.startsWith(PRE)) out.push(k.slice(PRE.length));
    }
    return out;
  };
  const get = (k) => {
    try {
      return JSON.parse(ls().getItem(PRE + k)) || null;
    } catch (e) {
      return null;
    }
  };
  const del = (k) => {
    try {
      ls().removeItem(PRE + k);
    } catch (e) {}
  };
  // 書く。入りきらなければ、今の大会以外の古いものから捨てる
  const put = (e) => {
    for (;;) {
      try {
        ls().setItem(PRE + e.key, JSON.stringify(e));
        return true;
      } catch (err) {
        const old = keys()
          .filter((k) => k != e.key && k != cur)
          .map((k) => [k, (get(k) || {}).startedAt || 0])
          .sort((a, b) => a[1] - b[1])[0];
        if (!old) return false;
        del(old[0]);
      }
    }
  };
  // 前の形（1つのキーに全部）で溜まっていた分を、大会ごとのキーに移す
  try {
    const o = JSON.parse(ls().getItem(OLD) || "null");
    if (o) for (const e of Object.values(o)) e && e.key && put(e);
    ls().removeItem(OLD);
  } catch (e) {}
  const enabled = () => {
    try {
      return localStorage.getItem(ON) !== "0";
    } catch (e) {
      return true;
    }
  };
  // ログインしているアカウント（簡易サーバーのページで、ログインしているときだけ）
  const who = async () => {
    const s = typeof SRV != "undefined" ? await SRV : null;
    if (!s || !s.auth || typeof MP == "undefined") return null;
    await MP.acct;
    return MP.user || null;
  };
  const newKey = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const meta = (G) => ({ blindMin: G.dur / 6e4, startedAt: G.t0, entries: G.entries, re: G.hero.re, stats: G.tr || {}, seen: Date.now() });
  // 今の大会の溜め場所（何かの拍子に消えていても作り直す）
  const curEntry = () => get(cur) || { key: cur, uid: curUid, hands: [], over: 0 };

  async function start(G) {
    cur = null;
    G.t0 = Date.now();
    G.synced = 0; // G.hist のうち、溜めた数
    const u = enabled() && (await who());
    if (!u) return;
    cur = newKey();
    curUid = u.id;
    put({ key: cur, uid: u.id, ...meta(G), hands: [], over: 0 });
    status();
  }
  function hand(G) {
    if (!cur || !G.hist) return;
    const e = curEntry();
    e.hands.push(...G.hist.slice(G.synced));
    G.synced = G.hist.length;
    Object.assign(e, meta(G));
    put(e);
    flush();
  }
  function finish(G, place) {
    if (!cur) return;
    hand(G);
    const e = curEntry();
    Object.assign(e, meta(G), { place, over: 1 });
    put(e);
    flush();
  }

  // 送る。同時には1つだけ
  let busy = false;
  async function flush() {
    if (busy) return;
    busy = true;
    try {
      const u = await who();
      if (!u) return;
      for (const key of keys()) {
        for (;;) {
          const e = get(key);
          if (!e || e.uid !== u.id) break; // 別の人の分は、その人がログインしたときに送る
          // 送るものがない：送らない。今の大会でなく、しばらく触られていなければ（途中でやめた大会）消す
          if (!e.hands.length && !e.over) {
            if (key != cur && Date.now() - (e.seen || e.startedAt || 0) > STALE) del(key);
            break;
          }
          const n = e.one ? 1 : CHUNK,
            part = e.hands.slice(0, n),
            body = { key, blindMin: e.blindMin, startedAt: e.startedAt, entries: e.entries, re: e.re, stats: e.stats, hands: part };
          // 大会の終わりは、残りのハンドを全部送ってから知らせる
          if (e.over && e.hands.length <= n) Object.assign(body, { over: 1, place: e.place });
          let r;
          try {
            r = await fetch("api/solo/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive: JSON.stringify(body).length < 6e4 });
          } catch (err) {
            return; // つながらない：あとで送り直す
          }
          if (r.status == 401 || r.status == 429 || r.status >= 500) return; // ログインし直し・待つ・サーバーの都合：あとで
          const x = get(key);
          if (!x) break;
          const sent = new Set(part.map((h) => h.n));
          x.hands = x.hands.filter((h) => !sent.has(h.n));
          if (r.ok) {
            if (body.over) {
              del(key);
              break;
            }
          } else {
            // 形がおかしいと言われた：まとめて送っていたなら、1ハンドずつに分けて送り直し、通らないものだけを捨てる
            if (part.length > 1) {
              x.hands = part.concat(x.hands);
              x.one = 1;
              put(x);
              continue;
            }
            console.warn("ひとり用の記録を送れませんでした", r.status, key, part.length ? "#" + part[0].n : "（大会の締め）");
            dropped += part.length;
            x.one = 0; // 通らないものを捨てたので、またまとめて送る
            // ハンドなしでも断られた（大会の締め）：締めは諦めて、溜め場所を消す（今の大会なら、続きのハンドは作り直した場所に溜まる）
            if (!part.length) {
              del(key);
              break;
            }
          }
          put(x);
          if (!x.hands.length && !x.over) break;
        }
      }
    } finally {
      busy = false;
      status();
    }
  }
  // 最初の画面：送るかどうかのチェックと、まだ送れていないハンドの数
  async function status() {
    const u = await who(), e = typeof document != "undefined" && document.getElementById("acct");
    if (!u || !e) return;
    let box = document.getElementById("ssy");
    if (!box) {
      box = document.createElement("label");
      box.id = "ssy";
      box.style.marginLeft = "12px";
      box.innerHTML = '<input type="checkbox"> ひとり用の記録を送る <span></span>';
      const cb = box.querySelector("input");
      cb.checked = enabled();
      cb.onchange = () => {
        try {
          localStorage.setItem(ON, cb.checked ? "1" : "0");
        } catch (err) {}
      };
      e.appendChild(box);
    }
    const n = keys()
      .map(get)
      .filter((x) => x && x.uid === u.id)
      .reduce((s, x) => s + x.hands.length, 0);
    box.querySelector("span").textContent =
      (n ? `（まだ送れていない ${n} ハンド）` : "") + (dropped ? `（形がおかしく、送れずに捨てた ${dropped} ハンド）` : "");
  }
  // 開いたとき・ネットにつながったとき・1分ごとに、溜まっている分を送る
  if (typeof window != "undefined") {
    flush();
    window.addEventListener("online", () => flush());
    setInterval(() => keys().length && flush(), 60e3);
  }
  return { start, hand, finish, flush, status };
})();
