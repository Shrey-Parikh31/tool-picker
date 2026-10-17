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

const list = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

// Everything skill-like under one root, as { name, file }: skills/<name>/SKILL.md,
// slash commands in commands/<name>.md (Claude Code lists these alongside skills),
// and a lone SKILL.md at the root, named after the plugin.
const toolsIn = (root, prefix = '', rootSkill = '') => [
  ...list(path.join(root, 'skills'))
    .map((n) => ({ name: prefix + n, file: path.join(root, 'skills', n, 'SKILL.md') }))
    .filter((t) => fs.existsSync(t.file)),
  ...list(path.join(root, 'commands'))
    .filter((n) => n.endsWith('.md'))
    .map((n) => ({ name: prefix + n.slice(0, -3), file: path.join(root, 'commands', n) })),
  ...(rootSkill && fs.existsSync(path.join(root, 'SKILL.md'))
    ? [{ name: prefix + rootSkill, file: path.join(root, 'SKILL.md') }]
    : []),
];

const bare = (name) => name.slice(name.lastIndexOf(':') + 1).toLowerCase();
const short = (file) => file.replace(os.homedir(), '~');

// Skills with the same name in several places whose files differ, so the name alone
// does not say which copy will run. Plugin skills are namespaced (plugin:name), so two
// plugins sharing a name is normal; a group is only flagged if an unnamespaced copy
// (personal or project skill) is involved.
function duplicates(tools) {
  const groups = {};
  for (const t of tools) (groups[bare(t.name)] ||= []).push(t);
  return Object.entries(groups)
    .filter(([, g]) => g.length > 1 && g.some((t) => !t.name.includes(':')))
    .filter(([, g]) => new Set(g.map((t) => fs.readFileSync(t.file, 'utf8'))).size > 1)
    .map(([name, g]) => ({ name, files: g.map((t) => short(t.file)) }));
}

// Names the user asked never to see again, one per line; # starts a comment.
const ignoreFile = path.join(claudeDir, 'tool-picker-ignore.txt');
const ignored = () =>
  fs.existsSync(ignoreFile)
    ? fs.readFileSync(ignoreFile, 'utf8').split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean)
    : [];

// Finds skill files on disk to spot drifted duplicates. Claude already sees every
// installed tool in its own context, so the hook does not list them again.
function scan(cwd) {
  // Plugins can be switched on or off per user, per project, or in local project settings.
  const enabled = Object.assign(
    {},
    ...[claudeDir, path.join(cwd, '.claude')].flatMap((dir) =>
      ['settings.json', 'settings.local.json'].map((name) => readJson(path.join(dir, name)).enabledPlugins)
    )
  );
  const installed = readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json')).plugins || {};
  const fold = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

  const tools = [...toolsIn(claudeDir), ...toolsIn(path.join(cwd, '.claude'))];
  for (const [id, installs] of Object.entries(installed)) {
    if (enabled[id] === false) continue;
    // An install made for another project's folder is not loaded here.
    const install = installs.find((i) => !i.projectPath || fold(i.projectPath) === fold(cwd));
    if (install && install.installPath) tools.push(...toolsIn(install.installPath, id.split('@')[0] + ':', id.split('@')[0]));
  }

  // ponytail: default folder names only. Read the skills/commands paths from plugin.json
  // if a plugin ever moves them.
  return { duplicates: duplicates(tools), muted: ignored() };
}

function instruction(inv) {
  const dupes = inv.duplicates.length
    ? `\n   These skills exist in more than one place with different contents, so the name alone does not say which copy runs:\n${inv.duplicates
        .map((d) => `   - ${d.name}: ${d.files.join(' | ')}`)
        .join('\n')}\n   If you pick one of them, put its paths in the reason and say the copies differ.`
    : '';
  const muted = inv.muted.length ? `\n   The user muted these, so never recommend them: ${inv.muted.join(', ')}.` : '';
  return `TOOL PICKER: this is the first prompt of the session. Before doing any work on it:

1. Inventory: the skills, plugins and connectors listed in your own context, including built-in skills and account connectors. That set is everything you may recommend. Never recommend anything outside it.${dupes}${muted}

2. Match the user's prompt against that set, ranking in this order:
   a. Fit: its description covers this exact task, not just the general area.
   b. A tool made for this job beats a catch-all.
   c. Working now beats needs sign-in or failed; label those if you list them.
   d. If two do the same job, keep the better one and mention the other in its reason.

3. Show at most 4 picks, best first, as one multi-select question (use AskUserQuestion if you have it, otherwise a numbered list). Each pick: name, type (skill, connector or plugin), and one sentence on why it fits this prompt. Say when picks work as a set.

4. Use what the user selects, then do the task.

If you cannot ask the user (a non-interactive run), choose the best fit yourself, name it in one line, and do the task.

If nothing fits, say so in one line and do the task directly. Do not pad the list, and do not suggest installing anything.

If the user asks you to stop suggesting something, add its exact name on a new line of ${short(ignoreFile)} (create the file if needed). This mutes it in future sessions without disabling it.`;
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
