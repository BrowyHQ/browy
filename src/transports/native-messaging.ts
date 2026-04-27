// Native Messaging Transport — stdio framed for Chrome/Edge/Brave.
//
// Chrome's native messaging protocol:
//   - Each message is prefixed by a uint32 little-endian length, then the
//     UTF-8 JSON body.
//   - Max message size is 1 MB outbound, ~64 KB inbound (per Chrome docs;
//     we don't enforce since the host trusts the browser).
//   - On stdin EOF the host MUST exit (Chrome killed our extension or
//     disabled the connection).
//
// We expose the same `Transport` interface the WS adapter uses, so the
// Runner has zero knowledge of which medium it's talking through.

import type { Transport, ClientMessage, ServerMessage } from '../protocol.js';

const HEADER_BYTES = 4;

export class NativeMessagingTransport implements Transport {
  readonly id = 'native-host';

  private msgHandlers: Array<(m: ClientMessage) => void> = [];
  private closeHandlers: Array<() => void> = [];

  /** Inbound chunked-read buffer. Stdin can split a single message across
   *  multiple 'data' events; we accumulate then drain frames. */
  private buf: Buffer = Buffer.alloc(0);
  private closed = false;

  constructor(
    private stdin: NodeJS.ReadStream = process.stdin,
    private stdout: NodeJS.WriteStream = process.stdout,
  ) {
    this.stdin.on('data', (chunk: Buffer) => this.onChunk(chunk));
    this.stdin.on('end', () => this.shutdown('stdin end'));
    this.stdin.on('close', () => this.shutdown('stdin close'));
    this.stdin.on('error', () => this.shutdown('stdin error'));
    this.stdout.on('error', () => this.shutdown('stdout error'));
  }

  send(msg: ServerMessage): void {
    if (this.closed) return;
    const json = Buffer.from(JSON.stringify(msg), 'utf8');
    const header = Buffer.alloc(HEADER_BYTES);
    header.writeUInt32LE(json.length, 0);
    try {
      this.stdout.write(header);
      this.stdout.write(json);
    } catch {
      this.shutdown('write failure');
    }
  }

  onMessage(cb: (msg: ClientMessage) => void): void {
    this.msgHandlers.push(cb);
  }

  onClose(cb: () => void): void {
    this.closeHandlers.push(cb);
  }

  close(): void {
    this.shutdown('close()');
  }

  // ── Frame parser ────────────────────────────────────────────────────────

  private onChunk(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.tryDrainOne()) {
      /* loop until no more complete frames */
    }
  }

  private tryDrainOne(): boolean {
    if (this.buf.length < HEADER_BYTES) return false;
    const len = this.buf.readUInt32LE(0);
    if (this.buf.length < HEADER_BYTES + len) return false;
    const body = this.buf.subarray(HEADER_BYTES, HEADER_BYTES + len);
    this.buf = this.buf.subarray(HEADER_BYTES + len);
    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(body.toString('utf8')) as ClientMessage;
    } catch {
      return true;
    }
    for (const cb of this.msgHandlers) {
      try { cb(parsed); } catch { /* handler errors don't kill the host */ }
    }
    return true;
  }

  private shutdown(_reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeHandlers) {
      try { cb(); } catch {}
    }
  }
}
