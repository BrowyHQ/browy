// Which tools a chat's session may use.
//
// Browy's browser tools act on the tab and are on unless the user switches one
// off in Settings. Tools that act on the user's machine instead are off until
// the user switches each one on: the Copilot CLI's own (bash, read_file and the
// rest) and Browy's run_script, which runs Node.js with the user's privileges.
// Any page Browy reads can carry text aimed at the model, so nothing a page
// could talk the agent into should reach the machine by default. Until 0.1.10
// run_script was missed here and was on by default.

/** Copilot SDK tools the user can opt into. The SDK implements them; the host
 *  only stops suppressing them from the session's allowlist. */
export const SDK_OPT_IN_TOOLS: ReadonlySet<string> = new Set([
  'read_file', 'write_file', 'bash', 'grep', 'glob', 'web_fetch',
]);

/** Browy's own tools that reach the machine, so they're opt-in too. */
export const BROWY_OPT_IN_TOOLS: ReadonlySet<string> = new Set(['run_script']);

/** Every name the extension may switch on. Anything else is ignored, so a
 *  compromised extension can't quietly enable arbitrary capabilities. */
export const OPT_IN_TOOLS: ReadonlySet<string> = new Set([...SDK_OPT_IN_TOOLS, ...BROWY_OPT_IN_TOOLS]);

/**
 * The tool definitions to hand the SDK and its strict `availableTools`
 * allowlist. A tool the user disabled is dropped from both, so the model never
 * learns it exists; disabling wins over enabling.
 */
export function toolPolicy<T extends { name: string }>(
  tools: readonly T[],
  disabled: ReadonlySet<string>,
  enabled: ReadonlySet<string>,
): { tools: T[]; allow: string[] } {
  const optedIn = (name: string) => OPT_IN_TOOLS.has(name) && enabled.has(name) && !disabled.has(name);
  const kept = tools.filter((t) => !disabled.has(t.name) && (!BROWY_OPT_IN_TOOLS.has(t.name) || optedIn(t.name)));
  const allow = kept.map((t) => t.name);
  for (const name of SDK_OPT_IN_TOOLS) {
    if (optedIn(name) && !allow.includes(name)) allow.push(name);
  }
  return { tools: kept, allow };
}
