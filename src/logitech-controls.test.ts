import assert from "node:assert/strict";
import test from "node:test";

import {
  KEY_FLAG,
  MAPPING_FLAG,
  buildDiversionClearPayload,
  buildRemapPayload,
  controlName,
  parseControlInfo,
  remappableTargets,
} from "./logitech-controls.ts";

/**
 * Real getControlIdInfo payloads captured from an MX Master 4 over a Logi Bolt
 * receiver, so these tests fail if the parsing drifts from actual hardware.
 */
const MX_MASTER_4_CONTROLS = [
  [0x00, 0x50, 0x00, 0x38, 0x01, 0x00, 0x01, 0x00, 0x04], // Left click
  [0x00, 0x51, 0x00, 0x39, 0x01, 0x00, 0x01, 0x00, 0x04], // Right click
  [0x00, 0x52, 0x00, 0x3a, 0x31, 0x00, 0x02, 0x03, 0x05], // Middle click
  [0x00, 0x53, 0x00, 0x3c, 0x31, 0x00, 0x02, 0x03, 0x05], // Back
  [0x00, 0x56, 0x00, 0x3e, 0x31, 0x00, 0x02, 0x03, 0x05], // Forward
  [0x00, 0xc3, 0x00, 0x9c, 0x31, 0x00, 0x02, 0x03, 0x05], // Gesture button
  [0x00, 0xc4, 0x00, 0x9d, 0x31, 0x00, 0x02, 0x03, 0x05], // SmartShift button
  [0x01, 0xa0, 0x01, 0x09, 0x31, 0x00, 0x02, 0x03, 0x05], // Actions Ring
  [0x00, 0xd7, 0x00, 0xb4, 0xa0, 0x00, 0x03, 0x00, 0x03], // Virtual gesture button
].map(parseControlInfo);

const byId = (controlId: number) => MX_MASTER_4_CONTROLS.find((control) => control.controlId === controlId)!;

test("control info is parsed from the wire layout", () => {
  const back = byId(0x0053);
  assert.equal(back.taskId, 0x003c);
  assert.equal(back.group, 2);
  assert.equal(back.groupMask, 0b011);

  const actionsRing = byId(0x01a0);
  assert.equal(actionsRing.taskId, 0x0109);
  assert.equal(controlName(actionsRing.controlId), "Actions Ring");
});

test("the primary buttons report themselves as not reprogrammable", () => {
  for (const controlId of [0x0050, 0x0051]) {
    const control = byId(controlId);
    // The exact byte, not just the absence of one bit: a flags field read from
    // the wrong offset also lacks the reprogrammable bit, so a bitmask check
    // alone passes against broken parsing.
    assert.equal(control.flags, KEY_FLAG.mouseButton, "primary buttons report flags 0x01");
    assert.equal(control.flags & KEY_FLAG.reprogrammable, 0);
    assert.equal(control.groupMask, 0);
    assert.deepEqual(
      remappableTargets(control, MX_MASTER_4_CONTROLS),
      [],
      "the firmware offers no targets for a primary button, so neither may we",
    );
  }
});

test("a virtual control is not offered as a remap target", () => {
  const virtual = byId(0x00d7);
  assert.notEqual(virtual.flags & KEY_FLAG.virtual, 0);
  // It sits in group 3, and no control's mask includes group 3.
  for (const control of MX_MASTER_4_CONTROLS) {
    assert.ok(
      !remappableTargets(control, MX_MASTER_4_CONTROLS).includes(0x00d7),
      `${controlName(control.controlId)} offered the virtual gesture button as a target`,
    );
  }
});

test("remap targets come from the device's group mask", () => {
  const targets = remappableTargets(byId(0x00c3), MX_MASTER_4_CONTROLS);
  assert.deepEqual(targets, [0x0050, 0x0051, 0x0052, 0x0053, 0x0056, 0x00c3, 0x00c4, 0x01a0]);
  assert.ok(targets.includes(0x00c3), "a control must be able to return to its own default");
});

test("a remap payload changes the mapping and no flags", () => {
  const payload = buildRemapPayload(0x00c3, 0x0052);
  assert.deepEqual(payload, [0x00, 0xc3, 0x00, 0x00, 0x52]);
  // Every mapping flag needs a companion "valid" bit one position higher, so a
  // zero flags byte marks nothing valid and leaves diversion exactly as it was.
  assert.equal(payload[2], 0x00, "a non-zero flags byte would rewrite diversion state");
});

test("a diversion-clear payload can only ever turn diversion off", () => {
  const payload = buildDiversionClearPayload(0x0053);
  assert.deepEqual(payload, [0x00, 0x53, 0x0a, 0x00, 0x00]);

  const flags = payload[2];
  // Valid bits set for diverted (0x02) and persistently diverted (0x08)...
  assert.equal(flags & 0x02, 0x02);
  assert.equal(flags & 0x08, 0x08);
  // ...with both value bits clear, so the flags can only be turned off.
  assert.equal(flags & MAPPING_FLAG.diverted, 0, "the payload would switch diversion on");
  assert.equal(flags & MAPPING_FLAG.persistentlyDiverted, 0, "the payload would switch persistent diversion on");
  // A zero remap target leaves the button pointing where it already did.
  assert.deepEqual(payload.slice(3), [0x00, 0x00]);
});

test("control and task ids fall back to a readable hex label", () => {
  assert.equal(controlName(0x0abc), "Control 0x0ABC");
});
