# glossary

Claude Code 的 mod。agent 回覆裡的工單編號、存在的檔案路徑、登記過的專案名詞，會自動變成連結。滑鼠移到段落上，會跳出一張卡片說明這段提到的東西。設計和取捨見 `docs/design.md`。

## 載入

開發期間在 `~/.claude/settings.json` 的 `env` 加上：

```json
"CLAUDE_CODE_PLUGIN_DIRS": "C:\\Users\\qazsskevin\\src\\cc-glossary"
```

或單次啟動時用 `claude --plugin-dir C:\Users\qazsskevin\src\cc-glossary`。懸停和點擊需要全螢幕模式（settings 裡的 `"tui": "fullscreen"`）。

## 設定

- `~/.claude/glossary.json`：工單規則和跨 repo 的名詞。
- `<repo>/.claude/glossary.json`：這個 repo 的名詞，進版控。agent 用 `mcp__glossary__add` 工具登記的條目寫在這裡。

格式見 `examples/glossary.example.json`。

## 檢查

```
claude plugin validate .
claude plugin test .
```
