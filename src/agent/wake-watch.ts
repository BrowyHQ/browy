// Notices that the computer slept (or the process was frozen): a timer that
// should run every few seconds finds that far more wall-clock time has passed.
//
// Timers that act on a long wait (the tool deadline, the watchdog) call
// check() first. Coming out of a sleep they are all overdue at once, and
// whichever runs first must report the sleep rather than act on a "timeout"
// that was really the lid being closed.

export class WakeWatch {
  private last: number;
  private timer: NodeJS.Timeout | null = null;
  private handlers: Array<(gapMs: number) => void> = [];

  constructor(
    private everyMs = 5_000,
    private gapMs = 30_000,
    private now: () => number = Date.now,
  ) {
    this.last = this.now();
  }

  /** Start the timer. It never keeps the process alive on its own. */
  start(): this {
    if (this.timer) return this;
    this.last = this.now();
    this.timer = setInterval(() => this.check(), this.everyMs);
    this.timer.unref?.();
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onWake(cb: (gapMs: number) => void): void {
    this.handlers.push(cb);
  }

  /** True, after telling every handler, when this call ends a sleep. */
  check(): boolean {
    const now = this.now();
    const gap = now - this.last;
    this.last = now;
    if (gap <= this.gapMs) return false;
    for (const cb of this.handlers) {
      try { cb(gap); } catch { /* one handler must not stop the others */ }
    }
    return true;
  }
}
