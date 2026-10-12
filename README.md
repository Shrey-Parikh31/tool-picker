# tool-picker

A Claude Code plugin that shows you which of your installed skills, connectors and plugins fit your request, before Claude starts working.

Claude already chooses tools by itself, but it does so silently. If you have dozens of skills and connectors installed, you rarely find out which ones it considered or skipped. tool-picker makes that choice visible: on the first prompt of each session you get up to four picks, each with a one-line reason, and you tick the ones you want used.

It only recommends what you already have. It never suggests installing anything.

## Install

Requires [Claude Code](https://claude.com/claude-code) and Node.js on your PATH.

```
/plugin marketplace add Shrey-Parikh31/tool-picker
/plugin install tool-picker@tool-picker
```

Start a new session and type a real task, for example `review my code`.

## How it works

One `UserPromptSubmit` hook, [hooks/first-prompt.js](hooks/first-prompt.js), about 140 lines with no dependencies:

1. **Scan.** On the first prompt of a session it reads your Claude Code config and lists the plugins, skills, slash commands and MCP servers installed for you and for the current project.
2. **Hand over.** It adds that list to Claude's context with a short set of ranking rules: exact fit first, a purpose-built tool over a catch-all, working over needs-sign-in, no duplicates.
3. **Ask.** Claude matches your prompt against the list and asks one multi-select question. It uses what you choose, then does the task.

If nothing fits, Claude says so in one line and carries on. Later prompts in the same session are left alone, and so are slash commands, since typing one means you already chose.

The matching is done by Claude, not by keyword rules, so it understands what you mean. The cost is a little extra context on the first prompt of each session.

## Limits

- **Claude Code only.** The claude.ai chat and mobile apps do not run hooks.
- **The disk scan is incomplete.** Connectors added in your claude.ai account and Claude's built-in skills are not stored on disk. The hook tells Claude to add the ones it can see, so they can still be recommended, but the counts it reports are low.
- **"First prompt" means first prompt after each start.** Reopening an old session triggers it again.
- **Non-interactive runs (`claude -p`) cannot ask a question,** so Claude lists its picks and continues.
- **Git Bash on Windows:** if hooks fail with `node: command not found`, start `claude` from PowerShell.

## Test

```
node test.js
```

## Uninstall

```
/plugin uninstall tool-picker@tool-picker
```

## License

MIT
