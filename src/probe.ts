/**
 * Dev-only HID++ discovery tool. Not part of the production build — `probe.html`
 * is served by `vite dev` but is absent from `build.rollupOptions.input`.
 *
 * It answers the questions a new Logitech driver has to be written against:
 * which device indices are alive behind a receiver, what each one calls itself,
 * and exactly which HID++ features it exposes. Every request is a read.
 */

const SHORT_REPORT_ID = 0x10;
const LONG_REPORT_ID = 0x11;
const ROOT_FEATURE_INDEX = 0x00;
/** HID++ replies echo the software id, which keeps responses distinct from notifications. */
const SOFTWARE_ID = 0x01;

const ERROR_HIDPP10 = 0x8f;
const ERROR_HIDPP20 = 0xff;

/** Receivers address paired devices as 1..6; a directly attached device answers on 0xff. */
const DEVICE_INDICES = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0xff] as const;

const FEATURE_NAMES: Record<number, string> = {
  0x0000: "ROOT",
  0x0001: "FEATURE SET",
  0x0002: "FEATURE INFO",
  0x0003: "DEVICE FW VERSION",
  0x0005: "DEVICE NAME",
  0x0007: "DEVICE FRIENDLY NAME",
  0x0008: "KEEP ALIVE",
  0x0011: "PROPERTY ACCESS",
  0x0020: "CONFIG CHANGE",
  0x0021: "UNIQUE IDENTIFIER",
  0x00c2: "DFU CONTROL",
  0x1000: "BATTERY STATUS",
  0x1001: "BATTERY VOLTAGE",
  0x1004: "UNIFIED BATTERY",
  0x1500: "FORCE PAIRING",
  0x1800: "GENERIC TEST",
  0x1802: "DEVICE RESET",
  0x1814: "CHANGE HOST",
  0x1815: "HOSTS INFO",
  0x1830: "LOW POWER MODE",
  0x1861: "BATTERY VOLTAGE (EXT)",
  0x19b0: "HAPTIC",
  0x19c0: "FORCE SENSING BUTTON",
  0x1b04: "REPROG CONTROLS V4",
  0x1d4b: "WIRELESS DEVICE STATUS",
  0x1df3: "EQUAD DJ DEVICE PAIRING",
  0x1e00: "ENABLE HIDDEN FEATURES",
  0x1e22: "SPI DIRECT ACCESS",
  0x1f20: "ADC MEASUREMENT",
  0x2100: "VERTICAL SCROLLING",
  0x2110: "SMART SHIFT",
  0x2111: "SMART SHIFT ENHANCED",
  0x2120: "HI RES SCROLLING",
  0x2121: "HIRES WHEEL",
  0x2130: "RATCHET WHEEL",
  0x2150: "THUMB WHEEL",
  0x2201: "ADJUSTABLE DPI",
  0x2202: "EXTENDED ADJUSTABLE DPI",
  0x2205: "POINTER MOTION SCALING",
  0x2250: "ANALYSIS MODE",
  0x2251: "WHEEL STATS",
  0x2400: "HYBRID TRACKING",
  0x40a3: "FN INVERSION",
  0x4523: "DISABLE KEYS BY USAGE",
  0x6501: "GESTURE",
  0x8060: "REPORT RATE",
  0x8061: "EXTENDED REPORT RATE",
  0x8070: "COLOR LED EFFECTS",
  0x8100: "ONBOARD PROFILES",
  0x8110: "MOUSE BUTTON SPY",
};

/** HID++ 2.0 error codes, so a rejection says why instead of just failing. */
const ERROR_NAMES: Record<number, string> = {
  0x00: "no error",
  0x01: "unknown",
  0x02: "invalid argument",
  0x03: "out of range",
  0x04: "hardware error",
  0x05: "logitech internal",
  0x06: "invalid feature index",
  0x07: "invalid function id",
  0x08: "busy",
  0x09: "unsupported",
};

const logElement = document.querySelector<HTMLPreElement>("#log")!;
let logText = "";

function log(line = ""): void {
  logText += `${line}\n`;
  logElement.textContent = logText;
  logElement.scrollTop = logElement.scrollHeight;
}

function resetLog(): void {
  logText = "";
  logElement.textContent = "";
}

const hex = (value: number, digits = 2): string => value.toString(16).padStart(digits, "0").toUpperCase();
const hexBytes = (bytes: Uint8Array): string => [...bytes].map((byte) => hex(byte)).join(" ");

class HidppError extends Error {
  constructor(readonly code: number, readonly kind: "hidpp10" | "hidpp20") {
    super(`HID++ error 0x${hex(code)}${ERROR_NAMES[code] ? ` (${ERROR_NAMES[code]})` : ""}`);
  }
}

/** Minimal request/response transceiver — one in-flight request at a time. */
class Transceiver {
  private pending: {
    deviceIndex: number;
    featureIndex: number;
    functionByte: number;
    resolve: (report: Uint8Array) => void;
    reject: (reason: Error) => void;
  } | null = null;

  /**
   * Reports that answer nothing we asked for are device-initiated notifications.
   * Discarding them, as this used to, makes the whole class of event-reporting
   * features invisible — a feature that streams its data instead of answering a
   * getter would look simply absent. They are handed to onNotification instead.
   */
  onNotification: ((report: Uint8Array) => void) | null = null;

  private readonly onInputReport = (event: HIDInputReportEvent): void => {
    if (event.reportId !== SHORT_REPORT_ID && event.reportId !== LONG_REPORT_ID) return;

    const report = new Uint8Array(
      event.data.buffer.slice(event.data.byteOffset, event.data.byteOffset + event.data.byteLength),
    );
    const request = this.pending;

    if (request && report[0] === request.deviceIndex) {
      if (report[1] === ERROR_HIDPP20 && report[2] === request.featureIndex && report[3] === request.functionByte) {
        this.settle().reject(new HidppError(report[4] ?? 0, "hidpp20"));
        return;
      }
      // HID++ 1.0 errors carry the offending sub-id in byte 2 rather than a feature index.
      if (report[1] === ERROR_HIDPP10) {
        this.settle().reject(new HidppError(report[4] ?? 0, "hidpp10"));
        return;
      }
      if (report[1] === request.featureIndex && report[2] === request.functionByte) {
        this.settle().resolve(report);
        return;
      }
    }

    this.onNotification?.(report);
  };

  constructor(readonly device: HIDDevice) {}

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
    this.device.addEventListener("inputreport", this.onInputReport);
  }

  async close(): Promise<void> {
    this.device.removeEventListener("inputreport", this.onInputReport);
    if (this.device.opened) await this.device.close();
  }

  async request(
    deviceIndex: number,
    featureIndex: number,
    functionId: number,
    parameters: number[] = [],
    timeoutMs = 2000,
  ): Promise<Uint8Array> {
    if (this.pending) throw new Error("A HID++ request is already in flight.");
    const functionByte = (functionId << 4) | SOFTWARE_ID;

    const long = parameters.length > 3;
    const payload = new Uint8Array(long ? 19 : 6);
    payload[0] = deviceIndex;
    payload[1] = featureIndex;
    payload[2] = functionByte;
    payload.set(parameters, 3);

    const response = new Promise<Uint8Array>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending = null;
        reject(new Error("timeout"));
      }, timeoutMs);
      this.pending = {
        deviceIndex,
        featureIndex,
        functionByte,
        resolve: (report) => {
          window.clearTimeout(timeout);
          resolve(report);
        },
        reject: (reason) => {
          window.clearTimeout(timeout);
          reject(reason);
        },
      };
    });
    // Keep the rejection observed so a sendReport failure does not surface as
    // an unhandled promise rejection alongside the real error.
    void response.catch(() => undefined);

    try {
      await this.device.sendReport(long ? LONG_REPORT_ID : SHORT_REPORT_ID, payload);
    } catch (error) {
      this.pending = null;
      throw error;
    }
    return await response;
  }

  private settle(): NonNullable<Transceiver["pending"]> {
    const request = this.pending!;
    this.pending = null;
    return request;
  }
}

