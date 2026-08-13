# 現場ポータル 試作1号 — Push通知対応版

このフォルダは、掲示板投稿からWeb Push通知を送れる試作です。

## 動作
1. `npm install`
2. `npm start`
3. PCでは `http://localhost:3000` を開く
4. 「通知を有効にする」を押す
5. 「掲示板へ投稿＋通知」を押す

## スマホで本物の通知を受ける
スマホからは HTTPS で公開したURLで開いてください。
Service Worker / Push API は HTTPS のWebサイトで利用します。

## ファイル
- index.html: 試作1号＋Excel手順書＋掲示板通知
- sw.js: Push受信・通知表示
- server.js: 端末登録・Push送信
- manifest.webmanifest: PWA設定
- subscriptions.json: 初回登録時に自動作成
- vapid.json: 初回起動時に自動生成
