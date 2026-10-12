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
    'hooksonly@m': [{ scope: 'user', installPath: plugin('hooksonly') }],
    'elsewhere@m': [{ scope: 'project', projectPath: path.join(dir, 'other'), installPath: plugin('elsewhere') }],
    'off@m': [{ scope: 'user', installPath: plugin('off') }],
  },
});
// One plugin that uses every layout the scan must find.
write(path.join(plugin('demo'), 'skills', 'in-folder', 'SKILL.md'));
write(path.join(plugin('demo'), 'commands', 'a-command.md'));
write(path.join(plugin('demo'), 'commands', 'ignored.toml'));
write(path.join(plugin('demo'), 'SKILL.md'));
write(path.join(plugin('demo'), '.mcp.json'), { 'file-server': {} });
write(path.join(plugin('demo'), '.claude-plugin', 'plugin.json'), { mcpServers: './servers.json' });
write(path.join(plugin('demo'), 'servers.json'), { mcpServers: { 'manifest-server': {} } });
write(path.join(plugin('elsewhere'), 'skills', 'other-project', 'SKILL.md'));
write(path.join(plugin('off'), 'skills', 'turned-off', 'SKILL.md'));
// Written with a leading BOM, as some Windows editors do.
write(path.join(proj, '.claude', 'settings.local.json'), String.fromCharCode(0xfeff) + JSON.stringify({ enabledPlugins: { 'off@m': false } }));
// This folder's own connectors, keyed with / while the hook is given \ on Windows.
write(path.join(cfg, '.claude.json'), {
  projects: {
    [proj.replace(/\\/g, '/')]: {
      mcpServers: { 'local-server': {}, 'switched-off': {} },
      disabledMcpServers: ['switched-off'],
    },
  },
});

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

// What the scan finds.
for (const name of ['demo:in-folder', 'demo:a-command', 'demo:demo', 'plugin:demo:file-server', 'plugin:demo:manifest-server', 'local-server']) {
  assert.ok(out.includes(name), `scan finds ${name}`);
}
assert.ok(!out.includes('ignored'), 'non-markdown command files are skipped');
assert.ok(!out.includes('switched-off'), 'disabled connectors are skipped');
assert.ok(!out.includes('hooksonly'), 'plugins with nothing to pick are not listed');
assert.ok(!out.includes('other-project'), "another project's plugin is not listed");
assert.ok(!out.includes('turned-off'), 'a plugin disabled in project settings is not listed');

fs.rmSync(dir, { recursive: true });
console.log('ok');
