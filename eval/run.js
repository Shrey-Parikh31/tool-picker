// Accuracy test: for each prompt in cases.json, ask Claude for its picks and compare
// them with the expected tools. Uses your real Claude Code setup and your Claude usage.
//
//   node eval/run.js        all cases
//   node eval/run.js 5      first 5 cases only
//
// The labels in cases.json were written for one machine's installed tools. Edit them to
// match yours before trusting the score.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const root = path.join(__dirname, '..');
const cases = require('./cases.json').slice(0, Number(process.argv[2]) || undefined);
const PARALLEL = 4;

// The exact text the hook would add to a first prompt on this machine.
const instruction = execFileSync(process.execPath, [path.join(root, 'hooks', 'first-prompt.js')], {
  input: JSON.stringify({ prompt: 'placeholder task', session_id: 'eval-' + Date.now(), cwd: root }),
  encoding: 'utf8',
  env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cli', TOOL_PICKER: '' },
});
assert.ok(instruction, 'the hook printed nothing');

// The live plugin asks the user to choose. Here Claude returns its ranked picks as JSON.
const evalMode = `EVAL MODE. Do steps 1 and 2 only. Do not ask the user, do not do the task, do not call any tool.
Reply with only this JSON and nothing else: {"picks": ["name", "..."]}
At most 4 names, best first, each written exactly as it appears in the inventory or in your context. Use an empty list if nothing fits.`;

function ask(prompt) {
  return new Promise((resolve) => {
    // TOOL_PICKER=off stops the installed plugin from adding the instruction a second time.
    // A run that hangs is given up on after 3 minutes and counted as no answer.
    const child = spawn('claude -p --output-format json --max-turns 2', {
      cwd: root,
      shell: true,
      timeout: 180000,
      env: { ...process.env, TOOL_PICKER: 'off' },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('close', () => {
      try {
        const reply = JSON.parse(out).result;
        resolve(JSON.parse(reply.match(/\{[\s\S]*\}/)[0]).picks.map(String));
      } catch {
        resolve(null); // no usable answer
      }
    });
    child.stdin.end(`${instruction}\n\n${evalMode}\n\nUser prompt: ${prompt}`);
  });
}

// ponytail: a pick matches when it contains an expected name ("claude.ai Sentry" matches
// "sentry"). That is lenient: "debug" also accepts "engineering:debug". Tighten the
// expected names in cases.json where that matters.
const matches = (pick, expect) => expect.some((name) => pick.toLowerCase().includes(name.toLowerCase()));
const top1 = (picks, expect) => (expect.length ? !!picks[0] && matches(picks[0], expect) : picks.length === 0);
const anyPick = (picks, expect) => (expect.length ? picks.some((p) => matches(p, expect)) : picks.length === 0);
assert.ok(top1(['claude.ai Sentry'], ['sentry']) && top1([], []) && !top1(['simplify'], []));
assert.ok(anyPick(['debug', 'code-review'], ['code-review']) && !anyPick(['debug'], ['code-review']));

async function main() {
  const results = new Array(cases.length);
  let next = 0;
  const worker = async () => {
    while (next < cases.length) {
      const i = next++;
      const picks = await ask(cases[i].prompt);
      results[i] = { ...cases[i], picks, top1: !!picks && top1(picks, cases[i].expect), any: !!picks && anyPick(picks, cases[i].expect) };
      console.log(`${results[i].top1 ? 'ok  ' : results[i].any ? 'near' : 'MISS'} ${cases[i].prompt}`);
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));

  const count = (key) => results.filter((r) => r[key]).length;
  const failed = results.filter((r) => !r.picks).length;
  console.log(`\ntop pick correct:   ${count('top1')}/${results.length}`);
  console.log(`correct in top 4:   ${count('any')}/${results.length}`);
  if (failed) console.log(`no usable answer:   ${failed} (counted as wrong)`);
  for (const r of results.filter((r) => !r.top1)) {
    console.log(`\n  ${r.prompt}\n    expected: ${r.expect.join(' | ') || '(nothing)'}\n    got:      ${r.picks ? r.picks.join(', ') || '(nothing)' : 'no answer'}`);
  }
  fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(results, null, 2) + '\n');
}

main();
