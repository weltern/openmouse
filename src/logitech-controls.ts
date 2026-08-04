/**
 * Vocabulary and pure helpers for HID++ feature 0x1B04 (REPROG CONTROLS V4).
 *
 * Kept free of WebHID so it can be unit-tested directly, and shared with the
 * dev probe so the two cannot drift apart. Names follow Solaar's special_keys
 * tables; every id here was observed on real hardware or taken from that list.
 */

/** Control ids — the physical (or virtual) buttons a device exposes. */
export const CONTROL_NAMES: Readonly<Record<number, string>> = {
  0x0050: "Left click",
  0x0051: "Right click",
  0x0052: "Middle click",
  0x0053: "Back",
  0x0054: "Back (alt)",
  0x0056: "Forward",
  0x0057: "Forward (as HID)",
  0x0059: "Button 6",
  0x005a: "Button 7",
  0x005b: "Button 8",
  0x005c: "Button 9",
  0x005d: "Button 10",
  0x005e: "Button 11",
  0x00c3: "Gesture button",
  0x00c4: "SmartShift button",
  0x00d7: "Virtual gesture button",
  0x00dc: "Back (long press)",
  0x00e0: "Mission Control / Task View",
  0x00e1: "Dashboard / Action Center",
  0x00e2: "Backlight down",
  0x00e3: "Backlight up",
  0x00e4: "Previous track",
  0x00e5: "Play / pause",
  0x00e6: "Next track",
  0x00e7: "Mute",
  0x00e8: "Volume down",
  0x00e9: "Volume up",
  /** The MX Master 4's Actions Ring, paired with the 0x19B0 HAPTIC feature. */
  0x01a0: "Actions Ring",
};

/** Native task each control performs when it is not remapped or diverted. */
export const TASK_NAMES: Readonly<Record<number, string>> = {
  0x0038: "Left click",
  0x0039: "Right click",
  0x003a: "Middle click",
  0x003c: "Back",
  0x003e: "Forward",
  0x009c: "Gesture button",
  0x009d: "SmartShift",
  0x00b4: "Virtual gesture button",
  0x0109: "App switch / Launchpad",
};

/**
 * Bits of the first flags byte of getControlIdInfo. Confirmed against an
 * MX Master 4: left click reported 0x01 (a plain mouse button, not
 * reprogrammable), the gesture button 0x31, and the virtual gesture button
 * 0xA0 (virtual and divertable but not a physical key).
 */
export const KEY_FLAG = {
  mouseButton: 0x01,
  fkey: 0x02,
  hotkey: 0x04,
  fnToggle: 0x08,
  reprogrammable: 0x10,
  divertable: 0x20,
  persistentlyDivertable: 0x40,
  virtual: 0x80,
} as const;

/** Bits of the mapping flags from getControlIdReporting. */
export const MAPPING_FLAG = {
  diverted: 0x0001,
  persistentlyDiverted: 0x0004,
  rawXy: 0x0010,
  forceRawXy: 0x0040,
  analyticsKeyEvents: 0x0100,
  rawWheel: 0x0400,
} as const;

export interface ControlInfo {
  controlId: number;
  taskId: number;
  flags: number;
  /** Group this control belongs to, as a remap target. */
  group: number;
  /** Bitmask of groups this control may be remapped into. */
  groupMask: number;
}

export interface ReprogrammableControl extends ControlInfo {
  name: string;
  taskName: string;
  reprogrammable: boolean;
  /** Control id this button currently acts as. */
  mappedTo: number;
  /** Another application is consuming this button's events. */
  diverted: boolean;
  /** Control ids this button may legally be remapped to. */
  remappableTo: number[];
}

export const controlName = (controlId: number): string =>
  CONTROL_NAMES[controlId] ?? `Control 0x${controlId.toString(16).padStart(4, "0").toUpperCase()}`;

export const taskName = (taskId: number): string =>
  TASK_NAMES[taskId] ?? `Task 0x${taskId.toString(16).padStart(4, "0").toUpperCase()}`;

/** Parses the nine-byte payload of getControlIdInfo (function 0x10). */
export function parseControlInfo(payload: readonly number[] | Uint8Array): ControlInfo {
  const at = (index: number): number => payload[index] ?? 0;
  return {
    controlId: (at(0) << 8) | at(1),
    taskId: (at(2) << 8) | at(3),
    flags: at(4),
    group: at(6),
    groupMask: at(7),
  };
}

/**
 * Which controls a given control may be remapped to. The device decides: its
 * group mask names the groups it accepts, and only controls in those groups
 * are legal targets. Left and right click report a mask of zero, which is the
 * firmware — not this code — refusing to let the primary buttons be moved.
 */
export function remappableTargets(control: ControlInfo, all: readonly ControlInfo[]): number[] {
  if (!control.groupMask) return [];
  return all
    .filter((candidate) => candidate.group > 0 && (control.groupMask & (1 << (candidate.group - 1))) !== 0)
    .map((candidate) => candidate.controlId);
}

/**
 * Builds the setControlIdReporting payload (function 0x30) for a pure remap.
 *
 * Each mapping flag occupies two bits: the value and a companion "valid" bit
 * one position higher, and the device ignores any flag whose valid bit is
 * clear. Sending zero therefore changes no flags at all — which is what we
 * want, because turning diversion on would route the button to HID++
 * notifications that nothing in this app consumes, leaving it dead.
 */
export function buildRemapPayload(controlId: number, targetControlId: number): number[] {
  return [controlId >> 8, controlId & 0xff, 0x00, targetControlId >> 8, targetControlId & 0xff];
}

/**
 * Builds the payload that hands a button back to the hardware.
 *
 * A diverted button emits HID++ notifications instead of acting, which is how
 * a vendor application implements its own behaviours. If that application
 * stops, the diversion stays in the device and the button does nothing at all.
 * Clearing it restores the button's native or remapped action.
 *
 * Only the "valid" bits are set, with both value bits left clear, so this can
 * only ever turn diversion off. There is deliberately no way to turn it on:
 * nothing in this app consumes those notifications.
 */
export function buildDiversionClearPayload(controlId: number): number[] {
  const clearDiverted = MAPPING_FLAG.diverted << 1;
  const clearPersistent = MAPPING_FLAG.persistentlyDiverted << 1;
  // A remap target of zero leaves the existing mapping untouched.
  return [controlId >> 8, controlId & 0xff, clearDiverted | clearPersistent, 0x00, 0x00];
}
