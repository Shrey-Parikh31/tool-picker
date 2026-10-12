#!/usr/bin/env node
// tool-picker: UserPromptSubmit hook.
// On the first prompt of a session: scan what the user has installed, then tell
// Claude to recommend the best-fitting installed tools before starting work.
// Whatever this prints to stdout is added to Claude's context for that prompt.

const fs = require('fs');
const os = require('os');
const path = require('path');

const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

const readJson = (file) => {
  try {
    // Some Windows editors put a byte order mark (char 0xFEFF) first, which JSON.parse rejects.
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return {};
  }
};

// Names of the skills in a skills/ folder (one subfolder per skill, each with a SKILL.md).
const skillsIn = (dir, prefix = '') => {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => fs.existsSync(path.join(dir, name, 'SKILL.md')))
      .map((name) => prefix + name);
  } catch {
    return [];
  }
};

// Names of the slash commands in a commands/ folder (one .md file each). Claude Code
// lists these alongside skills, so they count as skills here too.
const commandsIn = (dir, prefix = '') => {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => prefix + name.slice(0, -3));
  } catch {
    return [];
  }
};

// Everything skill-like under one root: skills/, commands/, and a lone SKILL.md at the root.
const toolsIn = (root, prefix = '', rootSkill = '') => [
  ...skillsIn(path.join(root, 'skills'), prefix),
  ...commandsIn(path.join(root, 'commands'), prefix),
  ...(rootSkill && fs.existsSync(path.join(root, 'SKILL.md')) ? [prefix + rootSkill] : []),
];

function scan(cwd) {
  // Plugins can be switched on or off per user, per project, or in local project settings.
  const enabled = Object.assign(
    {},
    ...[claudeDir, path.join(cwd, '.claude')].flatMap((dir) =>
      ['settings.json', 'settings.local.json'].map((name) => readJson(path.join(dir, name)).enabledPlugins)
    )
  );
  const installed = readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json')).plugins || {};

  // ~/.claude.json keeps this folder's own settings under projects[<folder>]. The same
  // folder can appear twice, once with / and once with \, so match on the resolved path.
  // The file moves into CLAUDE_CONFIG_DIR when that is set.
  const config = readJson(path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json'));
  const fold = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const samePath = (a, b) => fold(a) === fold(b);
  const here = Object.entries(config.projects || {})
    .filter(([dir]) => samePath(dir, cwd))
    .map(([, project]) => project);
  const off = new Set(here.flatMap((p) => [...(p.disabledMcpServers || []), ...(p.disabledMcpjsonServers || [])]));

  const plugins = [];
  const skills = [...toolsIn(claudeDir), ...toolsIn(path.join(cwd, '.claude'))];
  const connectors = [
    ...Object.keys(config.mcpServers || {}),
    ...here.flatMap((p) => Object.keys(p.mcpServers || {})),
    ...Object.keys(readJson(path.join(cwd, '.mcp.json')).mcpServers || {}),
  ];

  for (const [id, installs] of Object.entries(installed)) {
    if (enabled[id] === false) continue;
    const name = id.split('@')[0];
    // An install made for another project's folder is not loaded here.
    const install = installs.find((i) => !i.projectPath || samePath(i.projectPath, cwd));
    const root = install && install.installPath;
    if (!root) continue;
    const found = toolsIn(root, name + ':', name);
    skills.push(...found);
    // A plugin declares its servers in .mcp.json, in plugin.json, or both.
    const mcp = readJson(path.join(root, '.mcp.json'));
    // In plugin.json it is either the servers themselves or a path to a JSON file of them.
    let inManifest = readJson(path.join(root, '.claude-plugin', 'plugin.json')).mcpServers;
    if (typeof inManifest === 'string') inManifest = readJson(path.join(root, inManifest));
    if (!inManifest || typeof inManifest !== 'object' || Array.isArray(inManifest)) inManifest = {};
    const servers = { ...(mcp.mcpServers || mcp), ...(inManifest.mcpServers || inManifest) };
    connectors.push(...Object.keys(servers).map((server) => `plugin:${name}:${server}`));
    // A plugin with only hooks is always on; there is nothing in it to pick.
    if (found.length || Object.keys(servers).length) plugins.push(name);
  }

  // ponytail: disk scan only, default folder names only. Connectors added in the user's
  // claude.ai account and Claude's built-in skills are not on disk, so the instruction
  // below tells Claude to add the ones it can see in its own context. Read the
  // skills/commands paths from plugin.json if a plugin ever moves them.
  return { plugins, skills: [...new Set(skills)], connectors: [...new Set(connectors)].filter((c) => !off.has(c)) };
}

function instruction(inv) {
  return `TOOL PICKER: this is the first prompt of the session. Before doing any work on it:

1. Inventory. A disk scan found these (it cannot see everything, so the list is partial):
   plugins: ${inv.plugins.join(', ') || 'none'}
   skills: ${inv.skills.join(', ') || 'none'}
   connectors: ${inv.connectors.join(', ') || 'none'}
   Add the built-in skills and account connectors listed in your own context. That combined set is everything you may recommend. Never recommend anything outside it.

2. Match the user's prompt against that set, ranking in this order:
   a. Fit: its description covers this exact task, not just the general area.
   b. A tool made for this job beats a catch-all.
   c. Working now beats needs sign-in or failed; label those if you list them.
   d. If two do the same job, keep the better one and mention the other in its reason.

3. Show at most 4 picks, best first, as one multi-select question (use AskUserQuestion if you have it, otherwise a numbered list). Each pick: name, type (skill, connector or plugin), and one sentence on why it fits this prompt. Say when picks work as a set.

4. Use what the user selects, then do the task.

If you cannot ask the user (a non-interactive run), choose the best fit yourself, name it in one line, and do the task.

If nothing fits, say so in one line and do the task directly. Do not pad the list, and do not suggest installing anything.`;
}

function main() {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {}

  // Off switch, and scripted runs (claude -p), where nobody is there to pick.
  // ponytail: CLAUDE_CODE_ENTRYPOINT is not a documented variable; observed as sdk-cli
  // for claude -p. If it changes, scripted runs get the picker text again, nothing worse.
  if (/^(off|0|false)$/i.test(process.env.TOOL_PICKER || '')) return;
  if (process.env.CLAUDE_CODE_ENTRYPOINT === 'sdk-cli') return;

  const prompt = (input.prompt || '').trim();
  // A slash command means the user already chose a tool; wait for a real prompt.
  // (That is /name, not a path like /etc/hosts.) A greeting is not a task either.
  // ponytail: fixed greeting list, English only. Widen it if small talk still triggers picks.
  if (!prompt || /^\/[\w:-]+(\s|$)/.test(prompt)) return;
  if (/^(hi+|hello|hey|yo|thanks|thank you|ok|okay|test)\b[\s!.?]*$/i.test(prompt)) return;

  // One marker file per session so this fires on the first prompt only. Resuming a
  // session keeps its id, so it stays quiet then too.
  // ponytail: markers are never deleted; they are empty files in the OS temp folder.
  const id = String(input.session_id || '').replace(/[^\w-]/g, '');
  if (!id) return;
  const marker = path.join(os.tmpdir(), `tool-picker-${id}`);
  if (fs.existsSync(marker)) return;
  fs.writeFileSync(marker, '');

  process.stdout.write(instruction(scan(input.cwd || process.cwd())));
}

// A broken hook must never block the user's prompt.
try {
  main();
} catch {}
