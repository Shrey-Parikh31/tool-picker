// Run: node test.js
const assert = require('assert');
const { execFileSync } = require('child_process');

const fs = require('fs');
const os = require('os');
const path = require('path');

const run = (prompt, session_id, env = {}) =>
  execFileSync(process.execPath, ['hooks/first-prompt.js'], {
    cwd: __dirname,
    input: JSON.stringify({ prompt, session_id, cwd: __dirname }),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

const id = 'test-' + Date.now();
assert.strictEqual(run('/help', id), '', 'slash commands are skipped');
assert.match(run('review my code', id), /TOOL PICKER/, 'first real prompt gets the instruction');
assert.strictEqual(run('now fix it', id), '', 'later prompts stay silent');

// A fake config dir with one plugin that uses every layout the scan must find.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-picker-test-'));
const root = path.join(dir, 'demo');
const write = (file, text = '') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
write(
  path.join(dir, 'plugins', 'installed_plugins.json'),
  JSON.stringify({ plugins: { 'demo@m': [{ installPath: root }], 'hooksonly@m': [{ installPath: path.join(dir, 'empty') }] } })
);
// This folder's own connectors, keyed with / while the hook is given \ on Windows.
write(
  path.join(dir, '.claude.json'),
  JSON.stringify({
    projects: {
      [__dirname.replace(/\\/g, '/')]: {
        mcpServers: { 'local-server': {}, 'switched-off': {} },
        disabledMcpServers: ['switched-off'],
      },
    },
  })
);
write(path.join(root, 'skills', 'in-folder', 'SKILL.md'));
write(path.join(root, 'commands', 'a-command.md'));
write(path.join(root, 'commands', 'ignored.toml'));
write(path.join(root, 'SKILL.md'));
write(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ mcpServers: { 'manifest-server': {} } }));
const out = run('review my code', id + '-scan', { CLAUDE_CONFIG_DIR: dir, HOME: dir, USERPROFILE: dir });
fs.rmSync(dir, { recursive: true });
for (const name of ['demo:in-folder', 'demo:a-command', 'demo:demo', 'plugin:demo:manifest-server', 'local-server']) {
  assert.ok(out.includes(name), `scan finds ${name}`);
}
assert.ok(!out.includes('ignored'), 'non-markdown command files are skipped');
assert.ok(!out.includes('switched-off'), 'disabled connectors are skipped');
assert.ok(!out.includes('hooksonly'), 'plugins with nothing to pick are not listed');
console.log('ok');
