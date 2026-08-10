import assert from "node:assert/strict";
import test from "node:test";

import { BUSY_MESSAGE, SettingRunner, type SettingRunnerPorts } from "./setting-runner.ts";

/**
 * Drives the clock by hand. Sleeping advances time instantly, so a four-second
 * timeout costs a test nothing and never depends on how fast the machine is.
 */
function createHarness(options: { connected?: boolean } = {}) {
  const state = {
    connected: options.connected ?? true,
    refreshing: false,
    writing: false,
    clock: 0,
    messages: [] as string[],
    ran: [] as string[],
  };

  const ports: SettingRunnerPorts = {
    isConnected: () => state.connected,
    isRefreshing: () => state.refreshing,
    isWriting: () => state.writing,
    setWriting: (value) => { state.writing = value; },
    status: (message) => { state.messages.push(message); },
    sleep: async (milliseconds) => { state.clock += milliseconds; },
    now: () => state.clock,
  };

  return { state, ports, runner: new SettingRunner(ports) };
}

/** A write that records it ran and resolves only when released. */
function deferredWrite(state: { ran: string[] }, label: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return {
    release,
    write: async () => {
      state.ran.push(label);
      await gate;
    },
  };
}

test("a write runs immediately when nothing else is happening", async () => {
  const { state, runner } = createHarness();
  await runner.run("Setting strength", async () => { state.ran.push("a"); });
  assert.deepEqual(state.ran, ["a"]);
  assert.equal(state.writing, false, "the writing flag was left set");
});

test("a click during a background poll waits for it instead of vanishing", async () => {
  const { state, runner } = createHarness();
  state.refreshing = true;

  const pending = runner.run("Setting strength", async () => { state.ran.push("a"); });
  // Still nothing, because the poll holds the radio.
  await Promise.resolve();
  assert.deepEqual(state.ran, []);

  state.refreshing = false;
  await pending;
  assert.deepEqual(state.ran, ["a"], "the click was dropped rather than waited out");
});

test("a poll that never ends reports busy rather than hanging or dropping silently", async () => {
  const { state, runner } = createHarness();
  state.refreshing = true;

  await runner.run("Setting strength", async () => { state.ran.push("a"); });

  assert.deepEqual(state.ran, []);
  assert.ok(state.messages.includes(BUSY_MESSAGE), "a swallowed click said nothing about why");
  assert.ok(state.clock >= 4000, "the wait gave up before its timeout");
});

test("a click during a write is queued and runs afterwards", async () => {
  const { state, runner } = createHarness();
  const first = deferredWrite(state, "first");

  const running = runner.run("First", first.write);
  await Promise.resolve();
  assert.deepEqual(state.ran, ["first"]);

  // This is the press that used to disappear with no error at all.
  await runner.run("Second", async () => { state.ran.push("second"); });
  assert.deepEqual(state.ran, ["first"], "the second write jumped the queue");
  assert.ok(runner.hasQueuedWork);

  first.release();
  await running;
  assert.deepEqual(state.ran, ["first", "second"], "the queued click never ran");
  assert.equal(runner.hasQueuedWork, false);
});

test("only the last click made during a write survives", async () => {
  const { state, runner } = createHarness();
  const first = deferredWrite(state, "subtle");

  const running = runner.run("Subtle", first.write);
  await Promise.resolve();

  await runner.run("High", async () => { state.ran.push("high"); });
  await runner.run("Subtle again", async () => { state.ran.push("subtle-again"); });

  first.release();
  await running;

  // Replaying every press would be slower and would land on the wrong value.
  assert.deepEqual(state.ran, ["subtle", "subtle-again"]);
});

test("a queued click is dropped when the device goes away", async () => {
  const { state, runner } = createHarness();
  const first = deferredWrite(state, "first");

  const running = runner.run("First", first.write);
  await Promise.resolve();
  await runner.run("Second", async () => { state.ran.push("second"); });

  // Switching hosts disconnects on purpose, so this is a real path.
  state.connected = false;
  runner.clear();

  first.release();
  await running;
  assert.deepEqual(state.ran, ["first"], "a held click fired at a device that had gone");
});

test("a write that throws neither wedges the runner nor loses the queued click", async () => {
  const { state, runner } = createHarness();

  await runner.run("Failing", async () => { throw new Error("The mouse said no."); });
  assert.equal(state.writing, false, "a thrown write left the runner stuck busy forever");
  assert.ok(state.messages.includes("The mouse said no."));

  // And the runner still works afterwards.
  await runner.run("Next", async () => { state.ran.push("next"); });
  assert.deepEqual(state.ran, ["next"]);
});

test("a click queued behind a write that throws still runs", async () => {
  const { state, runner } = createHarness();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  const running = runner.run("Failing", async () => {
    state.ran.push("failing");
    await gate;
    throw new Error("The mouse said no.");
  });
  await Promise.resolve();
  await runner.run("Queued", async () => { state.ran.push("queued"); });

  release();
  await running;
  assert.deepEqual(state.ran, ["failing", "queued"], "a failure swallowed the queued click");
});

test("nothing runs at all while disconnected", async () => {
  const { state, runner } = createHarness({ connected: false });
  await runner.run("Setting strength", async () => { state.ran.push("a"); });
  assert.deepEqual(state.ran, []);
  assert.equal(state.writing, false);
});
