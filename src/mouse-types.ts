/**
 * Optional UI policy from a driver (used by control.ts).
 * Drivers added in a PR should set only the flags they need so the shell
 * stays free of brand-specific branching.
 */
export interface MouseUiHints {
  /** Stable driver id, e.g. "egg-we". */
  family?: string;
  /** When false, core settings grid stays hidden. Default true. */
  settingsReady?: boolean;
  /** Hide 0.7 mm LOD option. */
  hideLodLow?: boolean;
  /** Hide the whole lift-off-distance card (device exposes no LOD control). */
  hideLodCard?: boolean;
  /** Hide the whole polling-rate card (device runs at a fixed report rate). */
  hidePollingCard?: boolean;
  /** Hide poll rates not listed in supportedPollingRates. */
  hideUnsupportedPollingRates?: boolean;
  /** Hide Motion Sync / angle snap / ripple card. */
  hideProcessingCard?: boolean;
  /** Always show battery column (even wired with null %). */
  forceShowBattery?: boolean;
  /** Override the polling-rate footnote. */
  pollingNote?: string;
  /** Sidebar name before first status read. */
  defaultDisplayName?: string;
}

export interface MouseStatus {
  brand: "Logitech" | "Pulsar" | "Endgame Gear" | "WLMouse";
  name: string;
  /** Driver-supplied UI policy (optional; keeps control.ts brand-agnostic). */
  ui?: MouseUiHints;
  batteryPercent: number | null;
  batteryVoltageMv?: number | null;
  batteryState: "Charging" | "Charging slowly" | "Almost full" | "Full" | "Discharging" | "Unknown";
  dpi: number;
  dpiY?: number;
  supportsSeparateDpiAxes?: boolean;
  /** null when the device exposes no report-rate feature (e.g. Logitech MX line). */
  pollingRateHz: number | null;
  supportedPollingRates?: number[];
  activeProfile: number | null;
  deviceMode?: "Onboard" | "Host" | "Unknown";
  unitId?: string | null;
  modelId?: string | null;
  transportIds?: Record<string, string>;
  connectionType?: "Wired" | "Wireless";
  connectionDetail?: string;
  dongleLedEnabled?: boolean | null;
  signalStrength?: number | null;
  motionSync?: boolean | null;
  debounceMs?: number | null;
  sleepTimeout?: number | null;
  /**
   * Logitech 0x2111 byte 0 — the wheel's current ratchet mode, the same thing
   * the physical wheel-mode button toggles. Not SmartShift on/off.
   */
  wheelMode?: "Freespin" | "Ratchet" | null;
  /**
   * Logitech 0x2111 byte 1. A threshold of 255 disables SmartShift; any lower
   * value enables it and sets how gentle a flick releases the ratchet.
   */
  smartShiftThreshold?: number | null;
  smartShiftRange?: { min: number; max: number } | null;
  thumbWheelInverted?: boolean | null;
  supportsThumbWheelInvert?: boolean;
  /** Logitech 0x2121: high-resolution (smooth) scrolling. */
  hiResScroll?: boolean | null;
  invertScroll?: boolean | null;
  supportsInvertScroll?: boolean;
  /** Live read of whether the wheel is currently ratcheted. */
  wheelRatchetEngaged?: boolean | null;
  angleSnapping?: boolean | null;
  rippleControl?: boolean | null;
  slamclickFilter?: boolean | null;
  motionJitterFilter?: boolean | null;
  leftSpdtMode?: "Off" | "GX Safe" | "GX Speed" | null;
  rightSpdtMode?: "Off" | "GX Safe" | "GX Speed" | null;
  eggCpiLevels?: number;
  eggCpiStages?: Array<{ x: number; y: number }>;
  eggPollingDivider?: number;
  eggMulticlickFilters?: number[];
  eggButtonMappings?: string[];
  performanceMode?: boolean | null;
  angleTuning?: number | null;
  wheelAcceleration?: boolean | null;
  lowBatteryWarning?: number | null;
  remoteLedMode1?: number | null;
  remoteLedMode2?: number | null;
  dpiLedMode?: number | null;
  dpiLedBrightness?: number | null;
  dpiLedSpeed?: number | null;
  liftOffDistance: "Low" | "Medium" | "High" | null;
  firmware: string[];
}
