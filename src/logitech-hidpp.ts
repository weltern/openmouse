import type { MouseStatus } from "./mouse-types";

const LOGITECH_VENDOR_ID = 0x046d;
const HIDPP_USAGE_PAGE = 0xff00;
const HIDPP_SHORT_USAGE = 0x0001;
const SHORT_REPORT_ID = 0x10;
const LONG_REPORT_ID = 0x11;
/**
 * Receivers address each paired device as 1..6; a device attached directly by
 * cable or Bluetooth answers on 0xff. The live index is discovered on open()
 * rather than assumed — a receiver with a keyboard and a mouse paired does not
 * put the mouse on slot 1.
 */
const CANDIDATE_DEVICE_INDICES = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0xff] as const;
/**
 * Responses echo the software id back in the low nibble of the function byte.
 * Device-initiated notifications always carry 0, so using a non-zero id here is
 * what keeps an unsolicited battery or wireless-status event from being mistaken
 * for the reply we are waiting on.
 */
const SOFTWARE_ID = 0x01;

const FEATURE = {
  featureSet: 0x0001,
  deviceName: 0x0005,
  firmware: 0x0003,
  unifiedBattery: 0x1004,
  batteryVoltage: 0x1001,
  adcMeasurement: 0x1f20,
  /** Productivity mice (MX line) expose this; gaming mice expose 0x2202 instead. */
  adjustableDpi: 0x2201,
  smartShiftEnhanced: 0x2111,
  hiresWheel: 0x2121,
  thumbWheel: 0x2150,
  extendedDpi: 0x2202,
  extendedReportRate: 0x8061,
  onboardProfiles: 0x8100,
} as const;

const REPORT_RATE_HZ = [125, 250, 500, 1000, 2000, 4000, 8000] as const;

/**
 * 0x2111 byte 0 — the wheel's ratchet mode, confirmed by pressing the mouse's
 * wheel-mode button and diffing dumps. Byte 1 is a separate SmartShift
 * threshold: 255 disables it, lower values release the ratchet on a gentler
 * flick. Both were established from Logi Options+ writes, not from a spec.
 */
const WHEEL_MODE = { freespin: 1, ratchet: 2 } as const;
const SMART_SHIFT_OFF = 0xff;

/**
 * Bits of the 0x2121 mode byte. Bit 0 routes wheel movement to HID++ instead of
 * normal HID scrolling — never set it here; nothing in this app consumes those
 * notifications, so the wheel would simply stop working.
 */
const WHEEL_MODE_BIT = { divert: 0x01, hiRes: 0x02, invert: 0x04 } as const;

export type LogitechMouseStatus = MouseStatus;

interface BatteryReading {
  percent: number | null;
  state: LogitechMouseStatus["batteryState"];
  voltageMv?: number | null;
}

const BATTERY_VOLTAGE_CURVE = [
  [4186, 100], [4067, 90], [3989, 80], [3922, 70], [3859, 60],
  [3811, 50], [3778, 40], [3751, 30], [3717, 20], [3671, 10],
  [3646, 5], [3579, 2], [3500, 0],
] as const;

interface FeatureInfo {
  index: number;
  version: number;
}

interface DpiConfiguration {
  x: number;
  y: number;
  /** null when the DPI feature carries no lift-off-distance byte (0x2201). */
  lod: number | null;
}

interface DeviceIdentity {
  unitId: string | null;
  modelId: string | null;
  transportIds: Record<string, string>;
}

export class LogitechHidppClient {
  private dpiOptionsCache: number[] | null = null;
  private reportRateFeatureIndex: number | null = null;
  private livePollingRateHz: number | null = null;
  /** Resolved by open(); 0x01 is only the starting guess. */
  private deviceIndex: number = CANDIDATE_DEVICE_INDICES[0];
  private deviceIndexResolved = false;
  /** Root-lookup cache, so a status refresh does not re-resolve every feature. */
  private readonly featureCache = new Map<number, FeatureInfo>();
  private supportsInvertScrollCache: boolean | null = null;
  private smartShiftRangeCache: { min: number; max: number } | null | undefined = undefined;
  /**
   * Values that cannot change while a connection is open. Re-reading these on
   * every five-second refresh was costing about seven round-trips of radio
   * traffic to learn nothing. Battery, DPI, polling rate, profile and wheel
   * state are deliberately absent — those do change, and caching them would
   * freeze the display.
   */
  private nameCache: string | null = null;
  private identityCache: DeviceIdentity | null = null;
  private firmwareCache: string[] | null = null;
  private supportsSeparateDpiAxesCache: boolean | null = null;
  private supportedPollingRatesCache: number[] | null = null;
  private readonly rateChangeWaiters: Array<{ rate: number; resolve: () => void; reject: (reason: Error) => void }> = [];
  private readonly onInputReport = (event: HIDInputReportEvent): void => {
    if (event.reportId !== SHORT_REPORT_ID && event.reportId !== LONG_REPORT_ID) {
      return;
    }

    const report = new Uint8Array(event.data.buffer.slice(event.data.byteOffset, event.data.byteOffset + event.data.byteLength));
    if (report[0] === this.deviceIndex && report[1] === this.reportRateFeatureIndex && report[2] === 0x00 && report[3] === 0x01) {
      const rate = REPORT_RATE_HZ[report[4] ?? -1];
      if (rate) {
        this.livePollingRateHz = rate;
        const matchingRateWaiters = this.rateChangeWaiters.filter((waiter) => waiter.rate === rate);
        this.rateChangeWaiters.splice(0, this.rateChangeWaiters.length, ...this.rateChangeWaiters.filter((waiter) => waiter.rate !== rate));
        matchingRateWaiters.forEach((waiter) => waiter.resolve());
      }
    }
    const matchingIndex = this.waiters.findIndex(
      (waiter) => report[0] === this.deviceIndex && report[1] === waiter.featureIndex && report[2] === waiter.functionByte,
    );
    if (matchingIndex >= 0) {
      this.waiters.splice(matchingIndex, 1)[0].resolve(report);
      return;
    }

    // HID++ can emit a status notification between a write acknowledgement and
    // the matching read response. Leave the pending request in place and wait.
    // 0xff is a HID++ 2.0 error, 0x8f the 1.0 form a receiver returns for an
    // empty pairing slot; both carry the offending feature and function bytes.
    if (report[0] === this.deviceIndex && (report[1] === 0xff || report[1] === 0x8f)) {
      const failedIndex = this.waiters.findIndex(
        (waiter) => report[2] === waiter.featureIndex && report[3] === waiter.functionByte,
      );
      if (failedIndex >= 0) {
        this.waiters.splice(failedIndex, 1)[0].reject(new Error("The mouse rejected that setting."));
      }
    }
  };

