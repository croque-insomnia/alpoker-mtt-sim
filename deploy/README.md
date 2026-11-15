# VPS への置き方

`https://kaina-lab.com/poker/mtt/` で動いている構成の作り方。新しく VPS を用意し直すときや、別の人が同じものを作るときに使う。

```
ブラウザ ──HTTPS──▶ Caddy(443) ──▶ Node(127.0.0.1:8080)  server/server.js
                   証明書を自動で取得・更新     systemd が落ちたら再起動する
```

| ファイル | 置き場所 | 中身 |
|---|---|---|
| `alpoker.service` | `/etc/systemd/system/alpoker.service` | 自動起動の設定 |
| `Caddyfile` | `/etc/caddy/Caddyfile` | HTTPS と振り分け（`/poker/` と `/poker/mtt/`） |
| `poker-index.html` | `/var/www/poker/index.html` | `/poker/` の入口ページ |
| （リポジトリには置かない） | `/etc/alpoker.env` | 部屋を作る合言葉 `CREATE_KEY=...` |

前提：Ubuntu 24.04 LTS、メモリ 1GB 程度、独自ドメイン（ここでは `kaina-lab.com`）。

## 1. VPS を借りる

- OS は Ubuntu 24.04 を選び、**SSH の公開鍵（`.pub` の中身）を登録**する
  - 鍵がなければ手元の PC で作る（Windows なら PowerShell）: `ssh-keygen -t ed25519`
  - 秘密鍵（`.pub` が付かない方）は誰にも渡さない。人ごと・PC ごとに鍵を分ける（共有しない）
- **VPS 会社の管理画面のファイアウォールで 80 と 443 を開ける**
  - さくらのVPS なら「パケットフィルター」。標準では SSH しか通さないことがある
  - ここが閉じていると、手順 6 で証明書が取れない（`Timeout during connect (likely firewall problem)`）
- ドメインの DNS で、A レコードを VPS の IP に向ける

## 2. 作業用ユーザーと SSH

VPS によって、最初に入るのが `root` のことも、`ubuntu` のような sudo 付きユーザーのこともある。後者なら、以下のコマンドに `sudo` を付けて実行する。

```bash
sudo adduser kaina                 # Room Number などは空欄で Enter。パスワードだけは設定する
sudo usermod -aG sudo kaina
sudo rsync --archive --chown=kaina:kaina /home/ubuntu/.ssh /home/kaina   # 最初のユーザーが root なら ~/.ssh
```

**今のターミナルは閉じずに**、別のターミナルから鍵で入れることを確かめる:

```bash
ssh -o PasswordAuthentication=no kaina@<VPSのIP>
sudo whoami                        # root と出れば OK
```

入れたら、パスワードでのログインを止める（`50-cloud-init.conf` などより先に読まれるよう、`00-` で始まる名前にする）:

```bash
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' | sudo tee /etc/ssh/sshd_config.d/00-hardening.conf
sudo sshd -t && sudo systemctl restart ssh
sudo sshd -T | grep -E "passwordauthentication|permitrootlogin"   # passwordauthentication no になっていれば OK
```

## 3. ファイアウォールと OS の更新

```bash
sudo ufw allow OpenSSH             # 先に SSH を許可してから有効にする（逆だと締め出される）
sudo ufw allow 80,443/tcp
sudo ufw enable
sudo apt update && sudo apt upgrade -y && sudo apt install -y unattended-upgrades
[ -f /var/run/reboot-required ] && sudo reboot
```

## 4. Node 22・Caddy・git

Ubuntu 標準の Node は古いので NodeSource から入れる。

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs caddy git
node -v                            # v22. で始まれば OK
```

npm の「新しい版があります」というお知らせは無視してよい（Node 22 に付いてくる版のまま使う）。

## 5. アプリを置いて起動する

```bash
# アプリを動かすためだけのユーザー（ログインできない）。これを先に作らないと起動できない（status=217/USER）
sudo useradd --system --no-create-home --shell /usr/sbin/nologin alpoker
sudo git clone https://github.com/croque-insomnia/alpoker-mtt-sim.git /opt/alpoker-mtt-sim
cd /opt/alpoker-mtt-sim && sudo npm ci --omit=dev

# 部屋を作る合言葉。これがないと起動できない（unavailable resources）
#   自分で考えるのが面倒なら: openssl rand -base64 18
echo 'CREATE_KEY=身内だけの合言葉' | sudo tee /etc/alpoker.env && sudo chmod 600 /etc/alpoker.env

sudo cp deploy/alpoker.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now alpoker
curl -s http://127.0.0.1:8080/api/hello    # {"server":1,"needKey":true} なら OK
```

動かないときは `sudo journalctl -u alpoker -n 30 --no-pager` を見る。

## 6. HTTPS（Caddy）

**DNS が VPS を指していることを先に確かめる**（違う向き先のまま証明書を取りに行くと失敗が重なり、しばらく取れなくなる）:

```bash
getent ahostsv4 kaina-lab.com | head -1    # VPS の IP が出れば OK
```

```bash
cd /opt/alpoker-mtt-sim
sudo mkdir -p /var/www/poker
sudo cp deploy/poker-index.html /var/www/poker/index.html
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile      # 別のドメインなら1行目を書き換える
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

1分ほど待って:

```bash
curl -sS https://kaina-lab.com/poker/mtt/api/hello   # {"server":1,"needKey":true} なら完成
```

| 出たもの | 意味 |
|---|---|
| `tlsv1 alert internal error` | 証明書をまだ持っていない。下のログを見る |
| ログに `Timeout during connect (likely firewall problem)` | 外から 80/443 に届いていない。VPS 会社のファイアウォール（手順 1） |
| ログに `zerossl` … `caddy_legacy_user_removed` | 予備の発行元のエラー。Let's Encrypt で取れれば無視してよい |

```bash
sudo journalctl -u caddy -n 40 --no-pager | grep -iE "obtain|challenge|error|certificate"
```

ファイアウォールを開けたあとは `sudo systemctl restart caddy` で、すぐ取り直させられる。

## 更新するとき

**再起動すると、遊んでいる途中の大会は消える**（部屋はメモリ上にある）。誰も遊んでいないときに:

```bash
cd /opt/alpoker-mtt-sim && sudo git pull && sudo npm ci --omit=dev && sudo systemctl restart alpoker
```

設定ファイル（`deploy/` の中身）を変えたときは、手順 5・6 の `cp` をやり直して、`sudo systemctl daemon-reload`（service を変えたとき）・`sudo systemctl reload caddy`（Caddyfile を変えたとき）。

## 合言葉を変えるとき

`/etc/alpoker.env` を書き換えて `sudo systemctl restart alpoker`。部屋を作る人にだけ伝え直す（参加するだけの人には関係ない）。

## 次のアプリを足すとき

1. そのアプリを別のポート（8081 など）で動かす（service をもう1つ作る）
2. `Caddyfile` のコメントにある `handle_path /poker/xxx/*` のブロックを有効にする
3. `poker-index.html` にリンクを1行足す
