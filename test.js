// Run: node test.js
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Everything the hook reads or writes lives in one throwaway folder. Home and the
// config dir are separate on purpose: .claude.json must be found in the config dir.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-picker-test-'));
const [home, cfg, tmp, proj] = ['home', 'cfg', 'tmp', 'proj'].map((name) => path.join(dir, name));
const write = (file, data = '') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
};
[home, tmp, proj].forEach((d) => fs.mkdirSync(d, { recursive: true }));

const run = (prompt, session_id, env = {}) =>
  execFileSync(process.execPath, [path.join(__dirname, 'hooks', 'first-prompt.js')], {
    input: JSON.stringify({ prompt, session_id, cwd: proj }),
    encoding: 'utf8',
    env: {
      ...process.env,
      ...{ CLAUDE_CONFIG_DIR: cfg, HOME: home, USERPROFILE: home, TEMP: tmp, TMP: tmp, TMPDIR: tmp },
      // The test itself may be run from inside Claude Code, so pin these.
      ...{ CLAUDE_CODE_ENTRYPOINT: 'cli', TOOL_PICKER: '' },
      ...env,
    },
  });

const plugin = (name) => path.join(dir, 'plugins', name);
write(path.join(cfg, 'plugins', 'installed_plugins.json'), {
  plugins: {
    'demo@m': [{ scope: 'user', installPath: plugin('demo') }],
    'elsewhere@m': [{ scope: 'project', projectPath: path.join(dir, 'other'), installPath: plugin('elsewhere') }],
    'off@m': [{ scope: 'user', installPath: plugin('off') }],
  },
});
// A plugin using every layout the scan reads: skills/, commands/ and a root SKILL.md.
write(path.join(plugin('demo'), 'skills', 'in-folder', 'SKILL.md'), 'plugin copy');
write(path.join(plugin('demo'), 'commands', 'a-command.md'), 'plugin copy');
write(path.join(plugin('demo'), 'commands', 'not-a-command.toml'), 'plugin copy');
write(path.join(plugin('demo'), 'SKILL.md'), 'plugin copy');
write(path.join(plugin('elsewhere'), 'skills', 'other-project', 'SKILL.md'), 'plugin copy');
write(path.join(plugin('off'), 'skills', 'turned-off', 'SKILL.md'), 'plugin copy');
// Written with a leading BOM, as some Windows editors do.
write(path.join(proj, '.claude', 'settings.local.json'), String.fromCharCode(0xfeff) + JSON.stringify({ enabledPlugins: { 'off@m': false } }));

// Personal copies that differ from each plugin copy above.
for (const name of ['in-folder', 'demo', 'other-project', 'turned-off', 'not-a-command']) {
  write(path.join(cfg, 'skills', name, 'SKILL.md'), 'personal copy');
}
write(path.join(cfg, 'commands', 'a-command.md'), 'personal copy');
// The same skill as a personal and a project copy: one pair differs, one is identical.
write(path.join(cfg, 'skills', 'drifted', 'SKILL.md'), 'old pricing formula');
write(path.join(proj, '.claude', 'skills', 'drifted', 'SKILL.md'), 'new pricing formula');
write(path.join(cfg, 'skills', 'twin', 'SKILL.md'), 'same');
write(path.join(proj, '.claude', 'skills', 'twin', 'SKILL.md'), 'same');

// When it fires.
assert.strictEqual(run('/help', 'a'), '', 'slash commands are skipped');
assert.strictEqual(run('Hi!', 'a'), '', 'greetings are skipped');
const out = run('review my code', 'a');
assert.match(out, /TOOL PICKER/, 'first real prompt gets the instruction');
assert.strictEqual(run('now fix it', 'a'), '', 'later prompts stay silent');
assert.match(run('/etc/hosts is wrong', 'b'), /TOOL PICKER/, 'a prompt starting with a path is a real prompt');
assert.strictEqual(run('review my code', undefined), '', 'no session id, no output');
assert.strictEqual(run('review my code', 'c', { TOOL_PICKER: 'off' }), '', 'TOOL_PICKER=off silences it');
assert.strictEqual(run('review my code', 'c', { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }), '', 'scripted runs are skipped');
assert.match(run('review my code', 'c'), /TOOL PICKER/, 'and neither of those used up the first prompt');

// Drifted duplicates are flagged with the path of every copy.
const flagged = (name) => new RegExp('- ' + name + ': ').test(out);
assert.match(out, /- drifted: .*drifted.SKILL\.md \| .*drifted.SKILL\.md/, 'drifted copies are flagged with paths');
for (const name of ['in-folder', 'a-command', 'demo']) assert.ok(flagged(name), `a personal copy of plugin skill ${name} is flagged`);
assert.ok(!flagged('twin'), 'identical copies are not flagged');
assert.ok(!flagged('not-a-command'), 'non-markdown command files are not skills');
assert.ok(!flagged('other-project'), "another project's plugin is not scanned");
assert.ok(!flagged('turned-off'), 'a plugin disabled in project settings is not scanned');

// Muted names are listed so Claude never suggests them.
write(path.join(cfg, 'tool-picker-ignore.txt'), 'Drifted\n# a comment\nwowerpoint\n');
const muted = run('review my code', 'd');
assert.match(muted, /muted these, so never recommend them: Drifted, wowerpoint\./, 'muted names are listed');
assert.ok(!/a comment/.test(muted), 'comments in the mute file are ignored');

fs.rmSync(dir, { recursive: true });
console.log('ok');
