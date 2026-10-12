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

One `UserPromptSubmit` hook, [hooks/first-prompt.js](hooks/first-prompt.js), about 170 lines with no dependencies:

1. **Scan.** On the first prompt of a session it reads your Claude Code config and lists the plugins, skills, slash commands and MCP servers installed for you and for the current project.
2. **Hand over.** It adds that list to Claude's context with a short set of ranking rules: exact fit first, a purpose-built tool over a catch-all, working over needs-sign-in, no duplicates.
3. **Ask.** Claude matches your prompt against the list and asks one multi-select question. It uses what you choose, then does the task.

If nothing fits, Claude says so in one line and carries on. Later prompts in the same session are left alone, and so are slash commands, since typing one means you already chose.

The matching is done by Claude, not by keyword rules, so it understands what you mean. The cost is a little extra context on the first prompt of each session.

## Limits

- **Claude Code only.** The claude.ai chat and mobile apps do not run hooks.
- **The disk scan is incomplete.** Connectors added in your claude.ai account and Claude's built-in skills are not stored on disk. The hook tells Claude the list is partial and to add the ones it can see, so they can still be recommended.
- **Installing it mid-session triggers it once** on your next prompt there, because it has not seen that session before. Resumed sessions stay quiet.
- **Greetings are skipped by a short English word list** (`hi`, `thanks`, `ok` and similar), so the picker waits for your first real task.
- **Scripted runs (`claude -p`) are skipped,** since nobody is there to pick. This relies on an undocumented environment variable, so it may stop working in a future Claude Code release.
- **Node.js must be findable.** The hook also looks in `C:\Program Files\nodejs`, because Git Bash on Windows can hand hooks a shortened PATH. If Node is installed somewhere else and missing from PATH, the hook does nothing.

## Turn it off

Set the environment variable `TOOL_PICKER=off` before starting Claude Code. Unset it to turn the picker back on.

## Test

Runs on Linux, macOS and Windows on every push.

```
node test.js
```

## Uninstall

```
/plugin uninstall tool-picker@tool-picker
```

## License

MIT
