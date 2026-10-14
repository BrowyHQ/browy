// One assistant turn's visible text, rebuilt from Copilot SDK events.
//
// A turn can hold several assistant messages: the model says something, calls
// tools, then says more. The SDK reports each message under its own messageId,
// as `assistant.message_delta` chunks while it streams and then one
// `assistant.message` with the whole content. Until 0.1.11 Browy kept a single
// running string per turn and compared every message against it, so a later
// message was dropped when it was shorter than everything said before it, and
// cut mid-word when it was longer.

export class TurnText {
  private parts: string[] = [];
  private byId = new Map<string, number>();

  private slot(messageId: string): number {
    let i = this.byId.get(messageId);
    if (i === undefined) {
      i = this.parts.push('') - 1;
      this.byId.set(messageId, i);
    }
    return i;
  }

  /** A streamed chunk. Returns the text to show now. */
  delta(messageId: string, chunk: string): string {
    if (!chunk) return '';
    const i = this.slot(messageId);
    this.parts[i] += chunk;
    return chunk;
  }

  /** A finished message. Returns the part of it that has not been shown yet. */
  message(messageId: string, content: string): string {
    if (!content) return '';
    const i = this.slot(messageId);
    const shown = this.parts[i];
    this.parts[i] = content;
    if (!shown) return content;
    return content.startsWith(shown) ? content.slice(shown.length) : '';
  }

  /** Everything said in the turn so far, one paragraph per message. */
  get text(): string {
    return this.parts.filter((p) => p.trim()).join('\n\n');
  }
}
