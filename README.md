# alpoker-mtt-sim

身内で遊ぶ、5人卓のポーカー疑似トーナメント（40人・8卓・CPU入り）。

- **ひとりで遊ぶ**: `index.html` をブラウザで開くだけ（サーバー不要）
- **みんなで遊ぶ**: ホストのブラウザが部屋を持ち、参加者は部屋ID＋パスワードで入室（PeerJS / WebRTC）

## ファイルの役割

| ファイル | 中身 | 画面 | 通信 |
|---|---|---|---|
| `engine.js` | ルール・役の判定・CPU・大会の作り方（`AlpEngine`） | 触らない | 触らない |
| `room.js` | みんなで遊ぶ部屋：大会の進行（`createRoom`）と入室の受付（`createHost`）（`AlpRoom`） | 触らない | 触らない |
| `net.js` | 通信の口（PeerJS 版 `PeerLink`）と入室の手順（`joinRoom`） | 触らない | ここだけ |
| `game.js` | ひとり用の画面と進行 | ここ | — |
| `mp.js` | みんなで遊ぶの画面とロビー | ここ | `net.js` 経由 |

`engine.js` と `room.js` はブラウザでも Node でも動く（`require("./engine.js")`）。
将来サーバーで部屋を持つときは、`room.js` の `createHost` に WebSocket 用の `send` / `close` を渡せば、同じ受付と進行がそのまま使える。
参加者側は、`net.js` の `PeerLink` と同じ形（`listen` / `dial`）の WebSocket 版を作り、`Net.use()` で差し替える。

ビルドは不要。読み込み順は `index.html` のとおり（engine → room → net → game → mp）。

## テスト

Node 20 以上で:

```bash
npm test
```

追加のインストールは要らない（Node 標準のテスト機能だけを使う）。
大会を早送りの時計で最後まで回して、チップの合計・手札が漏れていないか・切断や復帰・入室の手順を確かめる。
