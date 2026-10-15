// Which tools a session gets (agent/tool-policy.ts).
//
// run_script runs Node.js on the user's machine, with shell access, so like
// the Copilot CLI's bash it must stay off until the user switches it on.
// Until 0.1.10 it was a default-on browser tool, labeled in Settings as
// running a script in the page.
//
// Run: node tests/tool-policy.mjs   (Node 23.6+ strips the .ts types itself)

import { toolPolicy, OPT_IN_TOOLS } from '../src/agent/tool-policy.ts';

const failures = [];
const check = (name, cond, detail = '') => { if (!cond) failures.push(`${name}${detail ? `\n    ${detail}` : ''}`); };
const tools = ['inspect_page', 'click_index', 'evaluate_js', 'run_script', 'read_file'].map((name) => ({ name }));
const names = (r) => r.tools.map((t) => t.name).join(',');
const policy = (disabled = [], enabled = []) => toolPolicy(tools, new Set(disabled), new Set(enabled));

let r = policy();
check('run_script is off by default', !names(r).includes('run_script') && !r.allow.includes('run_script'), JSON.stringify(r.allow));
check('browser tools are on by default', ['inspect_page', 'click_index', 'evaluate_js', 'read_file'].every((n) => r.allow.includes(n)), JSON.stringify(r.allow));
check('no CLI host tool is allowed by default', !r.allow.includes('bash') && !r.allow.includes('web_fetch'), JSON.stringify(r.allow));

r = policy([], ['run_script']);
check('switching run_script on hands the SDK its definition', names(r).includes('run_script') && r.allow.includes('run_script'), JSON.stringify(r.allow));

r = policy([], ['bash']);
check('a CLI host tool switched on joins the allowlist only', r.allow.includes('bash') && !names(r).includes('bash'), JSON.stringify(r));

r = policy([], ['read_file', 'write_file', 'bash']);
check("the switches turn on the CLI's own tools (CLI 1.0.97 names)",
  ['view', 'create', 'edit', 'powershell', 'read_powershell'].every((n) => r.allow.includes(n)) && !names(r).includes('view'), JSON.stringify(r.allow));
check('none of them is on by default', !['view', 'create', 'edit', 'powershell'].some((n) => policy().allow.includes(n)));

r = policy(['click_index']);
check('a disabled browser tool leaves both the definitions and the allowlist', !names(r).includes('click_index') && !r.allow.includes('click_index'));

r = policy(['run_script'], ['run_script']);
check('disabling wins over enabling', !r.allow.includes('run_script'));

r = policy([], ['evaluate_js_on_host', 'powershell', 'click_index']);
check('names outside the opt-in set are ignored', !r.allow.includes('evaluate_js_on_host') && !r.allow.includes('powershell'), JSON.stringify(r.allow));
check('run_script is an opt-in name', OPT_IN_TOOLS.has('run_script'));

if (failures.length) {
  console.error(`tool-policy: ${failures.length} failure(s)\n  ` + failures.join('\n  '));
  process.exit(1);
}
console.log('tool-policy: all checks passed');