/** Root ping: confirms a device index is alive and reports its HID++ version. */
async function ping(bus: Transceiver, deviceIndex: number): Promise<{ major: number; minor: number }> {
  const reply = await bus.request(deviceIndex, ROOT_FEATURE_INDEX, 0x1, [0x00, 0x00, 0x5a], 1600);
  return { major: reply[3] ?? 0, minor: reply[4] ?? 0 };
}

async function getFeatureIndex(bus: Transceiver, deviceIndex: number, featureId: number): Promise<number> {
  const reply = await bus.request(deviceIndex, ROOT_FEATURE_INDEX, 0x0, [featureId >> 8, featureId & 0xff]);
  return reply[3] ?? 0;
}

/**
 * Feature index → feature id, the reverse of the root lookup. A notification
 * carries only the index, so without this map an event can only be identified
 * by guessing at the shape of its payload.
 */
async function readFeatureMap(bus: Transceiver, deviceIndex: number): Promise<Map<number, number>> {
  const map = new Map<number, number>([[0x00, 0x0000]]);
  const featureSetIndex = await getFeatureIndex(bus, deviceIndex, 0x0001);
  if (!featureSetIndex) return map;
  map.set(featureSetIndex, 0x0001);

  const count = (await bus.request(deviceIndex, featureSetIndex, 0x0))[3] ?? 0;
  for (let index = 1; index <= count; index += 1) {
    try {
      const reply = await bus.request(deviceIndex, featureSetIndex, 0x1, [index]);
      map.set(index, ((reply[3] ?? 0) << 8) | (reply[4] ?? 0));
    } catch {
      // A gap in the table is not worth abandoning the rest of it.
    }
  }
  return map;
}

async function readDeviceName(bus: Transceiver, deviceIndex: number): Promise<string> {
  const nameFeature = await getFeatureIndex(bus, deviceIndex, 0x0005);
  if (!nameFeature) return "(no 0x0005 DEVICE NAME feature)";

  const header = await bus.request(deviceIndex, nameFeature, 0x0);
  const length = header[3] ?? 0;
  const characters: number[] = [];
  // Long replies carry 16 payload bytes after the 3-byte HID++ header.
  for (let offset = 0; offset < length; offset += 16) {
    const chunk = await bus.request(deviceIndex, nameFeature, 0x1, [offset]);
    characters.push(...chunk.slice(3, 3 + Math.min(16, length - offset)));
  }
  return new TextDecoder().decode(new Uint8Array(characters)).replace(/\0/g, "").trim();
}

/** Walks 0x0001 FEATURE SET to list every feature the device implements. */
async function dumpFeatureTable(bus: Transceiver, deviceIndex: number): Promise<void> {
  const featureSetIndex = await getFeatureIndex(bus, deviceIndex, 0x0001);
  if (!featureSetIndex) {
    log("    no 0x0001 FEATURE SET feature — cannot enumerate.");
    return;
  }

  const countReply = await bus.request(deviceIndex, featureSetIndex, 0x0);
  const count = countReply[3] ?? 0;
  log(`    ${count} features (plus root):`);
  log("      idx  id      ver  type  name");

  for (let index = 1; index <= count; index += 1) {
    try {
      const reply = await bus.request(deviceIndex, featureSetIndex, 0x1, [index]);
      const featureId = ((reply[3] ?? 0) << 8) | (reply[4] ?? 0);
      const type = reply[5] ?? 0;
      const version = reply[6] ?? 0;
      const flags = [
        type & 0x80 ? "obsolete" : "",
        type & 0x40 ? "hidden" : "",
        type & 0x20 ? "engineering" : "",
      ].filter(Boolean).join(",") || "-";
      const name = FEATURE_NAMES[featureId] ?? "(unknown)";
      log(`      ${hex(index)}   0x${hex(featureId, 4)}  v${version}   ${flags.padEnd(11)} ${name}`);
    } catch (error) {
      log(`      ${hex(index)}   <failed: ${error instanceof Error ? error.message : String(error)}>`);
    }
  }
}

function describeDevice(device: HIDDevice): void {
  log(`Device: ${device.productName || "(unnamed)"}`);
  log(`  VID 0x${hex(device.vendorId, 4)}  PID 0x${hex(device.productId, 4)}`);
  for (const collection of device.collections) {
    const outputs = collection.outputReports.map((report) => `0x${hex(report.reportId)}`).join(",") || "none";
    const inputs = collection.inputReports.map((report) => `0x${hex(report.reportId)}`).join(",") || "none";
    log(`  collection usage 0x${hex(collection.usagePage, 4)}:0x${hex(collection.usage, 4)} in[${inputs}] out[${outputs}]`);
  }
}

