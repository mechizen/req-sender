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

## ファイル構成

| ファイル | 役割 |
|---|---|
| `index.html` | UI 構造 |
| `style.css` | スタイル |
| `app.js` | リクエスト送信・履歴・差分表示ロジック |
| `presets.js` | プリセットデータ |

## ライセンス

未指定 (検証用ツールなので necessary になったら追加)。
