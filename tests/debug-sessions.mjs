// Debug: dump all session metadata to see how BrowserAgent's sessions are tagged.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { CopilotClient } = require('@github/copilot-sdk');

const c = new CopilotClient();
await c.start();
const all = await c.listSessions();
console.log(`Total sessions on disk: ${all.length}`);
for (const s of all.slice(0, 10)) {
  console.log({
    sessionId: s.sessionId,
    clientName: s.clientName,
    cwd: s.context?.cwd,
    branch: s.context?.branch,
    repository: s.context?.repository,
    startTime: s.startTime,
  });
}
await c.stop();
