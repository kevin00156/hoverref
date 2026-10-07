# hoverref

[English](README.md)

這是一個 [Claude Code](https://claude.com/claude-code) 的 mod。它會把 Claude 回覆裡提到的參照變成連結，滑鼠移到段落上時跳出一張卡片說明這段提到的東西。讀 agent 的回覆時，不用離開對話去查 `CK-12`、`46ce847` 或「車籍表」是什麼。

agent 只負責寫字。連結和卡片內容全部由 mod 從可信的來源產生：工單系統、git、磁碟上的檔案，以及放在 git 裡讓人審查的名詞庫檔案。所以模型不會寫出不存在的網址。

## 哪些東西會變成連結

| 參照 | 怎麼認出來 | 連結指向 | 懸停卡片 |
|---|---|---|---|
| 工單編號 | 你設定的前綴，例如 `CK-12` | 那張工單的網頁 | 狀態和標題，從工單系統抓 |
| 檔案路徑 | 磁碟上真的存在（相對或絕對路徑，可加 `:行號`） | 用 VS Code 打開並跳到那一行 | 被引用的那一行程式碼 |
| commit hash | 7 到 40 位十六進位字串，而且在 session 工作的 repo 裡查得到 | GitHub 上的 commit 頁面（`origin` 在 GitHub 上時才有） | 日期和 commit 標題 |
| 專案名詞 | 登記在名詞庫檔案裡 | 條目的 target（檔案或網址） | 條目的一句話摘要 |

每則回覆裡，同一個參照只有第一次出現會加連結。程式碼區塊、行內程式碼（除非整段就是一個路徑或 hash）、已經是連結的地方和網址裡面，都不會被改動。

## 需要什麼

- 支援 function hooks 外掛的 Claude Code。這套外掛機制官方標示為**早期版本**，隨時可能改；hoverref 是在 2.1.29x 上開發的。
- 全螢幕模式，也就是 `~/.claude/settings.json` 裡的 `"tui": "fullscreen"`。懸停卡片和點擊都需要它。
- 開檔案需要 VS Code 的 `code` 指令在 `PATH` 上；commit hash 需要 `git` 在 `PATH` 上。
- 選用：[Plane](https://plane.so)，工單卡片要用。目前只支援這一種工單系統。

目前只在 Windows 加 Windows Terminal 和 [Herdr](https://herdr.dev) 的環境測過，其他平台理論上可以用，但沒有試過。

## 安裝

在終端機裡的 Claude Code 輸入：

```
/plugin install hoverref --marketplace kevin00156/hoverref
```

問到要不要加入 marketplace 時回答 `y`，接著選安裝範圍。選使用者範圍的話，每個 session 都會載入。

## 設定

名詞庫是名為 `hoverref.json` 的 JSON 檔，依優先順序合併：

1. session 根目錄的 `.claude/hoverref.json`。
2. 這個 session 讀過或改過檔案的每個 repo 裡的 `.claude/hoverref.json`，最近碰過的優先。所以在上層資料夾開的 session，也看得到底下 repo 的名詞。
3. 全域的 `~/.claude/hoverref.json`：放工單系統的設定，以及跨專案通用的名詞。

兩層都定義了同一個詞（名稱或別名）時，以優先順序較前的那層為準。

```json
{
  "trackers": [
    {
      "kind": "plane",
      "baseUrl": "https://plane.example.com",
      "workspace": "work",
      "prefixes": ["CK", "CT"],
      "tokenFile": "~/.config/plane/token"
    }
  ],
  "terms": [
    {
      "name": "車籍表",
      "aliases": ["vehicle registry"],
      "target": "docs/vehicle-registry.md",
      "summary": "每台車的參數收成一張表，取代散落各處的常數"
    }
  ]
}
```

- `trackers` 通常放在全域檔案裡。API 金鑰不會寫進設定檔，`tokenFile` 只記錄金鑰檔的路徑。
- 一筆名詞必填 `name`、`target`、`summary`，`aliases` 選填。相對路徑的 `target` 是相對於放 `.claude` 資料夾的那一層。

### agent 登記的名詞

hoverref 會給 agent 一個工具 `mcp__hoverref__add`，並在系統提示詞裡說明使用時機：遇到使用者可能不知道的專案名詞時登記一次。這個工具會：

- 拒絕不存在的 target；
- 把條目寫進 target 所在 repo 的 `hoverref.json`。agent 傳了 `scope: "global"`，或 target 不在任何 repo 裡時，改寫進全域檔案；
- 不覆蓋既有條目：同名衝突時拒絕寫入，並把既有條目回給 agent；
- 在每輪結束時，用一行暗色通知列出這輪新登記的詞。

repo 的名詞庫檔案應該進版控，這樣 agent 新增的每一筆都會出現在 `git diff` 裡讓你審查。

## 點擊

- **檔案連結請用一般左鍵單擊。** mod 會跳出提示，再用 VS Code 打開並跳到那一行。ctrl+點擊會交給終端機處理；在 Herdr 裡，ctrl+點擊 `file:` 連結不會有任何反應。
- 工單和 commit 的連結是一般的 `http(s)` 連結，由終端機負責打開，多數終端機是 ctrl+點擊。

## 限制

- 懸停卡片以段落為單位，不是單一個詞。原因是 Claude Code 的 markdown 元件裡面不能再放可懸停的元素。
- 工單和 commit 的資料在一個 session 裡只抓一次。工單狀態在 session 中途變了，卡片會顯示舊的。
- 只處理 agent 的回覆文字，不處理工具輸出。

## 開發

```
claude --plugin-dir /path/to/hoverref
claude plugin validate .
claude plugin test .
```

設計說明和取捨寫在 [docs/design.md](docs/design.md)。

## 授權

[MIT](LICENSE)
