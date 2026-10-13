// The last few tool calls of each chat, shown back to the model as
// <recent_actions> on that chat's next turn, so it can see whether its last
// click or fill worked (browser-use, ReAct and SeeAct do the same).
//
// Kept per chat because one Agent serves every chat in the host. Until 0.1.9
// it was a single buffer: a new chat's first prompt carried the previous
// chat's calls, and asked to fill a form it had just filled in another chat,
// the model replied that the form was filled without calling a tool.

export interface RecentAction {
  name: string;
  args: string;
  result: string;
  ok: boolean;
  ms: number;
}

export class RecentActions {
  private readonly byChat = new Map<string, RecentAction[]>();
  private readonly limit: number;

  constructor(limit = 5) {
    this.limit = limit;
  }

  record(chat: string, action: RecentAction): void {
    const list = this.byChat.get(chat) || [];
    list.push(action);
    if (list.length > this.limit) list.splice(0, list.length - this.limit);
    this.byChat.set(chat, list);
  }

  clear(chat: string): void {
    this.byChat.delete(chat);
  }

  serialize(chat: string): string {
    const list = this.byChat.get(chat) || [];
    if (!list.length) return '';
    const lines = list.map((a) => `- ${a.name}(${a.args}) → ${a.ok ? 'ok' : 'err'} ${a.ms}ms${a.result ? ': ' + a.result : ''}`);
    return `<recent_actions>\n${lines.join('\n')}\n</recent_actions>\n`;
  }
}
