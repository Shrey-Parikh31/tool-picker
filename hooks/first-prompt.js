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
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
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
  const enabled = readJson(path.join(claudeDir, 'settings.json')).enabledPlugins || {};
  const installed = readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json')).plugins || {};

  // ~/.claude.json keeps this folder's own settings under projects[<folder>]. The same
  // folder can appear twice, once with / and once with \, so match on the resolved path.
  const config = readJson(path.join(os.homedir(), '.claude.json'));
  const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
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
    const root = installs[0] && installs[0].installPath;
    if (!root) continue;
    const found = toolsIn(root, name + ':', name);
    skills.push(...found);
    // A plugin declares its servers in .mcp.json, in plugin.json, or both.
    const mcp = readJson(path.join(root, '.mcp.json'));
    const inManifest = readJson(path.join(root, '.claude-plugin', 'plugin.json')).mcpServers;
    const servers = { ...(mcp.mcpServers || mcp), ...(typeof inManifest === 'object' ? inManifest : {}) };
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

1. Inventory. A disk scan found ${inv.plugins.length} plugins, ${inv.skills.length} skills and ${inv.connectors.length} connectors:
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

If nothing fits, say so in one line and do the task directly. Do not pad the list, and do not suggest installing anything.`;
}

function main() {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {}

  const prompt = (input.prompt || '').trim();
  // A slash command means the user already chose a tool; wait for a real prompt.
  if (!prompt || prompt.startsWith('/')) return;

  // One marker file per session so this fires on the first prompt only.
  const id = String(input.session_id || 'unknown').replace(/[^\w-]/g, '');
  const marker = path.join(os.tmpdir(), `tool-picker-${id}`);
  if (fs.existsSync(marker)) return;
  fs.writeFileSync(marker, '');

  process.stdout.write(instruction(scan(input.cwd || process.cwd())));
}

// A broken hook must never block the user's prompt.
try {
  main();
} catch {}
