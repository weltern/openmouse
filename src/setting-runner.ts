/**
 * Decides *when* a settings write runs — waits out a background poll, holds a
 * click made while another write is in flight, and drops what is queued when
 * the device goes away.
 *
 * It lives apart from the panel because every user-visible bug this app has
 * shipped in that area was a scheduling bug rather than a rendering one:
 * controls left disabled after a write that had worked, clicks swallowed by a
 * refresh guard, clicks swallowed by a write guard. All four were invisible to
 * a green test suite because the suite could not reach a state machine tangled
 * up with the DOM. Nothing here touches the DOM, so all of it is testable.
 *
 * Everything the outside world provides — the clock, sleeping, the connection
 * and busy flags — arrives through ports, so a test can drive time by hand
 * instead of waiting on it.
 */

export interface SettingRunnerPorts {
  /** False once the device is gone; a queued click must never outlive it. */
  isConnected(): boolean;
  /** True while a background status poll holds the radio. */
  isRefreshing(): boolean;
  isWriting(): boolean;
  setWriting(value: boolean): void;
  /** Shows a message to the user. */
  status(message: string): void;
  sleep(milliseconds: number): Promise<void>;
  now(): number;
}

const POLL_WAIT_TIMEOUT_MS = 4000;
const POLL_WAIT_STEP_MS = 60;

export const BUSY_MESSAGE = "The mouse is busy; try again in a moment.";

export class SettingRunner {
  /**
   * Only the most recent click is held. Clicking Subtle, then High, then
   * Subtle should end on Subtle — replaying the middle choice would be both
   * slower and wrong.
   */
  private queued: { label: string; write: () => Promise<unknown> } | null = null;

  /**
   * Assigned in the body rather than declared as a parameter property: Node's
   * strip-only TypeScript mode rejects those outright, which is what kept the
   * HID clients untestable until they were rewritten the same way.
   */
  private readonly ports: SettingRunnerPorts;

  constructor(ports: SettingRunnerPorts) {
    this.ports = ports;
  }

  /** Drops anything held. Called when the device disconnects. */
  clear(): void {
    this.queued = null;
  }

  get hasQueuedWork(): boolean {
    return this.queued !== null;
  }

  /**
   * Waits for a background poll to finish rather than dropping the click. The
   * poll runs every five seconds and takes real time over the air, so a plain
   * `if (refreshing) return` silently swallows a few percent of presses — often
   * enough to read as "I must have missed the button" rather than as a bug.
   */
  async waitForIdle(timeoutMs = POLL_WAIT_TIMEOUT_MS): Promise<boolean> {
    const deadline = this.ports.now() + timeoutMs;
    while (this.ports.isRefreshing() && this.ports.now() < deadline) {
      await this.ports.sleep(POLL_WAIT_STEP_MS);
    }
    return !this.ports.isRefreshing();
  }

  async run(label: string, write: () => Promise<unknown>): Promise<void> {
    if (!this.ports.isConnected()) return;

    if (this.ports.isWriting()) {
      this.queued = { label, write };
      this.ports.status(`${label}…`);
      return;
    }

    if (!await this.waitForIdle()) {
      this.ports.status(BUSY_MESSAGE);
      return;
    }

    // Awaiting yields to other handlers, so both of these may have changed.
    if (!this.ports.isConnected()) return;
    if (this.ports.isWriting()) {
      this.queued = { label, write };
      return;
    }

    this.ports.setWriting(true);
    this.ports.status(`${label}…`);
    try {
      await write();
    } catch (error) {
      this.ports.status(
        error instanceof Error ? error.message : `Unable to apply ${label.toLowerCase()}.`,
      );
    } finally {
      // Releasing the flag before draining the queue is what lets the held
      // click run at all; leaving it set would deadlock on the guard above.
      this.ports.setWriting(false);
      const next = this.queued;
      this.queued = null;
      if (next && this.ports.isConnected()) await this.run(next.label, next.write);
    }
  }
}
