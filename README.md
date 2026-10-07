# hoverref

[中文說明](README.zh-TW.md)

A [Claude Code](https://claude.com/claude-code) mod that turns the references in Claude's replies into links, and shows a card explaining them when you hover over a paragraph. You read what the agent wrote without leaving the conversation to look up what `CK-12`, `46ce847` or "the registry table" is.

The agent only writes plain text. Every link and every card is produced by the mod from a source of truth (your issue tracker, git, the file on disk, a glossary file under review in git), so the model never makes up a URL.

## What gets linked

| Reference | Recognised by | Link | Hover card |
|---|---|---|---|
| Ticket ID | Prefixes you configure, e.g. `CK-12` | The ticket's page | State and title, fetched from the tracker |
| File path | Exists on disk (relative or absolute, with an optional `:line`) | Opens VS Code at that line | The referenced line of code |
| Commit hash | 7–40 hex characters that resolve to a commit in a repo the session works in | The commit on GitHub, when `origin` is on GitHub | Date and subject |
| Project term | Registered in a glossary file | The term's target (a file or URL) | The term's one-line summary |

Only the first mention of each reference in a reply is linked. Code blocks, inline code (other than a whole path or hash), existing links and URLs are left alone.

## Requirements

- Claude Code with function-hooks plugins. These are **early access** and may change between releases; hoverref was developed against 2.1.29x.
- The fullscreen renderer (`"tui": "fullscreen"` in `~/.claude/settings.json`) for hover cards and clicks.
- VS Code's `code` command on `PATH`, for opening files; `git` on `PATH`, for commit hashes.
- Optional: a [Plane](https://plane.so) instance, for ticket cards. It is the only tracker supported so far.

Tested on Windows with Windows Terminal and [Herdr](https://herdr.dev). Other platforms should work but have not been tried.

## Install

At the prompt of a Claude Code session in a terminal:

```
/plugin install hoverref --marketplace kevin00156/hoverref
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

## Configuration

Glossaries are JSON files named `hoverref.json`, merged in priority order:

1. `.claude/hoverref.json` at the session's root.
2. `.claude/hoverref.json` in every repo the session has read or written files in, most recent first. A session started above a repo still sees that repo's terms.
3. `~/.claude/hoverref.json`, the global file: tracker settings and terms shared across projects.

When two layers define the same word (name or alias), the earlier layer wins.

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
      "name": "registry table",
      "aliases": ["vehicle registry"],
      "target": "docs/vehicle-registry.md",
      "summary": "Per-vehicle parameters kept in one table instead of scattered constants"
    }
  ]
}
```

- `trackers` usually lives in the global file. The API key is never stored in the config; `tokenFile` points to a file holding it.
- A term needs `name`, `target` and `summary`; `aliases` is optional. A relative `target` is relative to the directory holding the `.claude` folder.

### Terms the agent registers

hoverref gives the agent a tool, `mcp__hoverref__add`, and tells it in the system prompt when to use it: once, for a project-specific term the user may not know. The tool:

- refuses a target that does not exist;
- writes to the `hoverref.json` of the repo the target lives in, or to the global file when the agent passes `scope: "global"` or the target is in no repo;
- never overwrites an entry: a clash is refused and the existing entry is returned to the agent;
- lists what was registered in a dim line at the end of the turn.

Repo glossaries are meant to be committed, so every term the agent adds shows up in `git diff` for you to review.

## Clicking

- **File links: a plain left click.** The mod opens VS Code at the line and shows a toast. A Ctrl+click is handed to the terminal instead; under Herdr it does nothing for `file:` links.
- Ticket and commit links are ordinary `http(s)` links, opened by your terminal (Ctrl+click in most terminals).

## Limitations

- Hover cards are per paragraph, not per word: Claude Code's markdown element cannot hold hoverable children.
- Ticket and commit details are cached for the session; a ticket's state changed mid-session shows the old value.
- Only assistant replies are processed, not tool output.

## Development

```
claude --plugin-dir /path/to/hoverref
claude plugin validate .
claude plugin test .
```

CI runs the same checks on Linux and Windows. To release, bump `version` in `.claude-plugin/plugin.json` (Claude Code only updates installed copies when it changes), then push a matching `v` tag.

Design notes and trade-offs (in Traditional Chinese) are in [docs/design.md](docs/design.md).

## License

[MIT](LICENSE)