async function probeDevice(device: HIDDevice): Promise<void> {
  describeDevice(device);
  const bus = new Transceiver(device);

  try {
    await bus.open();
  } catch (error) {
    log(`  cannot open: ${error instanceof Error ? error.message : String(error)}`);
    log("  (Another app may hold it exclusively — close Logi Options+ / G HUB and retry.)");
    log();
    return;
  }

  try {
    let found = 0;
    for (const deviceIndex of DEVICE_INDICES) {
      let version: { major: number; minor: number };
      try {
        version = await ping(bus, deviceIndex);
      } catch (error) {
        const reason = error instanceof HidppError ? error.message : "no answer";
        log(`  index 0x${hex(deviceIndex)}: ${reason}`);
        continue;
      }

      found += 1;
      log("");
      log(`  index 0x${hex(deviceIndex)}: ALIVE — HID++ ${version.major}.${version.minor}`);

      try {
        log(`    name: ${await readDeviceName(bus, deviceIndex)}`);
      } catch (error) {
        log(`    name: <failed: ${error instanceof Error ? error.message : String(error)}>`);
      }

      try {
        await dumpFeatureTable(bus, deviceIndex);
      } catch (error) {
        log(`    feature table failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    log("");
    log(found ? `Done — ${found} live device index(es).` : "Done — no device index answered.");
    if (!found) {
      log("If this is a receiver, wake the mouse (move it or click) and re-probe.");
    }
  } finally {
    await bus.close();
    log();
  }
}

/**
 * A receiver enumerates as several HIDDevices — one per interface — and only
 * one of them carries the HID++ endpoint. Picking by vendor id alone lands on
 * the keyboard or consumer-control collection, which answers nothing.
 */
function hasHidppCollection(device: HIDDevice): boolean {
  const search = (collections: readonly HIDCollectionInfo[]): boolean =>
    collections.some((collection) =>
      (collection.usagePage === 0xff00 && collection.usage === 0x0001) || search(collection.children));
  return device.vendorId === 0x046d && search(device.collections);
}

/** First index that answers a root ping, or null. */
async function findLiveIndex(bus: Transceiver): Promise<number | null> {
  for (const deviceIndex of DEVICE_INDICES) {
    try {
      await ping(bus, deviceIndex);
      return deviceIndex;
    } catch {
      // Empty slot; keep probing.
    }
  }
  return null;
}

/**
 * Read-only dump of the scroll-wheel features, with a tentative decode printed
 * beside the raw bytes so the two can be checked against each other. Nothing is
 * written — in particular the diversion bits, which would route wheel events to
 * HID++ and stop normal scrolling, are only ever read here.
 */
const WHEEL_READS: ReadonlyArray<{
  featureId: number;
  reads: ReadonlyArray<{ fn: number; label: string; params?: number[]; decode?: (reply: Uint8Array) => string }>;
}> = [
  {
    featureId: 0x2111,
    reads: [
      { fn: 0x0, label: "getCapabilities" },
      {
        fn: 0x1,
        label: "getRatchetControlMode",
        decode: (reply) => {
          const mode = reply[3] ?? 0;
          const modeName = mode === 1 ? "freespin (SmartShift active)" : mode === 2 ? "ratchet (always)" : `unknown (${mode})`;
          return `mode=${mode} ${modeName}, threshold=${reply[4] ?? 0}, default=${reply[5] ?? 0}`;
        },
      },
    ],
  },
  {
    featureId: 0x2121,
    reads: [
      { fn: 0x0, label: "getCapabilities", decode: (reply) => `caps=0b${(reply[3] ?? 0).toString(2).padStart(8, "0")} multiplier=${reply[4] ?? 0}` },
      {
        fn: 0x1,
        label: "getMode",
        decode: (reply) => {
          const mode = reply[3] ?? 0;
          return `mode=0b${mode.toString(2).padStart(8, "0")} → target/diverted=${mode & 0x01 ? "YES" : "no"}, hi-res=${mode & 0x02 ? "on" : "off"}, inverted=${mode & 0x04 ? "yes" : "no"}`;
        },
      },
      { fn: 0x3, label: "getRatchetSwitchState", decode: (reply) => `ratchet=${reply[3] ?? 0} (${reply[3] === 1 ? "engaged/clicky" : "freespin"})` },
    ],
  },
  {
    featureId: 0x2150,
    reads: [
      { fn: 0x0, label: "getThumbwheelInfo", decode: (reply) => `nativeRes=${((reply[3] ?? 0) << 8) | (reply[4] ?? 0)}, divertedRes=${((reply[5] ?? 0) << 8) | (reply[6] ?? 0)}, caps=0b${(reply[7] ?? 0).toString(2).padStart(8, "0")}` },
      { fn: 0x1, label: "getThumbwheelStatus", decode: (reply) => `status=0b${(reply[3] ?? 0).toString(2).padStart(8, "0")} → diverted=${(reply[3] ?? 0) & 0x01 ? "YES" : "no"}, inverted=${reply[4] ? "yes" : "no"}` },
    ],
  },
];

async function dumpWheelFeatures(device: HIDDevice): Promise<void> {
  describeDevice(device);
  const bus = new Transceiver(device);
  await bus.open();

  try {
    const deviceIndex = await findLiveIndex(bus);
    if (deviceIndex === null) {
      log("  no live device index — wake the mouse and retry.");
      return;
    }
    log(`  using device index 0x${hex(deviceIndex)}`);

    for (const feature of WHEEL_READS) {
      const label = FEATURE_NAMES[feature.featureId] ?? "(unknown)";
      log("");
      log(`  0x${hex(feature.featureId, 4)} ${label}`);

      const featureIndex = await getFeatureIndex(bus, deviceIndex, feature.featureId);
      if (!featureIndex) {
        log("    not implemented by this device.");
        continue;
      }

      for (const read of feature.reads) {
        try {
          const reply = await bus.request(deviceIndex, featureIndex, read.fn, read.params ?? []);
          log(`    fn 0x${hex(read.fn)} ${read.label.padEnd(22)} raw: ${hexBytes(reply.slice(3, 11))}`);
          if (read.decode) log(`         ↳ ${read.decode(reply)}`);
        } catch (error) {
          log(`    fn 0x${hex(read.fn)} ${read.label.padEnd(22)} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    log("");
    log("Done.");
  } finally {
    await bus.close();
  }
}

/** 0x1B04 control ids, from Solaar's special_keys table. */
const CONTROL_NAMES: Record<number, string> = {
  0x0050: "Left Button",
  0x0051: "Right Button",
  0x0052: "Middle Button",
  0x0053: "Back Button",
  0x0054: "Back",
  0x0056: "Forward Button",
  0x0057: "Forward (as HID)",
  0x0059: "Button 6",
  0x005a: "Button 7",
  0x005b: "Button 8",
  0x005c: "Button 9",
  0x005d: "Button 10",
  0x005e: "Button 11",
  0x00c3: "Mouse Gesture Button",
  0x00c4: "SmartShift",
  0x00d7: "Virtual Gesture Button",
  0x00dc: "Back Button Long Press",
  0x00e0: "Mission Control / Task View",
  0x00e1: "Dashboard / Action Center",
  0x00e2: "Backlight Down",
  0x00e3: "Backlight Up",
  0x00e4: "Previous Track",
  0x00e5: "Play / Pause",
  0x00e6: "Next Track",
  0x00e7: "Mute",
  0x00e8: "Volume Down",
  0x00e9: "Volume Up",
};

const controlName = (cid: number): string => CONTROL_NAMES[cid] ?? `(unknown 0x${hex(cid, 4)})`;

/** Tentative — printed beside the raw byte so the two can be checked. */
const KEY_FLAGS: ReadonlyArray<[number, string]> = [
  [0x01, "mouse-button"], [0x02, "fkey"], [0x04, "hotkey"], [0x08, "fn-toggle"],
  [0x10, "reprogrammable"], [0x20, "divertable"], [0x40, "persist-divertable"], [0x80, "virtual"],
];

const MAPPING_FLAGS: ReadonlyArray<[number, string]> = [
  [0x01, "diverted"], [0x04, "persistently-diverted"], [0x10, "raw-xy"], [0x40, "force-raw-xy"],
];

const decodeFlags = (value: number, table: ReadonlyArray<[number, string]>): string =>
  table.filter(([bit]) => (value & bit) !== 0).map(([, name]) => name).join(",") || "none";

/**
 * Read-only dump of 0x1B04 REPROG CONTROLS V4: every control, what it natively
 * does, whether it may be remapped, which groups it may be remapped into, and
 * where it currently points. No writes — remapping persists in the device, so
 * nothing is sent until the layout is confirmed.
 */
async function dumpButtons(device: HIDDevice): Promise<void> {
  describeDevice(device);
  const bus = new Transceiver(device);
  await bus.open();

  try {
    const deviceIndex = await findLiveIndex(bus);
    if (deviceIndex === null) {
      log("  no live device index — wake the mouse and retry.");
      return;
    }
    log(`  using device index 0x${hex(deviceIndex)}`);

    const featureIndex = await getFeatureIndex(bus, deviceIndex, 0x1b04);
    if (!featureIndex) {
      log("  0x1B04 REPROG CONTROLS V4 not implemented by this device.");
      return;
    }

    const count = (await bus.request(deviceIndex, featureIndex, 0x0))[3] ?? 0;
    log(`  ${count} reprogrammable controls`);
    log("");

    const controls: Array<{ cid: number; group: number; gmask: number }> = [];
    for (let index = 0; index < count; index += 1) {
      const info = await bus.request(deviceIndex, featureIndex, 0x1, [index]);
      const cid = ((info[3] ?? 0) << 8) | (info[4] ?? 0);
      const taskId = ((info[5] ?? 0) << 8) | (info[6] ?? 0);
      const flags1 = info[7] ?? 0;
      const pos = info[8] ?? 0;
      const group = info[9] ?? 0;
      const gmask = info[10] ?? 0;
      const flags2 = info[11] ?? 0;
      controls.push({ cid, group, gmask });

      log(`  [${index}] cid 0x${hex(cid, 4)} ${controlName(cid)}`);
      log(`       raw: ${hexBytes(info.slice(3, 12))}`);
      log(`       task 0x${hex(taskId, 4)} (${controlName(taskId)})  pos=${pos} group=${group} gmask=0b${gmask.toString(2).padStart(8, "0")}`);
      log(`       flags1=0x${hex(flags1)} → ${decodeFlags(flags1, KEY_FLAGS)}   flags2=0x${hex(flags2)}`);
    }

    log("");
    log("  Current reporting:");
    for (const { cid, gmask } of controls) {
      try {
        const reply = await bus.request(deviceIndex, featureIndex, 0x2, [cid >> 8, cid & 0xff]);
        const mappingFlags = (reply[5] ?? 0) | ((reply[8] ?? 0) << 8);
        const mappedTo = ((reply[6] ?? 0) << 8) | (reply[7] ?? 0);
        log(`    0x${hex(cid, 4)} ${controlName(cid).padEnd(28)} raw: ${hexBytes(reply.slice(3, 12))}`);
        log(`           → mapped to 0x${hex(mappedTo, 4)} ${controlName(mappedTo)}, flags ${decodeFlags(mappingFlags, MAPPING_FLAGS)}`);
      } catch (error) {
        log(`    0x${hex(cid, 4)} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      void gmask;
    }

    log("");
    log("  Remap targets each control allows (from its gmask):");
    const groupMembers = new Map<number, number[]>();
    for (const { cid, group } of controls) {
      if (!groupMembers.has(group)) groupMembers.set(group, []);
      groupMembers.get(group)!.push(cid);
    }
    for (const { cid, gmask } of controls) {
      const targets: number[] = [];
      for (let group = 1; group <= 8; group += 1) {
        if ((gmask & (1 << (group - 1))) !== 0) targets.push(...(groupMembers.get(group) ?? []));
      }
      log(`    0x${hex(cid, 4)} ${controlName(cid).padEnd(28)} ${targets.length ? targets.map((target) => controlName(target)).join(", ") : "not remappable"}`);
    }

    log("");
    log("Done.");
  } finally {
    await bus.close();
  }
}

/**
 * Features that exist on this hardware but that no public tool implements.
 * Solaar names 0x19B0 HAPTIC, 0x19C0 FORCE SENSING BUTTON and 0x2251 WHEEL
 * STATS in its id table and stops there — no function ids, no byte layouts. On
 * the MX Master 4 all three are flagged plain rather than engineering or
 * hidden, so they are meant to be driven, not merely present.
 */
const UNDOCUMENTED_FEATURES = [0x19b0, 0x19c0, 0x2251] as const;

/**
 * Plain, user-facing features the 45-entry table turned up that nothing here
 * has ever called. Deliberately excludes everything the firmware flags
 * hidden/engineering — those are factory hooks, not settings, and two of them
 * are flash access and device reset.
 */
const UNEXPLORED_FEATURES = [0x0007, 0x0011, 0x0020, 0x2250, 0x1701, 0x1602, 0x00d1] as const;

/**
 * How far up the function space to walk. HID++ 2.0 numbers each feature's
 * functions from zero and generally puts the getters first — but only
 * generally. On 0x0007 DEVICE FRIENDLY NAME functions 0x00 to 0x02 are all
 * getters and 0x03 is almost certainly setFriendlyName, which a walk to 0x03
 * called with zero arguments. The name survived, but that was luck rather than
 * design, so the safe ceiling now stops below the first plausible setter.
 * Anything above it is an explicit, deliberate choice.
 */
const SAFE_FUNCTION_CEILING = 0x02;
const DEEP_FUNCTION_CEILING = 0x0f;

/**
 * A refusal is as informative as a reply here. "Invalid function id" is the
 * only code that proves a function is absent; every other rejection means the
 * device recognised the call and objected to the arguments, which maps the
 * function space without ever landing a write.
 */
function classifyRefusal(error: HidppError): string {
  if (error.kind !== "hidpp20") return `inconclusive (${error.message})`;
  switch (error.code) {
    case 0x07: return "—";
    case 0x02: return "EXISTS — rejected zero arguments";
    case 0x03: return "EXISTS — argument out of range";
    case 0x08: return "EXISTS — device busy, worth a retry";
    case 0x09: return "EXISTS — unsupported in this state";
    default: return `EXISTS — ${error.message}`;
  }
}

async function scanFunctions(
  bus: Transceiver,
  deviceIndex: number,
  featureId: number,
  ceiling: number,
): Promise<void> {
  const label = FEATURE_NAMES[featureId] ?? "(unknown)";
  log("");
  log(`  0x${hex(featureId, 4)} ${label}`);

  const featureIndex = await getFeatureIndex(bus, deviceIndex, featureId);
  if (!featureIndex) {
    log("    not implemented by this device.");
    return;
  }
  log(`    feature index 0x${hex(featureIndex)}`);

  /*
   * Snapshot fn 0x00 before the walk and re-read it after. No ceiling makes a
   * blind walk safe — 0x0020's setter is fn 0x01, below any useful ceiling —
   * so the walk cannot avoid side effects and must instead notice them. This
   * caught nothing until it was needed: the walk zeroed 0x0020's configuration
   * cookie and nobody saw for three runs.
   */
  let before = "";
  try {
    before = hexBytes((await bus.request(deviceIndex, featureIndex, 0x0, [], 1200)).slice(3, 11));
  } catch {
    // A feature whose fn 0x00 needs arguments simply has no cheap snapshot.
  }

  for (let fn = 0; fn <= ceiling; fn += 1) {
    try {
      const reply = await bus.request(deviceIndex, featureIndex, fn, [], 1200);
      // A short reply carries 3 payload bytes, a long one 16 — which of the two
      // a function answers with is itself a clue to how much state it returns.
      const shape = reply.length > 7 ? "long " : "short";
      log(`    fn 0x${hex(fn)}  REPLY ${shape}  ${hexBytes(reply.slice(3))}`);
    } catch (error) {
      if (error instanceof HidppError) {
        log(`    fn 0x${hex(fn)}  ${classifyRefusal(error)}`);
      } else {
        log(`    fn 0x${hex(fn)}  <${error instanceof Error ? error.message : String(error)}>`);
      }
    }
  }

  if (before) {
    try {
      const after = hexBytes((await bus.request(deviceIndex, featureIndex, 0x0, [], 1200)).slice(3, 11));
      if (after !== before) {
        log(`    ⚠ THIS WALK CHANGED THE DEVICE: fn 0x00 was ${before}, now ${after}`);
      }
    } catch {
      // Nothing to compare against; silence beats a false all-clear.
    }
  }
}

async function dumpUndocumented(
  device: HIDDevice,
  ceiling: number,
  features: ReadonlyArray<number> = UNDOCUMENTED_FEATURES,
): Promise<void> {
  describeDevice(device);
  const bus = new Transceiver(device);
  await bus.open();

  try {
    const deviceIndex = await findLiveIndex(bus);
    if (deviceIndex === null) {
      log("  no live device index — wake the mouse and retry.");
      return;
    }
    log(`  using device index 0x${hex(deviceIndex)}`);
    log(`  walking function ids 0x00-0x${hex(ceiling)} with no arguments`);

    for (const featureId of features) {
      await scanFunctions(bus, deviceIndex, featureId, ceiling);
    }

    log("");
    log("Done.");
  } finally {
    await bus.close();
  }
}

/**
 * Getters worth sampling repeatedly. The safe scan showed 0x19C0 fn 0x02
 * answering with a single 16-bit value inside the range fn 0x01 advertises,
 * which is the shape of either a live force reading or a stored calibration
 * point. Only watching it while the panel is pressed tells the two apart.
 */
const WATCH_TARGETS: ReadonlyArray<{ featureId: number; fn: number; label: string; control?: true }> = [
  { featureId: 0x19c0, fn: 0x02, label: "force fn02" },
  { featureId: 0x19c0, fn: 0x01, label: "force fn01" },
  { featureId: 0x19b0, fn: 0x01, label: "haptic fn01" },
  /**
   * Positive control. 0x2121 fn 0x03 is known to track the wheel's ratchet
   * state, so pressing the wheel-mode button must make this line move. If it
   * does not, the watcher is broken and every other flat reading in the same
   * run proves nothing — a silent log and a dead probe look identical.
   */
  { featureId: 0x2121, fn: 0x03, label: "ratchet CONTROL", control: true },
  /** Candidate counters: if these are wheel statistics, scrolling moves them. */
  { featureId: 0x2251, fn: 0x01, label: "wheelstats fn01" },
  { featureId: 0x2251, fn: 0x02, label: "wheelstats fn02" },
  /**
   * 0x0020 fn 0x00 answers a single value — 0x12DD on this mouse. If that is a
   * configuration cookie it moves whenever anything changes a setting, which
   * would let a client notice an external change with one read instead of the
   * seven round-trips a full status refresh costs.
   */
  { featureId: 0x0020, fn: 0x00, label: "config cookie" },
  /**
   * Guard, not a discovery. The safe scan called 0x0007 fn 0x03 with zero
   * arguments on the assumption it was a getter; if it is setFriendlyName
   * instead, the name was overwritten with nulls. Watching it read back proves
   * whether "MX Master 4" survived.
   */
  { featureId: 0x0007, fn: 0x01, label: "friendly name" },
];

const WATCH_INTERVAL_MS = 60;
/** Stops a chatty device from burying the interesting lines. */
const MAX_NOTIFICATIONS_LOGGED = 600;

let watching = false;

/**
 * Polls the watch targets and prints a line only when a payload changes, so
 * pressing the panel shows up as a short burst in an otherwise silent log
 * rather than being buried under thousands of identical samples.
 */
async function watchTargets(device: HIDDevice): Promise<void> {
  describeDevice(device);
  const bus = new Transceiver(device);
  await bus.open();

  try {
    const deviceIndex = await findLiveIndex(bus);
    if (deviceIndex === null) {
      log("  no live device index — wake the mouse and retry.");
      return;
    }
    log(`  using device index 0x${hex(deviceIndex)}`);

    const targets: Array<{
      label: string;
      featureId: number;
      featureIndex: number;
      fn: number;
      last: string;
      changes: number;
      control?: true;
    }> = [];
    for (const target of WATCH_TARGETS) {
      const featureIndex = await getFeatureIndex(bus, deviceIndex, target.featureId);
      if (!featureIndex) {
        log(`  ${target.label}: 0x${hex(target.featureId, 4)} not implemented.`);
        continue;
      }
      targets.push({
        label: target.label,
        featureId: target.featureId,
        featureIndex,
        fn: target.fn,
        last: "",
        changes: 0,
        control: target.control,
      });
    }
    if (!targets.length) return;

    const featureMap = await readFeatureMap(bus, deviceIndex);
    log(`  resolved ${featureMap.size} feature indices`);

    let notifications = 0;
    bus.onNotification = (report) => {
      notifications += 1;
      if (notifications > MAX_NOTIFICATIONS_LOGGED) return;

      const featureIndex = report[1] ?? 0;
      const functionByte = report[2] ?? 0;
      const featureId = featureMap.get(featureIndex);
      const id = featureId === undefined ? "0x????" : `0x${hex(featureId, 4)}`;
      const name = featureId === undefined ? "(unmapped)" : FEATURE_NAMES[featureId] ?? "(unknown)";

      /*
       * The low nibble is the software id the request carried. Zero marks a
       * genuine device-initiated notification. Anything else is the *reply* to
       * a request another application made, which the receiver broadcasts to
       * every open handle — so Logi Options+ talking to the mouse shows up
       * here, giving a free software-level sniff of the vendor protocol.
       * Our own requests use 0x01 and are matched as replies, not seen here.
       */
      const softwareId = functionByte & 0x0f;
      const origin = softwareId === 0 ? "notify" : `swid${hex(softwareId)}`;

      let decoded = "";
      if (featureId === 0x1b04) {
        const cid = ((report[3] ?? 0) << 8) | (report[4] ?? 0);
        decoded = cid ? `  ← ${controlName(cid)}` : "  ← (all released)";
      }

      log(
        `    EVENT ${id} ${name.padEnd(22)} fn 0x${hex(functionByte >> 4)} ${origin.padEnd(7)}` +
        ` ${hexBytes(report.slice(3, 11))}${decoded}`,
      );
    };

    log("");
    log("  Watching. Press and hold the haptic panel, roll the wheel, click the buttons.");
    log("  Polled lines appear only on change; EVENT lines are device-initiated.");
    log("  Press the wheel-mode button too — that must move “ratchet CONTROL”.");
    log("  Click “Stop watching” when done.");
    log("");

    let samples = 0;
    while (watching) {
      for (const target of targets) {
        if (!watching) break;
        try {
          const reply = await bus.request(deviceIndex, target.featureIndex, target.fn, [], 800);
          // The friendly name needs its printable form to be readable at a
          // glance; hex alone would not show nulls replacing the text.
          const payload = target.featureId === 0x0007
            ? `${hexBytes(reply.slice(3, 11))}  "${[...reply.slice(4, 16)]
                .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : b === 0 ? "" : "."))
                .join("")}"`
            : hexBytes(reply.slice(3, 11));
          if (payload !== target.last) {
            // The first read of each target is the baseline, not a change.
            if (target.last) target.changes += 1;
            log(`    ${target.label.padEnd(16)} ${target.last ? "→" : "  "} ${payload}`);
            target.last = payload;
          }
        } catch (error) {
          log(`    ${target.label.padEnd(16)} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      samples += 1;
      await new Promise((resolve) => window.setTimeout(resolve, WATCH_INTERVAL_MS));
    }

    log("");
    log(`Stopped after ${samples} sampling rounds, ${notifications} device-initiated report(s).`);
    /*
     * The control exists to tell a silent device apart from a blind watcher,
     * and any target moving proves the watcher just as well. Firing the alarm
     * on the control alone cried wolf on a run where the haptic line changed
     * four times — and an alarm that is routinely wrong gets ignored when it
     * is finally right.
     */
    const moved = targets.filter((target) => target.changes > 0);
    if (!moved.length && notifications === 0) {
      log("");
      log("⚠ Nothing moved and no events arrived. Either nothing on the mouse was");
      log("  touched, or the watcher is blind — in which case the flat readings in");
      log("  this run are not evidence of anything.");
    } else if (moved.length) {
      log(`  proof of life: ${moved.map((target) => `${target.label} (${target.changes})`).join(", ")}`);
    }
  } finally {
    bus.onNotification = null;
    await bus.close();
  }
}

/**
 * Replays the one call Logi Options+ makes straight after every haptic-strength
 * write: 0x19B0 fn 0x04, which answered `08`. The guess is that it plays a
 * sample effect so the user feels the strength they just chose. This is a
 * write, but a replay of observed traffic rather than an invention, and a
 * buzz leaves nothing behind to undo.
 */
async function testHapticPulse(device: HIDDevice, effect: number): Promise<void> {
  describeDevice(device);
  const bus = new Transceiver(device);
  await bus.open();

  try {
    const deviceIndex = await findLiveIndex(bus);
    if (deviceIndex === null) {
      log("  no live device index — wake the mouse and retry.");
      return;
    }
    const featureIndex = await getFeatureIndex(bus, deviceIndex, 0x19b0);
    if (!featureIndex) {
      log("  0x19B0 HAPTIC not implemented by this device.");
      return;
    }

    log(`  sending 0x19B0 fn 0x04 with effect 0x${hex(effect)} — hold the mouse.`);
    try {
      const reply = await bus.request(deviceIndex, featureIndex, 0x04, [effect]);
      log(`  reply: ${hexBytes(reply.slice(3, 11))}`);
      log("");
      log("  Did you feel a buzz? That is the whole test — the reply says nothing");
      log("  about whether the motor actually ran.");
    } catch (error) {
      log(`  refused: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    await bus.close();
  }
}

/**
 * How far to walk the effect ids. The device decides the real bound: an id it
 * does not implement should be refused, so accept-versus-refuse maps the
 * library without anyone having to feel every buzz.
 */
const EFFECT_SWEEP_CEILING = 0x3f;
/** Long enough that one buzz finishes before the next starts. */
const EFFECT_SWEEP_GAP_MS = 400;

/**
 * Plays every effect id in turn and records which the mouse accepts. Each is a
 * transient motor pulse that leaves nothing behind, so the sweep is repeatable
 * and needs no undo.
 */
async function mapHapticEffects(device: HIDDevice, ceiling: number): Promise<void> {
  describeDevice(device);
  const bus = new Transceiver(device);
  await bus.open();

  try {
    const deviceIndex = await findLiveIndex(bus);
    if (deviceIndex === null) {
      log("  no live device index — wake the mouse and retry.");
      return;
    }
    const featureIndex = await getFeatureIndex(bus, deviceIndex, 0x19b0);
    if (!featureIndex) {
      log("  0x19B0 HAPTIC not implemented by this device.");
      return;
    }

    log(`  playing effect ids 0x00-0x${hex(ceiling)}, ${EFFECT_SWEEP_GAP_MS}ms apart.`);
    log("  Hold the mouse and note which ids you actually feel — an id the mouse");
    log("  accepts is not proof the motor ran.");
    log("");

    const accepted: number[] = [];
    const refused: number[] = [];
    for (let effect = 0; effect <= ceiling; effect += 1) {
      try {
        const reply = await bus.request(deviceIndex, featureIndex, 0x04, [effect], 1200);
        accepted.push(effect);
        log(`    effect 0x${hex(effect)} (${String(effect).padStart(3)})  accepted   ${hexBytes(reply.slice(3, 9))}`);
      } catch (error) {
        refused.push(effect);
        const reason = error instanceof HidppError ? error.message : String(error);
        log(`    effect 0x${hex(effect)} (${String(effect).padStart(3)})  refused — ${reason}`);
      }
      await new Promise((resolve) => window.setTimeout(resolve, EFFECT_SWEEP_GAP_MS));
    }

    log("");
    log(`  accepted (${accepted.length}): ${accepted.map((id) => `0x${hex(id)}`).join(" ") || "none"}`);
    log(`  refused  (${refused.length}): ${refused.map((id) => `0x${hex(id)}`).join(" ") || "none"}`);
    if (!refused.length) {
      log("");
      log("  ⚠ Nothing was refused, so this sweep did not find the upper bound —");
      log("    the library is either wider than the ceiling or unbounded.");
    }
  } finally {
    await bus.close();
  }
}

/**
 * The effect ids an MX Master 4 accepts, found by sweeping 0x00-0x3F: fifteen
 * contiguous plus one outlier at 0x1B. Everything else answers "invalid
 * argument". Descriptions are from feeling each one on real hardware.
 *
 * The reply's byte 1 is deliberately NOT recorded per effect. It reports
 * whether the motor was already busy, proven by playing 0x0B from idle and
 * again on the heels of 0x0C: byte 1 read 0,0,0 and then 1,1,1 for the very
 * same effect id. It first looked like a duration flag, which is backwards —
 * 0x0E is two long vibrates and reads 0, 0x0B is three quick taps and reads 1.
 *
 * Note 0x00/0x01 are indistinguishable, as are 0x02/0x03/0x04, so these 16
 * accepted ids are only 11 distinct sensations.
 */
const KNOWN_EFFECTS: ReadonlyArray<{ id: number; feel: string }> = [
  { id: 0x00, feel: "double buzz, quick" },
  { id: 0x01, feel: "double buzz, quick (same as 0x00)" },
  { id: 0x02, feel: "single buzz, quick" },
  { id: 0x03, feel: "single buzz, quick (same as 0x02)" },
  { id: 0x04, feel: "single buzz, quick (same as 0x02)" },
  { id: 0x05, feel: "4 quick buzzes then 2 quicker — a little long" },
  { id: 0x06, feel: "long soft steady vibrate with 5 quick buzzes" },
  { id: 0x07, feel: "one buzz then two quick" },
  { id: 0x08, feel: "3 quick buzzes then one — the Options+ sample" },
  { id: 0x09, feel: "2 quick buzzes then a long light vibrate" },
  { id: 0x0a, feel: "2 quick then 3 quick" },
  { id: 0x0b, feel: "3 quick" },
  { id: 0x0c, feel: "3 steady buzzes about half a second apart" },
  { id: 0x0d, feel: "1-3-1 quick buzzes then 2 quick vibrates" },
  { id: 0x0e, feel: "two long light vibrates" },
  { id: 0x1b, feel: "like another in this list but lighter — which one is unconfirmed" },
];

/**
 * Settles what byte 1 of a play reply means. If it is a property of the effect
 * it is fixed for a given id; if it reports that the motor was already busy it
 * changes for the same id depending on what ran just before. Playing one short
 * effect twice — once from idle, once on the heels of the longest effect in
 * the library — separates those two readings, and needs nobody to feel a thing.
 *
 * Answered on a real MX Master 4: 0,0,0 from idle against 1,1,1 when chased.
 * Kept because it is the check that would catch a firmware disagreeing.
 */
async function testReplyByteOne(device: HIDDevice): Promise<void> {
  const PROBE_EFFECT = 0x0b;
  const LONG_EFFECT = 0x0c;

  describeDevice(device);
  const bus = new Transceiver(device);
  await bus.open();

  try {
    const deviceIndex = await findLiveIndex(bus);
    const featureIndex = deviceIndex === null ? 0 : await getFeatureIndex(bus, deviceIndex, 0x19b0);
    if (deviceIndex === null || !featureIndex) {
      log("  no live device index, or no 0x19B0 on this mouse.");
      return;
    }

    const play = async (effect: number): Promise<number> => {
      const reply = await bus.request(deviceIndex, featureIndex, 0x04, [effect], 1200);
      return reply[4] ?? -1;
    };
    const idle = (ms: number): Promise<unknown> =>
      new Promise((resolve) => window.setTimeout(resolve, ms));

    const isolated: number[] = [];
    const chased: number[] = [];

    for (let round = 0; round < 3; round += 1) {
      await idle(2500);
      isolated.push(await play(PROBE_EFFECT));

      await idle(2500);
      await play(LONG_EFFECT);
      await idle(120);
      chased.push(await play(PROBE_EFFECT));
    }

    log(`  0x${hex(PROBE_EFFECT)} from idle          → byte1 = ${isolated.join(", ")}`);
    log(`  0x${hex(PROBE_EFFECT)} right after 0x${hex(LONG_EFFECT)} → byte1 = ${chased.join(", ")}`);
    log("");

    const steady = (values: number[]): boolean => values.every((value) => value === values[0]);
    if (!steady(isolated) || !steady(chased)) {
      log("  Inconclusive — the same condition gave different answers, so timing is");
      log("  not being controlled tightly enough to read anything into it.");
    } else if (isolated[0] === chased[0]) {
      log(`  Byte 1 stayed ${isolated[0]} in both cases, so it is a property of the effect`);
      log("  and not a busy flag. The duration reading is still dead; it means");
      log("  something else about the effect itself.");
    } else {
      log("  Byte 1 CHANGED for the same effect id purely because of what ran");
      log("  before it — so it reports motor state, not anything about the effect.");
      log("  It must not be shown as an effect property anywhere.");
    }
  } finally {
    await bus.close();
  }
}

/**
 * One button per known effect, so two of them can be compared back to back.
 * Characterising a buzz means feeling it beside its neighbour, which a linear
 * sweep makes impossible.
 */
function buildEffectPad(): void {
  const pad = document.querySelector<HTMLElement>("#effect-pad");
  if (!pad) return;

  for (const { id, feel } of KNOWN_EFFECTS) {
    const button = document.createElement("button");
    button.textContent = `0x${hex(id)}`;
    button.title = feel;
    button.className = "effect";
    button.addEventListener("click", () => {
      void (async () => {
        if (!navigator.hid) return;
        const device = (await navigator.hid.getDevices()).find(hasHidppCollection);
        if (!device) {
          log("No authorized HID++ device yet — use “Pick a Logitech HID++ device” first.");
          return;
        }
        const bus = new Transceiver(device);
        await bus.open();
        try {
          const deviceIndex = await findLiveIndex(bus);
          const featureIndex = deviceIndex === null
            ? 0
            : await getFeatureIndex(bus, deviceIndex, 0x19b0);
          if (deviceIndex === null || !featureIndex) {
            log("  no live device index, or no 0x19B0 on this mouse.");
            return;
          }
          const reply = await bus.request(deviceIndex, featureIndex, 0x04, [id], 1200);
          log(`  effect 0x${hex(id)} → ${hexBytes(reply.slice(3, 9))}   ${feel}`);
        } catch (error) {
          log(`  effect 0x${hex(id)} failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          await bus.close();
        }
      })().catch((error) => log(`Error: ${error}`));
    });
    pad.append(button);
  }
}

buildEffectPad();

/**
 * Read-only dump of 0x1815 HOSTS INFO — the Easy-Switch slots. Decodes beside
 * the raw bytes so the two can be checked against each other; Solaar documents
 * this feature, but a decode is a claim until this mouse's bytes agree with it.
 * Nothing here writes: 0x1814 CHANGE HOST would move the mouse to another
 * machine, which is a separate deliberate act.
 */
async function dumpHosts(device: HIDDevice): Promise<void> {
  describeDevice(device);
  const bus = new Transceiver(device);
  await bus.open();

  try {
    const deviceIndex = await findLiveIndex(bus);
    if (deviceIndex === null) {
      log("  no live device index — wake the mouse and retry.");
      return;
    }
    const featureIndex = await getFeatureIndex(bus, deviceIndex, 0x1815);
    if (!featureIndex) {
      log("  0x1815 HOSTS INFO not implemented by this device.");
      return;
    }
    log(`  0x1815 HOSTS INFO at feature index 0x${hex(featureIndex)}`);
    log("");

    const info = await bus.request(deviceIndex, featureIndex, 0x0);
    log(`  fn 0x00 getHostsInfo    raw: ${hexBytes(info.slice(3, 11))}`);
    /*
     * Corrected against this mouse. Reading these one byte early claimed eight
     * slots while slots 3 and up refused outright — the two leading bytes are a
     * capability mask, so the counts sit after it.
     */
    const hostCount = info[5] ?? 0;
    const currentHost = info[6] ?? 0;
    const capabilities = ((info[3] ?? 0) << 8) | (info[4] ?? 0);
    log(`       ↳ capabilities=0x${hex(capabilities, 4)}, ${hostCount} slot(s), currently slot ${currentHost} (0-based)`);

    // Deliberately walks one past the reported count: a refusal on the next
    // slot is what proves the count right rather than merely self-consistent.
    for (let host = 0; host <= Math.max(hostCount, 1) && host < 8; host += 1) {
      log("");
      try {
        const entry = await bus.request(deviceIndex, featureIndex, 0x1, [host]);
        const status = entry[4] ?? 0;
        const nameLength = entry[7] ?? 0;
        const label = host === currentHost ? " ← this computer" : "";
        log(`  slot ${host}${label}`);
        log(`    fn 0x01 getHostInfo   raw: ${hexBytes(entry.slice(3, 11))}`);
        log(`         ↳ status=${status} (${status === 0 ? "empty" : status === 1 ? "paired" : `other (${status})`}), name length=${nameLength}`);

        if (nameLength) {
          /*
           * Raw first. The previous decode assumed the name began after an
           * echoed host index and byte index and produced mojibake, so that
           * offset is wrong — and a decode printed with no raw beside it
           * leaves nothing to correct it from. ASCII is obvious in hex.
           */
          const chunk = await bus.request(deviceIndex, featureIndex, 0x2, [host, 0]);
          log(`    fn 0x02 name chunk    raw: ${hexBytes(chunk.slice(3, 19))}`);
          const ascii = [...chunk.slice(3, 19)]
            .map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : "."))
            .join("");
          log(`         ↳ printable: "${ascii}"   (name is ${nameLength} chars — where does it start?)`);
        }
      } catch (error) {
        log(`  slot ${host}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    log("");
    log("Done — nothing was written. Switching hosts is a separate, deliberate action.");
  } finally {
    await bus.close();
  }
}

/**
 * Writes 0x12DD back to 0x0020 and reads it again. The value is the one this
 * mouse held before a zero-argument walk overwrote it, so the experiment and
 * the repair are the same action: a read-back of 12 DD both confirms fn 0x01
 * is the cookie setter and leaves the mouse as it was found.
 */
async function restoreConfigCookie(device: HIDDevice): Promise<void> {
  const ORIGINAL = [0x12, 0xdd];

  describeDevice(device);
  const bus = new Transceiver(device);
  await bus.open();

  try {
    const deviceIndex = await findLiveIndex(bus);
    const featureIndex = deviceIndex === null ? 0 : await getFeatureIndex(bus, deviceIndex, 0x0020);
    if (deviceIndex === null || !featureIndex) {
      log("  no live device index, or no 0x0020 on this mouse.");
      return;
    }

    const before = await bus.request(deviceIndex, featureIndex, 0x0, [], 1200);
    log(`  before  fn 0x00: ${hexBytes(before.slice(3, 11))}`);

    const written = await bus.request(deviceIndex, featureIndex, 0x1, ORIGINAL, 1200);
    log(`  write   fn 0x01 [${ORIGINAL.map((b) => hex(b)).join(" ")}] replied: ${hexBytes(written.slice(3, 11))}`);

    const after = await bus.request(deviceIndex, featureIndex, 0x0, [], 1200);
    const readBack = hexBytes(after.slice(3, 11));
    log(`  after   fn 0x00: ${readBack}`);
    log("");

    if (readBack.startsWith("12 DD")) {
      log("  Confirmed: fn 0x01 sets the cookie, and the original value is restored.");
    } else if (readBack === hexBytes(before.slice(3, 11))) {
      log("  Unchanged — fn 0x01 is not the setter, and nothing here overwrote the cookie.");
      log("  Something else zeroed it, which is worth knowing before blaming the walk.");
    } else {
      log("  It moved, but not to what was written. fn 0x01 takes a different shape;");
      log("  do not write here again until the layout is understood.");
    }
  } finally {
    await bus.close();
  }
}

async function pick(filters: HIDDeviceFilter[]): Promise<void> {
  if (!navigator.hid) {
    log("WebHID is unavailable. Use Chrome or Edge on desktop over http://localhost.");
    return;
  }
  const devices = await navigator.hid.requestDevice({ filters });
  if (!devices.length) {
    log("No device selected.");
    return;
  }
  resetLog();
  for (const device of devices) await probeDevice(device);
}

document.querySelector("#pick")!.addEventListener("click", () => {
  void pick([{ vendorId: 0x046d, usagePage: 0xff00, usage: 0x0001 }]).catch((error) => log(`Error: ${error}`));
});

document.querySelector("#pick-any")!.addEventListener("click", () => {
  void pick([{ vendorId: 0x046d }]).catch((error) => log(`Error: ${error}`));
});

document.querySelector("#rescan")!.addEventListener("click", () => {
  void (async () => {
    if (!navigator.hid) return;
    const devices = await navigator.hid.getDevices();
    const candidates = devices.filter(hasHidppCollection);
    resetLog();
    if (!candidates.length) {
      log("No authorized HID++ devices yet — use the pick buttons first.");
      return;
    }
    for (const device of candidates) await probeDevice(device);
  })().catch((error) => log(`Error: ${error}`));
});

document.querySelector("#wheel")!.addEventListener("click", () => {
  void (async () => {
    if (!navigator.hid) return;
    const devices = await navigator.hid.getDevices();
    const device = devices.find(hasHidppCollection);
    resetLog();
    if (!device) {
      log("No authorized HID++ device yet — use “Pick a Logitech HID++ device” first.");
      return;
    }
    await dumpWheelFeatures(device);
  })().catch((error) => log(`Error: ${error}`));
});

document.querySelector("#buttons")!.addEventListener("click", () => {
  void (async () => {
    if (!navigator.hid) return;
    const devices = await navigator.hid.getDevices();
    const device = devices.find(hasHidppCollection);
    resetLog();
    if (!device) {
      log("No authorized HID++ device yet — use “Pick a Logitech HID++ device” first.");
      return;
    }
    await dumpButtons(device);
  })().catch((error) => log(`Error: ${error}`));
});

/** Both scan buttons run the same walk; only how far it goes differs. */
function wireScanButton(
  selector: string,
  ceiling: number,
  features?: ReadonlyArray<number>,
): void {
  document.querySelector(selector)!.addEventListener("click", () => {
    void (async () => {
      if (!navigator.hid) return;
      const devices = await navigator.hid.getDevices();
      const device = devices.find(hasHidppCollection);
      resetLog();
      if (!device) {
        log("No authorized HID++ device yet — use “Pick a Logitech HID++ device” first.");
        return;
      }
      await dumpUndocumented(device, ceiling, features);
    })().catch((error) => log(`Error: ${error}`));
  });
}

wireScanButton("#scan-safe", SAFE_FUNCTION_CEILING);
wireScanButton("#scan-deep", DEEP_FUNCTION_CEILING);
wireScanButton("#scan-unexplored", SAFE_FUNCTION_CEILING, UNEXPLORED_FEATURES);

document.querySelector("#restore-cookie")!.addEventListener("click", () => {
  void (async () => {
    if (!navigator.hid) return;
    const device = (await navigator.hid.getDevices()).find(hasHidppCollection);
    resetLog();
    if (!device) {
      log("No authorized HID++ device yet.");
      return;
    }
    await restoreConfigCookie(device);
  })().catch((error) => log(`Error: ${error}`));
});

document.querySelector("#hosts")!.addEventListener("click", () => {
  void (async () => {
    if (!navigator.hid) return;
    const device = (await navigator.hid.getDevices()).find(hasHidppCollection);
    resetLog();
    if (!device) {
      log("No authorized HID++ device yet — use “Pick a Logitech HID++ device” first.");
      return;
    }
    await dumpHosts(device);
  })().catch((error) => log(`Error: ${error}`));
});

document.querySelector("#byte1")!.addEventListener("click", () => {
  void (async () => {
    if (!navigator.hid) return;
    const device = (await navigator.hid.getDevices()).find(hasHidppCollection);
    resetLog();
    if (!device) {
      log("No authorized HID++ device yet — use “Pick a Logitech HID++ device” first.");
      return;
    }
    log("Running — about 15 seconds. Leave the mouse alone.");
    log("");
    await testReplyByteOne(device);
  })().catch((error) => log(`Error: ${error}`));
});

document.querySelector("#sweep")!.addEventListener("click", () => {
  void (async () => {
    if (!navigator.hid) return;
    const devices = await navigator.hid.getDevices();
    const device = devices.find(hasHidppCollection);
    resetLog();
    if (!device) {
      log("No authorized HID++ device yet — use “Pick a Logitech HID++ device” first.");
      return;
    }
    await mapHapticEffects(device, EFFECT_SWEEP_CEILING);
  })().catch((error) => log(`Error: ${error}`));
});

document.querySelector("#buzz")!.addEventListener("click", () => {
  void (async () => {
    if (!navigator.hid) return;
    const devices = await navigator.hid.getDevices();
    const device = devices.find(hasHidppCollection);
    resetLog();
    if (!device) {
      log("No authorized HID++ device yet — use “Pick a Logitech HID++ device” first.");
      return;
    }
    const effect = Number(document.querySelector<HTMLInputElement>("#buzz-effect")!.value) || 0;
    await testHapticPulse(device, effect);
  })().catch((error) => log(`Error: ${error}`));
});

const watchButton = document.querySelector<HTMLButtonElement>("#watch")!;

watchButton.addEventListener("click", () => {
  if (watching) {
    watching = false;
    watchButton.textContent = "Watch live values";
    return;
  }
  void (async () => {
    if (!navigator.hid) return;
    const devices = await navigator.hid.getDevices();
    const device = devices.find(hasHidppCollection);
    resetLog();
    if (!device) {
      log("No authorized HID++ device yet — use “Pick a Logitech HID++ device” first.");
      return;
    }
    watching = true;
    watchButton.textContent = "Stop watching";
    try {
      await watchTargets(device);
    } finally {
      watching = false;
      watchButton.textContent = "Watch live values";
    }
  })().catch((error) => {
    watching = false;
    watchButton.textContent = "Watch live values";
    log(`Error: ${error}`);
  });
});

document.querySelector("#copy")!.addEventListener("click", () => {
  void navigator.clipboard.writeText(logText);
});