  private readonly waiters: Array<{
    featureIndex: number;
    functionByte: number;
    resolve: (report: Uint8Array) => void;
    reject: (reason: Error) => void;
  }> = [];

  readonly device: HIDDevice;

  // A plain assignment rather than a parameter property: Node's strip-only
  // TypeScript mode rejects those, and `npm test` loads this file directly.
  constructor(device: HIDDevice) {
    this.device = device;
  }

  /**
   * Any Logitech device exposing the HID++ vendor collection qualifies: the
   * receiver product id is not fixed (Bolt alone ships several), and a mouse
   * plugged in by cable presents the same collection itself. Whether a usable
   * device actually answers is settled by the index probe in open().
   */
  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== LOGITECH_VENDOR_ID) {
      return false;
    }
    const hasHidppCollection = (collections: readonly HIDCollectionInfo[]): boolean =>
      collections.some((collection) =>
        (collection.usagePage === HIDPP_USAGE_PAGE && collection.usage === HIDPP_SHORT_USAGE)
        || hasHidppCollection(collection.children));
    return hasHidppCollection(device.collections);
  }

  static async requestReceiver(): Promise<LogitechHidppClient | null> {
    if (!navigator.hid) {
      throw new Error("WebHID is unavailable. Use Chrome or Edge on desktop.");
    }

    const devices = await navigator.hid.requestDevice({
      filters: [{
        vendorId: LOGITECH_VENDOR_ID,
        usagePage: HIDPP_USAGE_PAGE,
        usage: HIDPP_SHORT_USAGE,
      }],
    });
    const device = devices[0];
    return device ? new LogitechHidppClient(device) : null;
  }

  static async reconnectAuthorizedReceiver(): Promise<LogitechHidppClient | null> {
    if (!navigator.hid) {
      return null;
    }

    const devices = await navigator.hid.getDevices();
    const device = devices.find((candidate) => this.isSupported(candidate));
    return device ? new LogitechHidppClient(device) : null;
  }

  async readStatus(): Promise<LogitechMouseStatus> {
    await this.open();

    const nameFeature = await this.getFeature(FEATURE.deviceName);
    const firmwareFeature = await this.getFeature(FEATURE.firmware);
    const batteryFeature = await this.getFeature(FEATURE.unifiedBattery);
    const batteryVoltageFeature = await this.getFeature(FEATURE.batteryVoltage);
    const adcMeasurementFeature = await this.getFeature(FEATURE.adcMeasurement);
    const reportRateFeature = await this.getFeature(FEATURE.extendedReportRate);
    const profilesFeature = await this.getFeature(FEATURE.onboardProfiles);

    // HID++ receivers expect one request at a time. Keeping the sequence serial
    // also makes every input report unambiguous to the WebHID event handler.
    const name = this.nameCache ?? (this.nameCache = await this.readName(nameFeature.index));
    const identity = this.identityCache ?? (this.identityCache = await this.readIdentity(firmwareFeature.index));
    const battery = batteryFeature.index
      ? await this.readBattery(batteryFeature.index)
      : batteryVoltageFeature.index
        ? await this.readBatteryVoltage(batteryVoltageFeature.index)
        : adcMeasurementFeature.index
          ? await this.readAdcMeasurement(adcMeasurementFeature.index)
        : { percent: null, state: "Unknown" as const, voltageMv: null };
    if (batteryVoltageFeature.index && battery.voltageMv === undefined) {
      battery.voltageMv = (await this.readBatteryVoltage(batteryVoltageFeature.index)).voltageMv;
    } else if (adcMeasurementFeature.index && battery.voltageMv === undefined) {
      battery.voltageMv = (await this.readAdcMeasurement(adcMeasurementFeature.index)).voltageMv;
    }
    const dpiState = await this.readDpi();
    const supportsSeparateDpiAxes = this.supportsSeparateDpiAxesCache
      ?? (this.supportsSeparateDpiAxesCache = await this.readDpiCapabilities());
    const supportedPollingRates = this.supportedPollingRatesCache
      ?? (this.supportedPollingRatesCache = await this.readSupportedPollingRates(reportRateFeature.index));
    // Productivity mice run at a fixed report rate and expose no rate feature;
    // a null here tells the panel to hide the card rather than invent a number.
    const pollingRateHz = reportRateFeature.index
      ? await this.readPollingRate(reportRateFeature.index)
      : null;
    const profileState = await this.readProfileState(profilesFeature.index);
    const wheel = await this.readWheelState();
    const firmware = this.firmwareCache ?? (this.firmwareCache = await this.readFirmware(firmwareFeature.index));

    return {
      brand: "Logitech",
      name,
      ui: {
        family: "logitech-hidpp",
        hidePollingCard: pollingRateHz === null,
        hideLodLow: true,
        hideLodCard: dpiState.liftOffDistance === null,
        hideUnsupportedPollingRates: true,
      },
      batteryPercent: battery.percent,
      batteryVoltageMv: battery.voltageMv ?? null,
      batteryState: battery.state,
      dpi: dpiState.dpi,
      dpiY: dpiState.dpiY,
      supportsSeparateDpiAxes,
      liftOffDistance: dpiState.liftOffDistance,
      pollingRateHz,
      supportedPollingRates,
      activeProfile: profileState.activeProfile,
      deviceMode: profileState.deviceMode,
      wheelMode: wheel.wheelMode,
      smartShiftThreshold: wheel.smartShiftThreshold,
      smartShiftRange: wheel.smartShiftRange,
      hiResScroll: wheel.hiResScroll,
      invertScroll: wheel.invertScroll,
      supportsInvertScroll: wheel.supportsInvertScroll,
      wheelRatchetEngaged: wheel.wheelRatchetEngaged,
      thumbWheelInverted: wheel.thumbWheelInverted,
      supportsThumbWheelInvert: wheel.supportsThumbWheelInvert,
      unitId: identity.unitId,
      modelId: identity.modelId,
      transportIds: identity.transportIds,
      firmware,
    };
  }

  async close(): Promise<void> {
    this.device.removeEventListener("inputreport", this.onInputReport);
    // A device can come back on a different receiver slot, so the next open()
    // re-probes rather than trusting the index from this session.
    this.deviceIndexResolved = false;
    this.featureCache.clear();
    this.dpiOptionsCache = null;
    this.supportsInvertScrollCache = null;
    this.smartShiftRangeCache = undefined;
    this.nameCache = null;
    this.identityCache = null;
    this.firmwareCache = null;
    this.supportsSeparateDpiAxesCache = null;
    this.supportedPollingRatesCache = null;
    if (this.device.opened) {
      await this.device.close();
    }
  }

  async setPollingRate(pollingRateHz: number): Promise<number> {
    const rateIndex = REPORT_RATE_HZ.indexOf(pollingRateHz as (typeof REPORT_RATE_HZ)[number]);
    if (rateIndex < 0) {
      throw new Error("Unsupported polling rate.");
    }

    await this.ensureHostControl();
    const feature = await this.getFeature(FEATURE.extendedReportRate);
    if (!feature.index) {
      throw new Error("This mouse does not expose report-rate controls.");
    }
    const confirmation = this.waitForRateChange(pollingRateHz);
    await this.request(feature.index, 0x30, rateIndex);
    await confirmation;
    return pollingRateHz;
  }

  /**
   * Which DPI feature this device speaks. Gaming mice carry 0x2202 (per-axis
   * plus lift-off distance); the MX line carries 0x2201 (single value, no LOD).
   */
  private async dpiFeature(): Promise<{ kind: "extended" | "adjustable"; index: number } | null> {
    const extended = await this.getFeature(FEATURE.extendedDpi);
    if (extended.index) return { kind: "extended", index: extended.index };
    const adjustable = await this.getFeature(FEATURE.adjustableDpi);
    if (adjustable.index) return { kind: "adjustable", index: adjustable.index };
    return null;
  }

  /**
   * Both DPI features share one list encoding: discrete 16-bit values, where a
   * value with the top three bits set is a step size joining the previous value
   * to the next one as a range. A zero value terminates the list.
   */
  private static parseDpiList(bytes: number[]): number[] {
    const options: number[] = [];
    for (let index = 0; index + 1 < bytes.length; ) {
      const value = (bytes[index] << 8) | bytes[index + 1];
      if (value === 0) break;
      if (value >> 13 === 0b111) {
        const step = value & 0x1fff;
        const last = ((bytes[index + 2] ?? 0) << 8) | (bytes[index + 3] ?? 0);
        const first = options.at(-1);
        if (!first || !last || last <= first) {
          throw new Error("The mouse returned an invalid DPI range.");
        }
        for (let dpi = first + step; dpi <= last; dpi += step) options.push(dpi);
        index += 4;
      } else {
        options.push(value);
        index += 2;
      }
    }
    return options;
  }

  async getDpiOptions(): Promise<number[]> {
    if (this.dpiOptionsCache) {
      return this.dpiOptionsCache;
    }
    const feature = await this.dpiFeature();
    if (!feature) {
      throw new Error("This mouse does not expose DPI controls.");
    }

    const bytes: number[] = [];
    if (feature.kind === "extended") {
      for (let page = 0; page < 32; page += 1) {
        const reply = await this.request(feature.index, 0x20, 0x00, 0x00, page);
        bytes.push(...reply.slice(6));
        if (bytes.some((value, index) => index > 0 && bytes[index - 1] === 0 && value === 0)) {
          break;
        }
      }
    } else {
      // 0x2201 getSensorDpiList answers for one sensor; byte 0 echoes the index.
      const reply = await this.request(feature.index, 0x10, 0x00);
      bytes.push(...reply.slice(4));
    }

    const options = LogitechHidppClient.parseDpiList(bytes);
    this.dpiOptionsCache = options;
    return options;
  }

  async setDpi(dpi: number, dpiY = dpi): Promise<number> {
    const options = await this.getDpiOptions();
    if (!options.includes(dpi) || !options.includes(dpiY)) {
      throw new Error(`${dpi}/${dpiY} DPI is not advertised by this mouse.`);
    }

    const feature = await this.dpiFeature();
    if (!feature) {
      throw new Error("This mouse does not expose DPI controls.");
    }

    if (feature.kind === "adjustable") {
      if (dpiY !== dpi) {
        throw new Error("This mouse applies one DPI value to both axes.");
      }
      await this.request(feature.index, 0x30, 0x00, dpi >> 8, dpi & 0xff);
      const confirmed = await this.readDpiConfiguration();
      if (confirmed.x !== dpi) {
        throw new Error(`The mouse kept ${confirmed.x} DPI instead of ${dpi} DPI.`);
      }
      return confirmed.x;
    }

    await this.ensureHostControl();
    const current = await this.readDpiConfiguration();
    await this.requestLong(feature.index, 0x60, [
      0x00,
      dpi >> 8,
      dpi & 0xff,
      dpiY >> 8,
      dpiY & 0xff,
      // Always a number on the 0x2202 path; the null case belongs to 0x2201.
      current.lod ?? 0,
    ]);
    const confirmed = await this.readDpiConfiguration();
    if (confirmed.x !== dpi || confirmed.y !== dpiY) {
      throw new Error(`The mouse kept ${confirmed.x}/${confirmed.y} DPI instead of ${dpi}/${dpiY} DPI.`);
    }
    return confirmed.x;
  }

  async setLiftOffDistance(liftOffDistance: NonNullable<LogitechMouseStatus["liftOffDistance"]>): Promise<NonNullable<LogitechMouseStatus["liftOffDistance"]>> {
    if (liftOffDistance === "Low") {
      throw new Error("This mouse does not support a Low lift-off distance.");
    }
    const lod = ({ Low: 0, Medium: 1, High: 2 } as const)[liftOffDistance];
    await this.ensureHostControl();
    const feature = await this.dpiFeature();
    if (feature?.kind !== "extended") {
      throw new Error("This mouse does not expose lift-off-distance controls.");
    }
    const current = await this.readDpiConfiguration();
    await this.requestLong(feature.index, 0x60, [
      0x00,
      current.x >> 8,
      current.x & 0xff,
      current.y >> 8,
      current.y & 0xff,
      lod,
    ]);
    const confirmed = await this.readDpiConfiguration();
    const result = confirmed.lod === 0 ? "Low" : confirmed.lod === 1 ? "Medium" : confirmed.lod === 2 ? "High" : null;
    if (result !== liftOffDistance) {
      throw new Error(`The mouse kept ${result ?? "an unknown"} lift-off distance instead of ${liftOffDistance}.`);
    }
    return result;
  }

  /**
   * Scroll-wheel state. Byte layouts here were confirmed against a real
   * MX Master 4 by toggling the wheel-mode button and diffing two dumps:
   * only 0x2111's mode byte and 0x2121's ratchet byte moved.
   */
  private async readWheelState(): Promise<{
    wheelMode: NonNullable<LogitechMouseStatus["wheelMode"]> | null;
    smartShiftThreshold: number | null;
    smartShiftRange: { min: number; max: number } | null;
    hiResScroll: boolean | null;
    invertScroll: boolean | null;
    wheelRatchetEngaged: boolean | null;
    supportsInvertScroll: boolean;
    thumbWheelInverted: boolean | null;
    supportsThumbWheelInvert: boolean;
  }> {
    const smartShiftFeature = await this.getFeature(FEATURE.smartShiftEnhanced);
    const wheelFeature = await this.getFeature(FEATURE.hiresWheel);
    const thumbWheel = await this.readThumbWheelState();

    let wheelMode: NonNullable<LogitechMouseStatus["wheelMode"]> | null = null;
    let smartShiftThreshold: number | null = null;
    let smartShiftRange: { min: number; max: number } | null = null;
    if (smartShiftFeature.index) {
      const reply = await this.request(smartShiftFeature.index, 0x10);
      wheelMode = reply[3] === WHEEL_MODE.freespin
        ? "Freespin"
        : reply[3] === WHEEL_MODE.ratchet ? "Ratchet" : null;
      smartShiftThreshold = reply[4] ?? null;
      smartShiftRange = await this.readSmartShiftRange(smartShiftFeature.index);
    }

    if (!wheelFeature.index) {
      return {
        wheelMode,
        smartShiftThreshold,
        smartShiftRange,
        hiResScroll: null,
        invertScroll: null,
        wheelRatchetEngaged: null,
        supportsInvertScroll: false,
        ...thumbWheel,
      };
    }

    // getCapabilities: [multiplier, flags, ...]. Flag bit 3 is invert support.
    // Static for the life of the device, so it is read once rather than on
    // every five-second refresh.
    if (this.supportsInvertScrollCache === null) {
      const capabilities = await this.request(wheelFeature.index, 0x00);
      this.supportsInvertScrollCache = ((capabilities[4] ?? 0) & 0x08) !== 0;
    }
    const supportsInvertScroll = this.supportsInvertScrollCache;

    const mode = (await this.request(wheelFeature.index, 0x10))[3] ?? 0;
    const ratchet = await this.request(wheelFeature.index, 0x30);

    return {
      wheelMode,
      smartShiftThreshold,
      smartShiftRange,
      hiResScroll: (mode & WHEEL_MODE_BIT.hiRes) !== 0,
      invertScroll: (mode & WHEEL_MODE_BIT.invert) !== 0,
      wheelRatchetEngaged: (ratchet[3] ?? 0) === 1,
      supportsInvertScroll,
      ...thumbWheel,
    };
  }

  /**
   * 0x2111 getCapabilities answers `01 0A 4B 0E` on an MX Master 4 — bytes 1
   * and 2 read as a 10..75 threshold range, which both observed Logi Options+
   * writes (15 and 46) fall inside. Inferred, not specified: the slider clamps
   * to it and every write is confirmed by reading the value back.
   */
  private async readSmartShiftRange(featureIndex: number): Promise<{ min: number; max: number } | null> {
    if (this.smartShiftRangeCache !== undefined) return this.smartShiftRangeCache;
    try {
      const reply = await this.request(featureIndex, 0x00);
      const min = reply[4] ?? 0;
      const max = reply[5] ?? 0;
      this.smartShiftRangeCache = max > min ? { min, max } : null;
    } catch {
      this.smartShiftRangeCache = null;
    }
    return this.smartShiftRangeCache;
  }

  private async readThumbWheelState(): Promise<{ thumbWheelInverted: boolean | null; supportsThumbWheelInvert: boolean }> {
    const feature = await this.getFeature(FEATURE.thumbWheel);
    if (!feature.index) return { thumbWheelInverted: null, supportsThumbWheelInvert: false };

    // getThumbwheelInfo: [nativeRes(2), divertedRes(2), capabilities(2), ...].
    // Capability bit 0 is invert support — read as two bytes because an
    // MX Master 4 answers 0x0003 there and demonstrably honours inversion.
    const info = await this.request(feature.index, 0x00);
    const capabilities = ((info[7] ?? 0) << 8) | (info[8] ?? 0);
    const status = await this.request(feature.index, 0x10);
    return {
      thumbWheelInverted: (status[4] ?? 0) !== 0,
      supportsThumbWheelInvert: (capabilities & 0x01) !== 0,
    };
  }

  /** Switches the wheel between free-spinning and ratcheted, preserving SmartShift. */
  async setWheelMode(
    wheelMode: NonNullable<LogitechMouseStatus["wheelMode"]>,
  ): Promise<NonNullable<LogitechMouseStatus["wheelMode"]>> {
    const mode = wheelMode === "Freespin" ? WHEEL_MODE.freespin : WHEEL_MODE.ratchet;
    const confirmed = await this.writeRatchetControl({ mode });
    if (confirmed.mode !== mode) {
      throw new Error(`The mouse kept the wheel ${confirmed.mode === WHEEL_MODE.freespin ? "free-spinning" : "ratcheted"}.`);
    }
    return wheelMode;
  }

  /**
   * Sets the SmartShift threshold, or disables SmartShift when passed null.
   * The wheel's ratchet mode is preserved either way.
   */
  async setSmartShiftThreshold(threshold: number | null): Promise<number> {
    const value = threshold === null ? SMART_SHIFT_OFF : Math.round(threshold);
    if (value !== SMART_SHIFT_OFF) {
      const range = await this.readSmartShiftRange((await this.getFeature(FEATURE.smartShiftEnhanced)).index);
      if (range && (value < range.min || value > range.max)) {
        throw new Error(`SmartShift threshold must be between ${range.min} and ${range.max}.`);
      }
    }

    const confirmed = await this.writeRatchetControl({ threshold: value });
    if (confirmed.threshold !== value) {
      throw new Error(`The mouse kept a SmartShift threshold of ${confirmed.threshold}.`);
    }
    return confirmed.threshold;
  }

  /**
   * 0x2111 writes carry both bytes, so each setter reads the pair first and
   * changes only its own field. Returns what the mouse reports afterwards.
   */
  private async writeRatchetControl(
    change: { mode?: number; threshold?: number },
  ): Promise<{ mode: number; threshold: number }> {
    const feature = await this.getFeature(FEATURE.smartShiftEnhanced);
    if (!feature.index) {
      throw new Error("This mouse does not expose SmartShift controls.");
    }

    const current = await this.request(feature.index, 0x10);
    const mode = change.mode ?? current[3] ?? WHEEL_MODE.ratchet;
    const threshold = change.threshold ?? current[4] ?? SMART_SHIFT_OFF;
    await this.request(feature.index, 0x20, mode, threshold);

    const confirmed = await this.request(feature.index, 0x10);
    return { mode: confirmed[3] ?? 0, threshold: confirmed[4] ?? 0 };
  }

  /**
   * Inverts thumb-wheel direction. Byte 0 of the reporting write is the
   * diversion flag — Logi Options+ sets it to implement horizontal scrolling,
   * so it is read first and carried through rather than overwritten.
   */
  async setThumbWheelInverted(inverted: boolean): Promise<boolean> {
    const feature = await this.getFeature(FEATURE.thumbWheel);
    if (!feature.index) {
      throw new Error("This mouse does not expose thumb-wheel controls.");
    }

    const current = await this.request(feature.index, 0x10);
    await this.request(feature.index, 0x20, current[3] ?? 0, inverted ? 0x01 : 0x00);

    const confirmed = (await this.request(feature.index, 0x10))[4] ?? 0;
    if ((confirmed !== 0) !== inverted) {
      throw new Error(`The mouse did not ${inverted ? "invert" : "restore"} the thumb-wheel direction.`);
    }
    return inverted;
  }

  async setHiResScroll(enabled: boolean): Promise<boolean> {
    return await this.setWheelModeBit(WHEEL_MODE_BIT.hiRes, enabled, "high-resolution scrolling");
  }

  async setInvertScroll(enabled: boolean): Promise<boolean> {
    return await this.setWheelModeBit(WHEEL_MODE_BIT.invert, enabled, "inverted scrolling");
  }

  /**
   * Flips one bit of the 0x2121 mode byte, preserving the rest. Bit 0 diverts
   * wheel events to HID++ notifications, which would stop the wheel scrolling
   * normally — it is carried through untouched and never exposed as a control.
   */
  private async setWheelModeBit(bit: number, enabled: boolean, label: string): Promise<boolean> {
    const feature = await this.getFeature(FEATURE.hiresWheel);
    if (!feature.index) {
      throw new Error(`This mouse does not expose ${label} controls.`);
    }

    const current = (await this.request(feature.index, 0x10))[3] ?? 0;
    const next = enabled ? current | bit : current & ~bit & 0xff;
    await this.request(feature.index, 0x20, next);

    const confirmed = (await this.request(feature.index, 0x10))[3] ?? 0;
    if (((confirmed & bit) !== 0) !== enabled) {
      throw new Error(`The mouse did not ${enabled ? "enable" : "disable"} ${label}.`);
    }
    return enabled;
  }

  private async open(): Promise<void> {
    if (!this.device.opened) {
      await this.device.open();
    }
    this.device.addEventListener("inputreport", this.onInputReport);
    await this.resolveDeviceIndex();
  }

  /**
   * Finds the index that answers a root ping. Behind a receiver this is the
   * paired slot; for a directly attached device it is 0xff. Cached after the
   * first success so reconnects and refreshes stay cheap.
   */
  private async resolveDeviceIndex(): Promise<void> {
    if (this.deviceIndexResolved) return;

    for (const candidate of CANDIDATE_DEVICE_INDICES) {
      this.deviceIndex = candidate;
      try {
        // Root function 0x10 is getProtocolVersion; any reply proves the slot is live.
        await this.send(0x00, 0x10, [0x00, 0x00, 0x5a], 1800);
        this.deviceIndexResolved = true;
        this.featureCache.clear();
        return;
      } catch {
        // An empty slot answers with a HID++ error, which surfaces here as a
        // rejection. Keep probing the remaining indices.
      }
    }

    this.deviceIndex = CANDIDATE_DEVICE_INDICES[0];
    throw new Error(
      "No Logitech device answered on this receiver. Wake the mouse by moving it or clicking, then try again.",
    );
  }

  private async getFeature(featureId: number): Promise<FeatureInfo> {
    const cached = this.featureCache.get(featureId);
    if (cached) return cached;

    const reply = await this.request(0x00, 0x00, featureId >> 8, featureId & 0xff);
    const feature = { index: reply[3] ?? 0, version: reply[6] ?? 0 };
    this.featureCache.set(featureId, feature);
    if (featureId === FEATURE.extendedReportRate) this.reportRateFeatureIndex = feature.index;
    return feature;
  }

  private async readName(featureIndex: number): Promise<string> {
    const header = await this.request(featureIndex, 0x00);
    const nameLength = header[3] ?? 0;
    const fragments: number[] = [];

    for (let offset = 0; offset < nameLength; offset += 16) {
      const reply = await this.request(featureIndex, 0x10, offset);
      fragments.push(...reply.slice(3, 3 + Math.min(16, nameLength - offset)));
    }

    return new TextDecoder().decode(new Uint8Array(fragments));
  }

  private async readBattery(featureIndex: number): Promise<BatteryReading> {
    const reply = await this.request(featureIndex, 0x10);
    const percentage = reply[3];
    const state = ({
      0x00: "Discharging",
      0x01: "Charging",
      0x02: "Almost full",
      0x03: "Full",
      0x04: "Charging slowly",
    } as const)[reply[5] ?? -1] ?? "Unknown";
    return { percent: percentage <= 100 ? percentage : null, state };
  }

  private async readBatteryVoltage(featureIndex: number): Promise<BatteryReading> {
    const reply = await this.request(featureIndex, 0x00);
    const voltageMv = ((reply[3] ?? 0) << 8) | (reply[4] ?? 0);
    const flags = reply[5] ?? 0;
    const charging = (flags & 0x80) !== 0;
    const full = charging && (flags & 0x03) === 0x02;
    const state: BatteryReading["state"] = full
      ? "Full"
      : (flags & 0x10) !== 0
        ? "Charging slowly"
        : charging
          ? "Charging"
          : "Discharging";
    return {
      percent: voltageMv ? this.estimateBatteryPercent(voltageMv) : null,
      state,
      voltageMv: voltageMv || null,
    };
  }

  private async readAdcMeasurement(featureIndex: number): Promise<BatteryReading> {
    const reply = await this.request(featureIndex, 0x00);
    const voltageMv = ((reply[3] ?? 0) << 8) | (reply[4] ?? 0);
    const flags = reply[5] ?? 0;
    if ((flags & 0x01) === 0 || voltageMv === 0) {
      return { percent: null, state: "Unknown", voltageMv: null };
    }
    return {
      percent: this.estimateBatteryPercent(voltageMv),
      state: (flags & 0x02) !== 0 ? "Charging" : "Discharging",
      voltageMv,
    };
  }

  private estimateBatteryPercent(voltageMv: number): number {
    if (voltageMv >= BATTERY_VOLTAGE_CURVE[0][0]) return 100;
    if (voltageMv <= BATTERY_VOLTAGE_CURVE.at(-1)![0]) return 0;
    for (let index = 0; index < BATTERY_VOLTAGE_CURVE.length - 1; index += 1) {
      const [highMv, highPercent] = BATTERY_VOLTAGE_CURVE[index];
      const [lowMv, lowPercent] = BATTERY_VOLTAGE_CURVE[index + 1];
      if (voltageMv >= lowMv) {
        return Math.round(lowPercent + ((highPercent - lowPercent) * (voltageMv - lowMv)) / (highMv - lowMv));
      }
    }
    return 0;
  }

  private async readDpi(): Promise<{ dpi: number; dpiY: number; liftOffDistance: LogitechMouseStatus["liftOffDistance"] }> {
    const feature = await this.dpiFeature();
    if (!feature) {
      throw new Error("This Logitech mouse does not expose DPI controls.");
    }

    const configuration = await this.readDpiConfiguration();
    // 0x2201 carries no lift-off distance, which readDpiConfiguration reports as null.
    const liftOffDistance = configuration.lod === null
      ? null
      : configuration.lod === 0 ? "Low" : configuration.lod === 1 ? "Medium" : configuration.lod === 2 ? "High" : null;
    return { dpi: configuration.x, dpiY: configuration.y, liftOffDistance };
  }

  private async readDpiCapabilities(): Promise<boolean> {
    const feature = await this.dpiFeature();
    // 0x2201 addresses one sensor with a single value, so X and Y never diverge.
    if (!feature || feature.kind !== "extended") return false;
    const reply = await this.request(feature.index, 0x10, 0x00);
    return ((reply[5] ?? 0) & 0x01) !== 0;
  }

  private async readDpiConfiguration(): Promise<DpiConfiguration> {
    const feature = await this.dpiFeature();
    if (!feature) {
      throw new Error("This Logitech mouse does not expose DPI controls.");
    }

    if (feature.kind === "adjustable") {
      // getSensorDpi: [sensorIndex, dpi(2), defaultDpi(2)]
      const reply = await this.request(feature.index, 0x20, 0x00);
      const dpi = ((reply[4] ?? 0) << 8) | (reply[5] ?? 0);
      return { x: dpi, y: dpi, lod: null };
    }

    const reply = await this.request(feature.index, 0x50);
    const x = ((reply[4] ?? 0) << 8) | (reply[5] ?? 0);
    const y = ((reply[8] ?? 0) << 8) | (reply[9] ?? 0);
    return { x, y, lod: reply[12] ?? 0 };
  }

  private async readSupportedPollingRates(featureIndex: number): Promise<number[]> {
    if (!featureIndex) return [];
    const reply = await this.request(featureIndex, 0x10);
    const flags = ((reply[3] ?? 0) << 8) | (reply[4] ?? 0);
    return REPORT_RATE_HZ.filter((_rate, index) => (flags & (1 << index)) !== 0);
  }

  private async readPollingRate(featureIndex: number): Promise<number> {
    if (!featureIndex) {
      throw new Error("This Logitech mouse does not expose extended report-rate controls.");
    }

    const reply = await this.request(featureIndex, 0x20);
    const rate = REPORT_RATE_HZ[reply[3] ?? -1];
    if (!rate) {
      throw new Error("The mouse returned an unknown report-rate value.");
    }
    return this.livePollingRateHz ?? rate;
  }

  private waitForRateChange(rate: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.rateChangeWaiters.findIndex((waiter) => waiter.reject === reject);
        if (index >= 0) this.rateChangeWaiters.splice(index, 1);
        reject(new Error("The mouse acknowledged the rate write but did not confirm the new active rate."));
      }, 6000);
      this.rateChangeWaiters.push({
        rate,
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject,
      });
    });
  }

  private async readProfileState(featureIndex: number): Promise<{
    activeProfile: number | null;
    deviceMode: NonNullable<LogitechMouseStatus["deviceMode"]>;
  }> {
    if (!featureIndex) {
      return { activeProfile: null, deviceMode: "Unknown" };
    }

    const mode = await this.request(featureIndex, 0x20);
    if (mode[3] !== 0x01) {
      return { activeProfile: null, deviceMode: mode[3] === 0x02 ? "Host" : "Unknown" };
    }

    const active = await this.request(featureIndex, 0x40);
    return {
      activeProfile: ((active[3] ?? 0) << 8) | (active[4] ?? 0),
      deviceMode: "Onboard",
    };
  }

  private async readIdentity(featureIndex: number): Promise<DeviceIdentity> {
    if (!featureIndex) return { unitId: null, modelId: null, transportIds: {} };
    const reply = await this.request(featureIndex, 0x00);
    const payload = reply.slice(3);
    if (payload.length < 13) return { unitId: null, modelId: null, transportIds: {} };
    const hex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
    const unitId = hex(payload.slice(1, 5));
    const modelBytes = payload.slice(7, 13);
    const modelId = hex(modelBytes);
    const transportIds: Record<string, string> = {};
    let offset = 0;
    for (const [name, flag] of [["Bluetooth", 0x01], ["Bluetooth LE", 0x02], ["Wireless", 0x04], ["USB", 0x08]] as const) {
      if ((payload[6] & flag) !== 0 && offset + 2 <= modelBytes.length) {
        transportIds[name] = hex(modelBytes.slice(offset, offset + 2));
        offset += 2;
      }
    }
    return { unitId: unitId === "00000000" ? null : unitId, modelId, transportIds };
  }

  private async ensureHostControl(): Promise<void> {
    const profiles = await this.getFeature(FEATURE.onboardProfiles);
    if (!profiles.index) return;
    const mode = await this.request(profiles.index, 0x20);
    if (mode[3] === 0x02) return;
    await this.request(profiles.index, 0x10, 0x02);
    const confirmed = await this.request(profiles.index, 0x20);
    if (confirmed[3] !== 0x02) {
      throw new Error("The mouse did not enter host-control mode.");
    }
  }

  private async readFirmware(featureIndex: number): Promise<string[]> {
    if (!featureIndex) {
      return [];
    }

    const countReply = await this.request(featureIndex, 0x00);
    const count = countReply[3] ?? 0;
    const decoder = new TextDecoder();
    const firmware: string[] = [];

    for (let item = 0; item < count; item += 1) {
      const reply = await this.request(featureIndex, 0x10, item);
      const name = decoder.decode(reply.slice(4, 7)).replace(/\0/g, "");
      const major = (reply[7] ?? 0).toString(16).padStart(2, "0").toUpperCase();
      const minor = (reply[8] ?? 0).toString(16).padStart(2, "0").toUpperCase();
      firmware.push(`${name} ${major}.${minor}`);
    }
    return firmware;
  }

  private async request(featureIndex: number, functionId: number, ...parameters: number[]): Promise<Uint8Array> {
    if (parameters.length > 3) {
      throw new Error("This WebHID client only sends short, read-only HID++ requests.");
    }
    return await this.send(featureIndex, functionId, parameters);
  }

  private async requestLong(featureIndex: number, functionId: number, parameters: number[]): Promise<Uint8Array> {
    if (parameters.length > 16) {
      throw new Error("HID++ long requests support at most 16 parameter bytes.");
    }
    return await this.send(featureIndex, functionId, parameters, 6000, true);
  }

  private async send(
    featureIndex: number,
    functionId: number,
    parameters: number[],
    timeoutMs = 6000,
    forceLong = false,
  ): Promise<Uint8Array> {
    const long = forceLong || parameters.length > 3;
    const functionByte = functionId | SOFTWARE_ID;
    const report = new Uint8Array(long ? 19 : 6);
    report[0] = this.deviceIndex;
    report[1] = featureIndex;
    report[2] = functionByte;
    report.set(parameters, 3);

    const response = this.waitForResponse(featureIndex, functionByte, timeoutMs);
    // Keep the timeout rejection observed even when sendReport itself fails
    // (for example, when a browser selected a protected mouse collection).
    // The original sendReport error is then shown by the control panel.
    void response.catch(() => undefined);
    await this.device.sendReport(long ? LONG_REPORT_ID : SHORT_REPORT_ID, report);
    return await response;
  }

  private waitForResponse(featureIndex: number, functionByte: number, timeoutMs = 6000): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.reject === reject);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(new Error("The mouse did not answer. Move it or click a button, then try again."));
      }, timeoutMs);

      this.waiters.push({
        featureIndex,
        functionByte,
        resolve: (report) => {
          clearTimeout(timeout);
          resolve(report);
        },
        reject,
      });
    });
  }
}
