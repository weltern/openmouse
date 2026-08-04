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

  private readonly onInputReport = (event: HIDInputReportEvent): void => {
    if (event.reportId !== SHORT_REPORT_ID && event.reportId !== LONG_REPORT_ID) return;
    const request = this.pending;
    if (!request) return;

    const report = new Uint8Array(
      event.data.buffer.slice(event.data.byteOffset, event.data.byteOffset + event.data.byteLength),
    );
    if (report[0] !== request.deviceIndex) return;

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
    }
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

document.querySelector("#copy")!.addEventListener("click", () => {
  void navigator.clipboard.writeText(logText);
});
