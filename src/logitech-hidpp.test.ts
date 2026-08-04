import assert from "node:assert/strict";
import test from "node:test";

import { LogitechHidppClient } from "./logitech-hidpp.ts";

const SHORT_REPORT_ID = 0x10;
const LONG_REPORT_ID = 0x11;
const SOFTWARE_ID = 0x01;

const FEATURE_INDEX = {
  featureSet: 0x01,
  firmware: 0x02,
  deviceName: 0x03,
  unifiedBattery: 0x09,
  smartShift: 0x11,
  hiresWheel: 0x12,
  thumbWheel: 0x13,
  adjustableDpi: 0x14,
} as const;

/** Feature id -> index, mirroring the table an MX Master 4 reports. */
const MX_MASTER_4_FEATURES = new Map<number, number>([
  [0x0001, FEATURE_INDEX.featureSet],
  [0x0003, FEATURE_INDEX.firmware],
  [0x0005, FEATURE_INDEX.deviceName],
  [0x1004, FEATURE_INDEX.unifiedBattery],
  [0x2111, FEATURE_INDEX.smartShift],
  [0x2121, FEATURE_INDEX.hiresWheel],
  [0x2150, FEATURE_INDEX.thumbWheel],
  [0x2201, FEATURE_INDEX.adjustableDpi],
]);

interface FakeDeviceOptions {
  /** Receiver slot the mouse answers on. */
  liveIndex?: number;
  features?: Map<number, number>;
  /** Empty slots reply with a HID++ 2.0 (0xff) or 1.0 (0x8f) error. */
  errorStyle?: "hidpp20" | "hidpp10";
  dpiList?: number[];
  wheelMode?: number;
  smartShift?: { mode: number; threshold: number };
  thumbWheel?: { diverted: number; inverted: number };
}

/**
 * A HID++ receiver simulator. It answers root pings on one slot, rejects the
 * rest the way real firmware does, and keeps mutable state for the settings the
 * client writes so read-back assertions mean something.
 */
class FakeHidDevice implements Partial<HIDDevice> {
  readonly vendorId = 0x046d;
  readonly productId = 0xc548;
  readonly productName = "USB Receiver";
  readonly collections = [{ usagePage: 0xff00, usage: 0x0001, children: [], inputReports: [], outputReports: [], featureReports: [] }];
  opened = false;

  /** Every request sent, so tests can assert on traffic volume. */
  readonly sent: Array<{ reportId: number; bytes: number[] }> = [];

  private listener: ((event: HIDInputReportEvent) => void) | null = null;
  private readonly liveIndex: number;
  private readonly features: Map<number, number>;
  private readonly errorStyle: "hidpp20" | "hidpp10";
  private readonly dpiList: number[];
  dpi = 1000;
  wheelMode: number;
  smartShift: { mode: number; threshold: number };
  thumbWheel: { diverted: number; inverted: number };
  /** Changes between reads, standing in for a value the cache must not freeze. */
  batteryPercent = 90;

  constructor(options: FakeDeviceOptions = {}) {
    this.liveIndex = options.liveIndex ?? 0x02;
    this.features = options.features ?? MX_MASTER_4_FEATURES;
    this.errorStyle = options.errorStyle ?? "hidpp20";
    this.dpiList = options.dpiList ?? [];
    this.wheelMode = options.wheelMode ?? 0x00;
    this.smartShift = options.smartShift ?? { mode: 2, threshold: 0xff };
    this.thumbWheel = options.thumbWheel ?? { diverted: 1, inverted: 0 };
  }

