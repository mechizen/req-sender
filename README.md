# req-sender

[zresp](https://github.com/mechizen/zresp) を前段 CDN/WAF 越しに叩いて挙動を検証するためのブラウザサイドクライアント。素の HTML + JS、ビルド不要。

ブラウザから直接 `fetch()` するので、送信元 IP はあなたの端末になり、CDN/WAF からは普通のユーザーアクセスとして見える。

## 主な機能

- **ターゲット URL 切替**: datalist で既知の zresp デプロイ先を選択、または手入力
- **プリセット集**: 基本 / WAF (SQLi, XSS, Path Traversal, Log4Shell, SSRF, スキャナ UA など) / CDN・キャッシュ (ETag, Vary, Range, 圧縮) / レート・Bot / レスポンス整形
- **差分パネル**: 「ブラウザが送ったリクエスト」と「zresp が `/api/echo` で返した実受信内容」を並べて表示。CDN/WAF が何を追加・削除・書き換えたかが一目で分かる
- **連打送信**: 並列 N 発、ステータスコード分布を集計。レート制限/チャレンジ誘発用
- **履歴**: localStorage に最大 100 件、クリックでリプレイ
- **curl 書き出し**: 同じリクエストを CLI で再現するためのコマンドをクリップボードに

## 使い方

`file://` でも動くが、Origin が `null` になり CORS で詰まるケースが多いのでローカル HTTP サーバ経由を推奨：

```sh
python3 -m http.server 8000
```

開く: <http://localhost:8000>

## zresp 側に必要な設定

CORS ヘッダを返さないとブラウザがレスポンスを JS に渡してくれない。FastAPI/Starlette 系なら：

```python
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
    max_age=600,
)
```

カスタムヘッダ (`User-Agent` 上書き、`Range`、`If-None-Match`、`X-*` など) を使うプリセットは **CORS preflight (OPTIONS)** が先に飛ぶ。前段 CDN/WAF が OPTIONS を弾くと本リクエストに到達しないので、preflight だけ WAF をスキップするのが定石：

Cloudflare の場合、Custom rule に以下を追加して Skip:

```
(http.host eq "<zresp host>" and http.request.method eq "OPTIONS")
```

これで preflight だけ無検査で通り、本リクエスト (実ペイロード入り) は通常通り WAF を通過する。

## ブラウザ fetch の制約

以下のヘッダはブラウザが設定を許可しないか上書きする：

- `Host`, `Connection`, `Content-Length`
- `Cookie` (クロスオリジン)
- `Referer` (一部制限)
- `User-Agent` (Firefox/Safari は不可、Chrome は可)
- `Origin` (ブラウザが自動付与)

これらを「生のまま送りたい」要件が出たら、Cloudflare Workers の薄いプロキシかローカルの companion スクリプトを足す構成が必要。

## Companion モード (TLS 指紋検証用)

ブラウザの `fetch()` は TLS 指紋がブラウザ自身のものになるため、Cloudflare Bot Management の `cf-bot-score` は実質常に「人間」(99) になる。「`curl` を名乗っているのに Chrome の TLS 指紋」となり、`User-Agent` を curl にしても本物の curl とは区別される。

**Companion モード** は、UI からローカルの Node.js サーバ経由で実 `curl` バイナリを叩き、本物の curl の TLS/HTTP 指紋で zresp に到達する。結果 (status / headers / body / `cf-ja3-hash` / `cf-bot-score`) を UI に返すので、Browser モードとの差分が比較できる。

### 起動

macOS 標準の Python 3 で動く (追加 install 不要)。

```sh
python3 companion.py
# req-sender companion listening on http://127.0.0.1:7777
# detected clients: {'curl': 'curl', 'python': 'python3 urllib', 'go': 'go net/http'}
```

UI のカード右上の **via** セレクタを切り替えて使う：

- `Browser (fetch)` — 既定。ブラウザの TLS 指紋
- `Companion · curl` — 実 curl バイナリ (macOS 標準)
- `Companion · python (urllib)` — Python 標準ライブラリ
- `Companion · python-requests` — companion 起動時に `.venv` を自動作成して install
- `Companion · go` — `brew install go` が必要

利用可能なクライアントは companion 起動時に検出され、UI のステータス表示で確認できる。

#### requests の自動セットアップについて

macOS の Homebrew Python は PEP 668 で `pip3 install` を拒否するため、companion は初回起動時に `.venv/` を自動作成して `requests` をその中にインストールする (`.gitignore` 済み)。所要時間は初回のみ 5-10 秒程度。

自動セットアップしたくない場合は `--no-bootstrap` を渡す：

```sh
python3 companion.py --no-bootstrap
```

許可されている UI Origin (companion.js 内のホワイトリスト):

- `https://req-sender.echi1000.workers.dev`
- `http://localhost:8000`, `http://127.0.0.1:8000`
- `http://localhost:3000`
- `null` (`file://` 経由)

別ホストから使いたければ `companion.js` の `ALLOWED_ORIGINS` を編集する。

### 検証フロー例: Browser vs curl の指紋比較

1. UI で「基本 → Echo (JSON)」プリセットを選択
2. 「Browser (fetch)」モードで送信 → `echo` パネルの `cf-ja3-hash`, `cf-bot-score` をメモ
3. モードを「Companion (curl)」に切り替え、同じプリセットで送信
4. 両者の `cf-ja3-hash` と `cf-bot-score` を見比べる
   - Browser: ブラウザ指紋 (`t13d1516h2_...`系)、score 99 付近
   - curl: curl 指紋 (`t13d1811h2_...`系)、score 1 付近

これで「TLS 指紋ベースの Bot 検知」が可視化できる。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `index.html` | UI 構造 |
| `style.css` | スタイル |
| `app.js` | リクエスト送信・履歴・差分表示ロジック |
| `presets.js` | プリセットデータ |
| `companion.py` | ローカル Python サーバ。UI からの POST で curl/python/go の実バイナリを spawn する |

## ライセンス

未指定 (検証用ツールなので necessary になったら追加)。
