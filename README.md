# ラスト・ユニット
PC・スマホ(横画面)向けトップダウン・ホバーメカアクション。

- `index.html` … ゲーム本体(1枚)
- `server.js` … 配信 + マップ実装申請の受付 + 作者のマップ設定(依存なし / Node 18+)
- 作者専用URL: `https://(サイト)/?author=合言葉` → 暗証番号を入力(環境変数 `AUTHOR_KEY` / `AUTHOR_PIN`)
- 環境変数(任意)
  - `DISCORD_WEBHOOK_URL` … 申請・設定変更をDiscordへ通知(JSON添付)
  - `GITHUB_TOKEN` + `GITHUB_REPO` … マップ設定(config.json)と申請(submissions.json)をリポジトリへ保存。コミットは `[skip render]` なので再デプロイされません。トークンは対象リポジトリの Contents: Read and write のみを許可。