  async open(): Promise<void> {
    this.opened = true;
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  addEventListener(_type: "inputreport", listener: (event: HIDInputReportEvent) => void): void {
    this.listener = listener;
  }

  removeEventListener(): void {
    this.listener = null;
  }

  async sendReport(reportId: number, data: BufferSource): Promise<void> {
    const bytes = [...new Uint8Array(data as ArrayBufferView["buffer"] extends never ? never : ArrayBuffer)];
    void bytes;
    const request = [...new Uint8Array((data as Uint8Array).buffer, (data as Uint8Array).byteOffset, (data as Uint8Array).byteLength)];
    this.sent.push({ reportId, bytes: request });
    const reply = this.respond(request);
    if (reply) this.emit(reply);
  }

  private emit(payload: number[]): void {
    const bytes = new Uint8Array(payload.length >= 7 ? 19 : 6);
    bytes.set(payload.slice(0, bytes.length));
    this.listener?.({
      reportId: payload.length >= 7 ? LONG_REPORT_ID : SHORT_REPORT_ID,
      data: new DataView(bytes.buffer),
    } as HIDInputReportEvent);
  }

  private error(deviceIndex: number, featureIndex: number, functionByte: number): number[] {
    return this.errorStyle === "hidpp20"
      ? [deviceIndex, 0xff, featureIndex, functionByte, 0x09]
      : [deviceIndex, 0x8f, featureIndex, functionByte, 0x09];
  }

  private respond(request: number[]): number[] | null {
    const [deviceIndex, featureIndex, functionByte] = request;
    const parameters = request.slice(3);
    const ok = (...payload: number[]): number[] => [deviceIndex, featureIndex, functionByte, ...payload];

    if (deviceIndex !== this.liveIndex) return this.error(deviceIndex, featureIndex, functionByte);

    if (featureIndex === 0x00) {
      // Root: function 0 resolves a feature id, function 1 is the ping.
      if (functionByte === (0x00 | SOFTWARE_ID)) {
        const featureId = (parameters[0] << 8) | parameters[1];
        return ok(this.features.get(featureId) ?? 0x00, 0x00, 0x02);
      }
      if (functionByte === (0x10 | SOFTWARE_ID)) return ok(0x04, 0x05, parameters[2]);
      return this.error(deviceIndex, featureIndex, functionByte);
    }

    switch (featureIndex) {
      case FEATURE_INDEX.deviceName: {
        const name = [..."MX Master 4"].map((character) => character.charCodeAt(0));
        if (functionByte === (0x00 | SOFTWARE_ID)) return ok(name.length);
        return ok(...name);
      }

      case FEATURE_INDEX.firmware:
        if (functionByte === (0x00 | SOFTWARE_ID)) {
          // getDeviceInfo: entityCount, unitId(4), transport(2), modelId(6)
          return ok(0x02, 0x89, 0xbc, 0x3f, 0xa3, 0x00, 0x04, 0xb0, 0x42, 0, 0, 0, 0, 0);
        }
        return ok(0x00, 0x52, 0x42, 0x4d, 0x27, 0x00);

      case FEATURE_INDEX.unifiedBattery:
        return ok(this.batteryPercent, 0x00, 0x00);

      case FEATURE_INDEX.adjustableDpi:
        if (functionByte === (0x10 | SOFTWARE_ID)) {
          return ok(0x00, ...this.dpiList.flatMap((value) => [value >> 8, value & 0xff]), 0x00, 0x00);
        }
        if (functionByte === (0x30 | SOFTWARE_ID)) {
          this.dpi = (parameters[1] << 8) | parameters[2];
          return ok(0x00);
        }
        return ok(0x00, this.dpi >> 8, this.dpi & 0xff, 0x03, 0xe8);

      case FEATURE_INDEX.smartShift:
        if (functionByte === (0x00 | SOFTWARE_ID)) return ok(0x01, 0x0a, 0x4b, 0x0e);
        if (functionByte === (0x20 | SOFTWARE_ID)) {
          this.smartShift = { mode: parameters[0], threshold: parameters[1] };
          return ok(this.smartShift.mode, this.smartShift.threshold, 0x64);
        }
        return ok(this.smartShift.mode, this.smartShift.threshold, 0x64);

      case FEATURE_INDEX.hiresWheel:
        if (functionByte === (0x00 | SOFTWARE_ID)) return ok(0x0f, 0x1c, 0x18, 0x18);
        if (functionByte === (0x20 | SOFTWARE_ID)) {
          this.wheelMode = parameters[0];
          return ok(this.wheelMode);
        }
        if (functionByte === (0x30 | SOFTWARE_ID)) return ok(0x01);
        return ok(this.wheelMode);

      case FEATURE_INDEX.thumbWheel:
        if (functionByte === (0x00 | SOFTWARE_ID)) return ok(0x00, 0x14, 0x00, 0x78, 0x00, 0x03, 0x03, 0xe8);
        if (functionByte === (0x20 | SOFTWARE_ID)) {
          this.thumbWheel = { diverted: parameters[0], inverted: parameters[1] };
          return ok(this.thumbWheel.diverted, this.thumbWheel.inverted);
        }
        return ok(this.thumbWheel.diverted, this.thumbWheel.inverted);

      default:
        return this.error(deviceIndex, featureIndex, functionByte);
    }
  }
}

function createClient(options?: FakeDeviceOptions): { client: LogitechHidppClient; device: FakeHidDevice } {
  const device = new FakeHidDevice(options);
  return { client: new LogitechHidppClient(device as unknown as HIDDevice), device };
}

/**
 * Mirrors the panel's real sequence: a status read opens the device and
 * resolves its index before any setter runs. Traffic is cleared afterwards so
 * assertions see only what the test itself provoked.
 */
async function connectClient(options?: FakeDeviceOptions): Promise<{ client: LogitechHidppClient; device: FakeHidDevice }> {
  const { client, device } = createClient(options);
  await client.readStatus();
  device.sent.length = 0;
  return { client, device };
}

/** Device index each request was addressed to. */
const addressedIndices = (device: FakeHidDevice): number[] => [...new Set(device.sent.map((entry) => entry.bytes[0]))];

test("device index is discovered rather than assumed", async () => {
  const { client, device } = createClient({ liveIndex: 0x02 });
  const status = await client.readStatus();

  assert.equal(status.name, "MX Master 4");
  // Slot 1 must be tried and rejected before the mouse is found on slot 2.
  assert.deepEqual(addressedIndices(device).slice(0, 2), [0x01, 0x02]);
  assert.ok(device.sent.slice(2).every((entry) => entry.bytes[0] === 0x02));
});

test("a device on the last receiver slot is still found", async () => {
  const { client, device } = createClient({ liveIndex: 0x06 });
  await client.readStatus();
  assert.deepEqual(addressedIndices(device).slice(0, 6), [0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
});

test("a directly attached device answering on 0xff is found", async () => {
  const { client } = createClient({ liveIndex: 0xff });
  const status = await client.readStatus();
  assert.equal(status.name, "MX Master 4");
});

test("empty slots are rejected without waiting for a timeout", async () => {
  for (const errorStyle of ["hidpp20", "hidpp10"] as const) {
    const { client } = createClient({ liveIndex: 0x02, errorStyle });
    const started = Date.now();
    await client.readStatus();
    // A missing error handler would fall through to the 1.8s ping timeout.
    assert.ok(Date.now() - started < 1000, `${errorStyle} rejection took too long`);
  }
});

test("requests carry a non-zero software id so notifications cannot match", async () => {
  const { client, device } = createClient();
  await client.readStatus();

  assert.ok(device.sent.length > 0);
  for (const { bytes } of device.sent) {
    assert.equal(bytes[2] & 0x0f, SOFTWARE_ID, `function byte 0x${bytes[2].toString(16)} lost the software id`);
  }
});

test("missing features are reported rather than thrown", async () => {
  const { client } = createClient();
  const status = await client.readStatus();

  // An MX Master 4 has no report-rate, onboard-profile or lift-off features.
  assert.equal(status.pollingRateHz, null);
  assert.deepEqual(status.supportedPollingRates, []);
  assert.equal(status.liftOffDistance, null);
  assert.equal(status.ui?.hidePollingCard, true);
  assert.equal(status.ui?.hideLodCard, true);
});

test("DPI is read through 0x2201 when 0x2202 is absent", async () => {
  const { client, device } = createClient({ dpiList: [800, 1600] });
  device.dpi = 1600;
  const status = await client.readStatus();

  assert.equal(status.dpi, 1600);
  assert.equal(status.dpiY, 1600);
  assert.equal(status.supportsSeparateDpiAxes, false);
});

test("the DPI list decodes discrete values and step-encoded ranges", async () => {
  const discrete = await connectClient({ dpiList: [800, 1600, 3200] });
  assert.deepEqual(await discrete.client.getDpiOptions(), [800, 1600, 3200]);

  // 0xE000 | step marks the previous value as a range start; step 50 here.
  const ranged = await connectClient({ dpiList: [100, 0xe000 | 50, 300] });
  assert.deepEqual(await ranged.client.getDpiOptions(), [100, 150, 200, 250, 300]);
});

test("setting DPI writes through 0x2201 and confirms the read-back", async () => {
  const { client, device } = await connectClient({ dpiList: [800, 1600] });
  assert.equal(await client.setDpi(1600), 1600);
  assert.equal(device.dpi, 1600);

  await assert.rejects(() => client.setDpi(9999), /not advertised/);
  await assert.rejects(() => client.setDpi(800, 1600), /one DPI value/);
});

test("wheel mode and SmartShift are read as separate fields", async () => {
  const { client } = createClient({ smartShift: { mode: 1, threshold: 46 } });
  const status = await client.readStatus();

  assert.equal(status.wheelMode, "Freespin");
  assert.equal(status.smartShiftThreshold, 46);
  assert.deepEqual(status.smartShiftRange, { min: 0x0a, max: 0x4b });
});

test("changing the wheel mode preserves the SmartShift threshold", async () => {
  const { client, device } = await connectClient({ smartShift: { mode: 2, threshold: 46 } });
  await client.setWheelMode("Freespin");

  assert.equal(device.smartShift.mode, 1);
  assert.equal(device.smartShift.threshold, 46, "the threshold byte was clobbered");
});

test("changing the SmartShift threshold preserves the wheel mode", async () => {
  const { client, device } = await connectClient({ smartShift: { mode: 2, threshold: 46 } });
  await client.setSmartShiftThreshold(15);

  assert.equal(device.smartShift.threshold, 15);
  assert.equal(device.smartShift.mode, 2, "the wheel mode byte was clobbered");

  // Disabling writes the sentinel rather than a zero threshold.
  await client.setSmartShiftThreshold(null);
  assert.equal(device.smartShift.threshold, 0xff);
});

test("SmartShift thresholds outside the device's advertised range are refused", async () => {
  const { client, device } = await connectClient({ smartShift: { mode: 2, threshold: 46 } });
  await assert.rejects(() => client.setSmartShiftThreshold(9), /between 10 and 75/);
  await assert.rejects(() => client.setSmartShiftThreshold(76), /between 10 and 75/);
  assert.equal(device.smartShift.threshold, 46, "a rejected value must not reach the mouse");
});

test("wheel mode bits are changed one at a time and never set diversion", async () => {
  const { client, device } = await connectClient({ wheelMode: 0x01 });

  await client.setHiResScroll(true);
  assert.equal(device.wheelMode & 0x02, 0x02, "hi-res bit was not set");
  assert.equal(device.wheelMode & 0x01, 0x01, "the pre-existing diversion bit was dropped");

  await client.setInvertScroll(true);
  assert.equal(device.wheelMode & 0x04, 0x04);
  assert.equal(device.wheelMode & 0x02, 0x02, "toggling invert cleared hi-res");

  await client.setHiResScroll(false);
  assert.equal(device.wheelMode & 0x02, 0x00);
  assert.equal(device.wheelMode & 0x04, 0x04, "clearing hi-res cleared invert");
});

test("no wheel write ever turns diversion on", async () => {
  const { client, device } = await connectClient({ wheelMode: 0x00 });
  await client.setHiResScroll(true);
  await client.setInvertScroll(true);
  await client.setHiResScroll(false);
  await client.setInvertScroll(false);

  const wheelWrites = device.sent.filter(({ bytes }) => bytes[1] === FEATURE_INDEX.hiresWheel && bytes[2] === (0x20 | SOFTWARE_ID));
  assert.ok(wheelWrites.length > 0);
  for (const { bytes } of wheelWrites) {
    assert.equal(bytes[3] & 0x01, 0x00, `wrote mode 0x${bytes[3].toString(16)} with the diversion bit set`);
  }
});

test("inverting the thumb wheel preserves the diversion Options+ set", async () => {
  const { client, device } = await connectClient({ thumbWheel: { diverted: 1, inverted: 0 } });
  await client.setThumbWheelInverted(true);

  assert.equal(device.thumbWheel.inverted, 1);
  assert.equal(device.thumbWheel.diverted, 1, "thumb-wheel diversion was cleared");
});

test("thumb-wheel invert support is read from the two-byte capability field", async () => {
  const { client } = createClient();
  const status = await client.readStatus();
  assert.equal(status.supportsThumbWheelInvert, true);
  assert.equal(status.thumbWheelInverted, false);
});

test("static values are read once but changing values keep refreshing", async () => {
  const { client, device } = createClient({ dpiList: [800, 1600] });

  await client.readStatus();
  const firstPass = device.sent.length;
  device.sent.length = 0;

  device.batteryPercent = 42;
  device.dpi = 800;
  const second = await client.readStatus();

  // The static reads are gone from the second pass...
  const requested = (featureIndex: number): boolean => device.sent.some(({ bytes }) => bytes[1] === featureIndex);
  assert.equal(requested(FEATURE_INDEX.deviceName), false, "device name was re-read");
  assert.equal(requested(FEATURE_INDEX.firmware), false, "firmware was re-read");
  assert.equal(requested(0x00), false, "feature indices were re-resolved through root");

  // ...but anything that can actually change still is.
  assert.equal(requested(FEATURE_INDEX.unifiedBattery), true, "battery was cached");
  assert.equal(second.batteryPercent, 42, "a cached battery would report the old value");
  assert.equal(second.dpi, 800, "a cached DPI would report the old value");
  assert.equal(second.name, "MX Master 4", "the cached name must still be reported");
  assert.ok(device.sent.length < firstPass, "the refresh should be cheaper than the first read");
});

test("closing clears caches so a reconnect re-reads the device", async () => {
  const { client, device } = createClient();
  await client.readStatus();
  await client.close();

  device.sent.length = 0;
  await client.readStatus();
  assert.ok(
    device.sent.some(({ bytes }) => bytes[1] === FEATURE_INDEX.deviceName),
    "the name cache survived a close, so a swapped device would report the old name",
  );
});

test("only Logitech devices exposing the HID++ collection are supported", () => {
  const hidpp = { vendorId: 0x046d, collections: [{ usagePage: 0xff00, usage: 0x0001, children: [] }] };
  const keyboard = { vendorId: 0x046d, collections: [{ usagePage: 0x0001, usage: 0x0006, children: [] }] };
  const other = { vendorId: 0x3710, collections: [{ usagePage: 0xff00, usage: 0x0001, children: [] }] };

  assert.equal(LogitechHidppClient.isSupported(hidpp as unknown as HIDDevice), true);
  assert.equal(LogitechHidppClient.isSupported(keyboard as unknown as HIDDevice), false);
  assert.equal(LogitechHidppClient.isSupported(other as unknown as HIDDevice), false);
});
