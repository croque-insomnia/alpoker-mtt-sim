// solo-sync.js — ひとり用の記録を、ログインしているアカウントへ送る（簡易サーバーから配信されたページのときだけ）
// game.js から呼ばれる：soloSync.start(G)（大会の始まり）/ soloSync.hand(G)（ハンドが終わるたび）/ soloSync.finish(G, 順位)
// 送る前に、いったんブラウザ（localStorage）に溜める。送れたら消す。送れなかったら、次のハンド・次に開いたとき・
// ネットにつながったときに送り直す。溜めたものには「誰のアカウントの分か」を付け、その人がログインしているときだけ送る
// 最初の画面に「ひとり用の記録を送る」のチェックを出す（はじめは ON）
const soloSync = (() => {
  const BOX = "alp-solo-outbox:v1", ON = "alp-solo-sync", CHUNK = 50;
  const load = () => {
    try {
      return JSON.parse(localStorage.getItem(BOX)) || {};
    } catch (e) {
      return {};
    }
  };
  const save = (o) => {
    try {
      localStorage.setItem(BOX, JSON.stringify(o));
      return true;
    } catch (e) {
      return false;
    }
  };
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
  let cur = null; // 今の大会の目印（送らないときは null）
  // 溜める。入りきらなければ、今の大会以外の古いものから捨てる
  const keep = (o) => {
    while (!save(o)) {
      const old = Object.keys(o).filter((k) => k != cur).sort((a, b) => o[a].startedAt - o[b].startedAt)[0];
      if (!old) return false;
      delete o[old];
    }
    return true;
  };
  const meta = (G) => ({ blindMin: G.dur / 6e4, startedAt: G.t0, entries: G.entries, re: G.hero.re, stats: G.tr || {} });

  async function start(G) {
    cur = null;
    G.t0 = Date.now();
    G.synced = 0; // G.hist のうち、溜めた数
    const u = enabled() && (await who());
    if (!u) return;
    cur = newKey();
    const o = load();
    o[cur] = { key: cur, uid: u.id, ...meta(G), hands: [], over: 0 };
    keep(o);
    status();
  }
  function hand(G) {
    if (!cur || !G.hist) return;
    const o = load(), e = o[cur];
    if (!e) return;
    e.hands.push(...G.hist.slice(G.synced));
    G.synced = G.hist.length;
    Object.assign(e, meta(G));
    keep(o);
    flush();
  }
  function finish(G, place) {
    if (!cur) return;
    hand(G);
    const o = load(), e = o[cur];
    if (!e) return;
    Object.assign(e, meta(G), { place, over: 1 });
    keep(o);
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
      for (const key of Object.keys(load())) {
        for (;;) {
          const e = load()[key];
          if (!e || e.uid !== u.id) break; // 別の人の分は、その人がログインしたときに送る
          const part = e.hands.slice(0, CHUNK),
            body = { key, blindMin: e.blindMin, startedAt: e.startedAt, entries: e.entries, re: e.re, stats: e.stats, hands: part };
          // 大会の終わりは、残りのハンドを全部送ってから知らせる
          if (e.over && e.hands.length <= CHUNK) Object.assign(body, { over: 1, place: e.place });
          let r;
          try {
            r = await fetch("api/solo/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive: JSON.stringify(body).length < 6e4 });
          } catch (err) {
            return; // つながらない：あとで送り直す
          }
          if (r.status == 401 || r.status == 429 || r.status >= 500) return; // ログインし直し・待つ・サーバーの都合：あとで
          const o = load(), x = o[key];
          if (!x) break;
          if (r.ok) {
            const sent = new Set(part.map((h) => h.n));
            x.hands = x.hands.filter((h) => !sent.has(h.n));
            if (body.over) {
              delete o[key];
              save(o);
              break;
            }
          } else {
            // 形がおかしいと言われた分は、送り直しても通らないので捨てる
            console.warn("ひとり用の記録を送れませんでした", r.status, key);
            delete o[key];
            save(o);
            break;
          }
          save(o);
          if (!x.hands.length) break;
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
    const n = Object.values(load())
      .filter((x) => x.uid === u.id)
      .reduce((s, x) => s + x.hands.length, 0);
    box.querySelector("span").textContent = n ? `（まだ送れていない ${n} ハンド）` : "";
  }
  // 開いたとき・ネットにつながったとき・1分ごとに、溜まっている分を送る
  if (typeof window != "undefined") {
    flush();
    window.addEventListener("online", () => flush());
    setInterval(() => Object.keys(load()).length && flush(), 60e3);
  }
  return { start, hand, finish, flush, status };
})();
