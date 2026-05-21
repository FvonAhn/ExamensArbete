import { writable, get } from "svelte/store";
import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { Dialog } from "@capacitor/dialog";
import {
  buildPositionDtoOrNull,
  cancelActiveLogsReconnectReapply,
  externalGpsSourceAvailable,
  markActiveLogsForReconnectReapply,
  reapplyActiveLogsForCurrentMonitoringSession,
  telemetryValuesMonitored,
} from "../../stores/monitoring";
import { currentActiveVehicle } from "../../stores/vehicles";
import { demoMode } from "../../stores/stores";
import { frameRateData } from "../../stores/monitoring-framerate";
import { gpsMonitoringEnabled } from "../../stores/monitoring-gps";

import { logTraceX, logWarning, logWithTag } from "../../stores/diagnostics";
import { getModuleId } from "../../stores/devices";

import {
  broadcastConnectionState,
  startTelemetrySender,
  stopTelemetrySender,
  sendTelemetryMetadataFromLogs,
  sendTelemetryFromLogs,
} from "./telemetry-sender";
import {
  BackgroundBroadcast,
  type BackgroundBroadcastPermissionState,
} from "./background-broadcast";

import {
  getAccessTokenCached,
  getAccessTokenNew,
  getBaseUrlMobileApi,
} from "../../stores/auth";

export const isMonitoring = writable(false);
export const shouldResumeAfterBleReconnect = writable(false);

const FALLBACK_DEVICE_ID = "demo-device";

// Development-only toggles
const DEV_USE_FALLBACK_DEVICE = false;
const DEV_USE_LOCAL_GATEWAY = false;
const ANDROID_BACKGROUND_BROADCAST_ENABLED = true;
const ANDROID_SYNC_FRAME_MIN_INTERVAL_MS = 250;

let backgroundBroadcastListenerHandle: PluginListenerHandle | null = null;

export type BackgroundBroadcastDebugState = {
  enabled: boolean;
  platform: string;
  state: string;
  lastError: string | null;
  lastFrameSentAtMs: number | null;
  lastLocationAtMs: number | null;
  lastMonitoringValueAtMs: number | null;
  permissions: BackgroundBroadcastPermissionState | null;
};

const DEBUG_STATE_OFF: BackgroundBroadcastDebugState = {
  enabled: false,
  platform: Capacitor.getPlatform(),
  state: "idle",
  lastError: null,
  lastFrameSentAtMs: null,
  lastLocationAtMs: null,
  lastMonitoringValueAtMs: null,
  permissions: null,
};

export const backgroundBroadcastDebugState = writable<BackgroundBroadcastDebugState>(
  DEBUG_STATE_OFF,
);

let cached_DeviceId: string | null = null;
async function resolveDeviceId(): Promise<string> {
  if (DEV_USE_FALLBACK_DEVICE) return FALLBACK_DEVICE_ID;
  if (!cached_DeviceId) cached_DeviceId = await getModuleId();
  return cached_DeviceId?.toUpperCase?.() ?? FALLBACK_DEVICE_ID;
}

function resolveHubUrl(baseUrl: string): string {
  return !DEV_USE_LOCAL_GATEWAY
    ? `${baseUrl}/live-telemetry-broadcast`
    : "https://localhost:7282/liveTelemetryHub";
}

function accessTokenFactoryFor(baseUrl: string) {
  return async () => {
    let token = getAccessTokenCached(baseUrl);
    if (!token || token.length < 10) token = await getAccessTokenNew(baseUrl);
    return token;
  };
}

function isAndroidBackgroundBroadcastEnabled(): boolean {
  return ANDROID_BACKGROUND_BROADCAST_ENABLED && Capacitor.getPlatform() === "android";
}

function normalizeBroadcastState(
  state: string | undefined,
): "idle" | "connecting" | "connected" | "reconnecting" | "disconnected" {
  switch (state) {
    case "connecting":
    case "connected":
    case "reconnecting":
    case "disconnected":
      return state;
    default:
      return "idle";
  }
}

async function ensureBackgroundBroadcastListener(): Promise<void> {
  if (!isAndroidBackgroundBroadcastEnabled()) return;
  if (backgroundBroadcastListenerHandle) return;

  backgroundBroadcastListenerHandle = await BackgroundBroadcast.addListener(
    "stateChanged",
    (state) => {
      const shouldIgnoreLateStateChange =
        !get(isMonitoring) && !get(shouldResumeAfterBleReconnect);

      if (shouldIgnoreLateStateChange) {
        broadcastConnectionState.set("idle");
      } else {
        broadcastConnectionState.set(normalizeBroadcastState(state.state));
      }

      backgroundBroadcastDebugState.update((current) => ({
        ...current,
        enabled: true,
        state: state.state ?? current.state,
        lastError: state.lastError ?? null,
        lastFrameSentAtMs: state.lastFrameSentAtMs ?? null,
        lastLocationAtMs: state.lastLocationAtMs ?? null,
        lastMonitoringValueAtMs: state.lastMonitoringValueAtMs ?? null,
      }));

      if (state.lastError && !shouldIgnoreLateStateChange) {
        logWarning(`Background broadcast state: ${state.state} (${state.lastError})`);
      }
    },
  );
}

function setBackgroundBroadcastDebugState(
  partial: Partial<BackgroundBroadcastDebugState>,
): void {
  backgroundBroadcastDebugState.update((current) => ({
    ...current,
    ...partial,
    enabled: isAndroidBackgroundBroadcastEnabled(),
    platform: Capacitor.getPlatform(),
  }));
}

export async function refreshBackgroundBroadcastDebugState(): Promise<void> {
  if (!isAndroidBackgroundBroadcastEnabled()) {
    backgroundBroadcastDebugState.set({
      ...DEBUG_STATE_OFF,
      platform: Capacitor.getPlatform(),
    });
    return;
  }

  await ensureBackgroundBroadcastListener();
  const [state, permissions] = await Promise.all([
    BackgroundBroadcast.getState(),
    BackgroundBroadcast.getPermissionStatus(),
  ]);

  backgroundBroadcastDebugState.set({
    enabled: true,
    platform: Capacitor.getPlatform(),
    state: state.state ?? "idle",
    lastError: state.lastError ?? null,
    lastFrameSentAtMs: state.lastFrameSentAtMs ?? null,
    lastLocationAtMs: state.lastLocationAtMs ?? null,
    lastMonitoringValueAtMs: state.lastMonitoringValueAtMs ?? null,
    permissions,
  });
}

async function ensureAndroidBackgroundBroadcastPermissions(): Promise<boolean> {
  if (!isAndroidBackgroundBroadcastEnabled()) return true;

  await ensureBackgroundBroadcastListener();

  try {
    const { Geolocation } = await import("@capacitor/geolocation");
    await Geolocation.requestPermissions();
  } catch {
    // Keep permission flow best-effort and rely on native status checks below.
  }

  await refreshBackgroundBroadcastDebugState();
  const permissions = get(backgroundBroadcastDebugState).permissions;
  if (!permissions?.fineLocationGranted) {
    await Dialog.alert({
      title: "Location permission required",
      message:
        "Foreground location permission is required before Android background broadcast can start.",
    });
    return false;
  }

  const missing: string[] = [];
  if (!permissions.backgroundLocationGranted) {
    missing.push("Background location");
  }
  if (!permissions.notificationsGranted) {
    missing.push("Notifications");
  }

  if (missing.length === 0) {
    return true;
  }

  const { value } = await Dialog.confirm({
    title: "Android permissions required",
    message:
      `Background broadcast needs ${missing.join(" and ")} enabled. Open app settings now?`,
  });

  if (value) {
    await BackgroundBroadcast.openAppSettings();
  }

  return false;
}

// ----------------------------------------------------
// Broadcast logs (vehicle and GPS telemetry are already merged in monitoring.ts)
// ----------------------------------------------------
function buildBroadcastLogs(): any[] {
  return get(telemetryValuesMonitored) ?? [];
}

function buildBroadcastLogSnapshot(logs: any[]): any[] {
  return (logs ?? []).map((log) => ({
    key: getPrimaryKey(log),
    logId: typeof log?.id === "number" ? log.id : null,
    module: log?.module ?? "",
    name: log?.name ?? "",
    unit: log?.unit ?? "",
    value: log?.value ?? null,
    valueStr: log?.valueStr ?? null,
    min: typeof log?.min === "number" ? log.min : null,
    max: typeof log?.max === "number" ? log.max : null,
  }));
}

function buildAndroidFrameValues(logs: any[]): Array<{ key: string; value: number }> {
  return (logs ?? [])
    .map((log) => {
      const value = Number(log?.value ?? log?.valueStr);
      if (!Number.isFinite(value)) return null;
      return {
        key: getPrimaryKey(log),
        value,
      };
    })
    .filter((log): log is { key: string; value: number } => log !== null);
}

function shouldAllowNativeGpsFallback(): boolean {
  return !get(externalGpsSourceAvailable) && get(gpsMonitoringEnabled);
}

function getBackgroundNotificationText(): string {
  return get(gpsMonitoringEnabled)
    ? "Streaming telemetry and GPS"
    : "Streaming telemetry";
}

function getSourceFrameRateHz(): number | null {
  if (get(demoMode)) {
    return null;
  }

  const fr = get(frameRateData);
  if (typeof fr?.frameRate !== "number" || !Number.isFinite(fr.frameRate) || fr.frameRate <= 0) {
    return null;
  }

  return Math.min(fr.frameRate, 25);
}

// ----------------------------------------------------
// Resend metadata when the schema or primary keys change
// ----------------------------------------------------
let lastMetaSignature = "";
let metaResendTimer: ReturnType<typeof setTimeout> | null = null;
let lastBroadcastFrameTraceAtMs = 0;
const BROADCAST_FRAME_TRACE_INTERVAL_MS = 10000;
let lastAndroidSyncFrameAtMs = 0;
let androidSyncFrameTimer: ReturnType<typeof setTimeout> | null = null;
let pendingAndroidSyncFrame: {
  valuesJson: string;
  positionJson: string;
  sourceFrameRateHz: number | null;
  allowNativeGpsFallback: boolean;
} | null = null;
let androidSyncFrameInFlight = false;

function getPrimaryKey(log: any): string {
  return (
    log?.primaryKey ??
    `${log?.module ?? "Vehicle"}#${log?.name ?? ""}#${log?.nId ?? 0}`
  );
}

function buildMetaSignature(logs: any[]): string {
  const metadataRows = (logs ?? [])
    .map((log) => {
      const key = getPrimaryKey(log);
      const module = log?.module ?? "";
      const name = log?.name ?? "";
      const unit = log?.unit ?? "";
      const min = typeof log?.min === "number" ? String(log.min) : "";
      const max = typeof log?.max === "number" ? String(log.max) : "";
      return [key, module, name, unit, min, max].join("::");
    })
    .sort();

  return metadataRows.join("|");
}

async function resendMetaIfSchemaChanged(): Promise<void> {
  if (!get(isMonitoring)) return;

  const logs = buildBroadcastLogs();
  const sig = buildMetaSignature(logs);
  if (sig === lastMetaSignature) return;

  lastMetaSignature = sig;

  const deviceId = await resolveDeviceId();
  if (!deviceId) return;

  logTraceX(221, {
    kind: "broadcast-meta",
    deviceId,
    parameters: buildBroadcastLogSnapshot(logs).map((log) => ({
      key: log.key,
      module: log.module,
      name: log.name,
      unit: log.unit,
      min: log.min,
      max: log.max,
    })),
  });

  await sendTelemetryMetadataFromLogs(deviceId, logs);
}

function scheduleMetaResend(): void {
  if (!get(isMonitoring)) return;

  if (metaResendTimer) clearTimeout(metaResendTimer);
  metaResendTimer = setTimeout(() => {
    metaResendTimer = null;
    void resendMetaIfSchemaChanged();
  }, 250);
}

async function flushPendingAndroidSyncFrame(): Promise<void> {
  if (!isAndroidBackgroundBroadcastEnabled()) return;
  if (androidSyncFrameInFlight) return;

  const payload = pendingAndroidSyncFrame;
  if (!payload) return;

  pendingAndroidSyncFrame = null;
  androidSyncFrameInFlight = true;

  try {
    await BackgroundBroadcast.syncFrame(payload);
    lastAndroidSyncFrameAtMs = Date.now();
  } finally {
    androidSyncFrameInFlight = false;
    if (pendingAndroidSyncFrame) {
      scheduleAndroidSyncFrame(pendingAndroidSyncFrame);
    }
  }
}

function scheduleAndroidSyncFrame(payload: {
  valuesJson: string;
  positionJson: string;
  sourceFrameRateHz: number | null;
  allowNativeGpsFallback: boolean;
}): void {
  pendingAndroidSyncFrame = payload;

  const now = Date.now();
  const waitMs = Math.max(
    0,
    ANDROID_SYNC_FRAME_MIN_INTERVAL_MS - (now - lastAndroidSyncFrameAtMs),
  );

  if (androidSyncFrameTimer) {
    return;
  }

  if (waitMs === 0 && !androidSyncFrameInFlight) {
    void flushPendingAndroidSyncFrame();
    return;
  }

  androidSyncFrameTimer = setTimeout(() => {
    androidSyncFrameTimer = null;
    void flushPendingAndroidSyncFrame();
  }, waitMs);
}

// ----------------------------------------------------
// Public API (start/stop monitoring and broadcast updates)
// ----------------------------------------------------
export async function startMonitoring(deviceIdOverride?: string): Promise<void> {
  if (get(isMonitoring)) return;

  const baseUrl = getBaseUrlMobileApi();
  const hubUrl = resolveHubUrl(baseUrl);
  const deviceId = deviceIdOverride ?? (await resolveDeviceId());

  if (!deviceId) {
    logWarning("No active device selected, cannot start telemetry sender.");
    return;
  }

  const accessTokenFactory = accessTokenFactoryFor(baseUrl);

  try {
    logTraceX(48, { hubUrl, deviceId });

    if (isAndroidBackgroundBroadcastEnabled()) {
      await ensureBackgroundBroadcastListener();
      if (!(await ensureAndroidBackgroundBroadcastPermissions())) {
        broadcastConnectionState.set("idle");
        return;
      }
      broadcastConnectionState.set("connecting");
      setBackgroundBroadcastDebugState({
        state: "connecting",
        lastError: null,
      });

      await BackgroundBroadcast.start({
        deviceId,
        hubUrl,
        accessToken: await accessTokenFactory(),
        notificationTitle: "Mobile app background broadcast",
        notificationText: getBackgroundNotificationText(),
        demoMode: get(demoMode),
      });

      isMonitoring.set(true);

      const logs = buildBroadcastLogs();
      lastMetaSignature = buildMetaSignature(logs);

      await BackgroundBroadcast.syncMetadata({
        metadataJson: JSON.stringify(buildBroadcastLogSnapshot(logs)),
        vehicleName: currentActiveVehicle?.name,
        vin: currentActiveVehicle?.vehicleIdentifier,
      });

      await BackgroundBroadcast.syncFrame({
        valuesJson: JSON.stringify(buildAndroidFrameValues(logs)),
        positionJson: JSON.stringify(buildPositionDtoOrNull() ?? {}),
        sourceFrameRateHz: getSourceFrameRateHz(),
        allowNativeGpsFallback: shouldAllowNativeGpsFallback(),
      });
      lastAndroidSyncFrameAtMs = Date.now();

      return;
    }

    await startTelemetrySender(deviceId, hubUrl, accessTokenFactory, {
      onReconnected: async () => {
        if (!get(isMonitoring)) return;
        const logs = buildBroadcastLogs();
        lastMetaSignature = buildMetaSignature(logs);
        await sendTelemetryMetadataFromLogs(deviceId, logs);
      },
    });

    isMonitoring.set(true);

    // Send an initial metadata frame on start
    const logs = buildBroadcastLogs();
    lastMetaSignature = buildMetaSignature(logs);
    await sendTelemetryMetadataFromLogs(deviceId, logs);
  } catch (err) {
    logWarning(`Failed to start monitoring: ${String(err)}`);
    isMonitoring.set(false);
    throw err;
  }
}

export async function refreshBroadcastMetadata(): Promise<void> {
  if (!get(isMonitoring)) return;
  lastMetaSignature = "";

  if (isAndroidBackgroundBroadcastEnabled()) {
    const logs = buildBroadcastLogs();
    lastMetaSignature = buildMetaSignature(logs);
    await BackgroundBroadcast.syncMetadata({
      metadataJson: JSON.stringify(buildBroadcastLogSnapshot(logs)),
      vehicleName: currentActiveVehicle?.name,
      vin: currentActiveVehicle?.vehicleIdentifier,
    });
    return;
  }

  await resendMetaIfSchemaChanged();
}

export async function stopMonitoring(deviceIdOverride?: string): Promise<void> {
  if (!get(isMonitoring)) return;

  const deviceId = deviceIdOverride ?? (await resolveDeviceId());
  const isAndroidBackground = isAndroidBackgroundBroadcastEnabled();

  if (isAndroidBackground) {
    if (metaResendTimer) {
      clearTimeout(metaResendTimer);
      metaResendTimer = null;
    }
    lastMetaSignature = "";
    lastAndroidSyncFrameAtMs = 0;
    pendingAndroidSyncFrame = null;
    androidSyncFrameInFlight = false;
    if (androidSyncFrameTimer) {
      clearTimeout(androidSyncFrameTimer);
      androidSyncFrameTimer = null;
    }
    isMonitoring.set(false);
  }

  try {
    if (!deviceId) {
      logWarning("No active device selected, cannot stop telemetry sender.");
      return;
    }

    if (isAndroidBackground) {
      await BackgroundBroadcast.stop();
      broadcastConnectionState.set("idle");
      return;
    }

    await stopTelemetrySender(deviceId);
  } catch (err) {
    logWarning(`Failed to stop monitoring cleanly: ${String(err)}`);
    throw err;
  } finally {
    if (metaResendTimer) {
      clearTimeout(metaResendTimer);
      metaResendTimer = null;
    }
    lastMetaSignature = "";
    lastAndroidSyncFrameAtMs = 0;
    pendingAndroidSyncFrame = null;
    androidSyncFrameInFlight = false;
    if (androidSyncFrameTimer) {
      clearTimeout(androidSyncFrameTimer);
      androidSyncFrameTimer = null;
    }
    if (!isAndroidBackground) {
      isMonitoring.set(false);
    }
  }
}

export async function pauseMonitoringForBleReconnect(): Promise<boolean> {
  const wasMonitoring = get(isMonitoring);
  shouldResumeAfterBleReconnect.set(wasMonitoring);

  if (!wasMonitoring) {
    return false;
  }

  await stopMonitoring();
  markActiveLogsForReconnectReapply();
  return true;
}

export function cancelMonitoringResumeAfterBleReconnect(): void {
  shouldResumeAfterBleReconnect.set(false);
  cancelActiveLogsReconnectReapply();
}

export async function resumeMonitoringAfterBleReconnect(
  deviceIdOverride?: string,
): Promise<void> {
  if (!get(shouldResumeAfterBleReconnect)) {
    return;
  }

  await reapplyActiveLogsForCurrentMonitoringSession();
  await startMonitoring(deviceIdOverride);
  shouldResumeAfterBleReconnect.set(false);
}

/**
 * Called by the UI when monitored values change.
 * Sends telemetry values from telemetryValuesMonitored (vehicle and GPS telemetry).
 * Position is sent separately via a DTO (may be null).
 */
export async function handleLogsChangedForBroadcast(_lv: any[]): Promise<void> {
  if (!get(isMonitoring)) return;

  const deviceId = await resolveDeviceId();
  if (!deviceId) {
    logWarning("No active device selected, cannot send telemetry frame.");
    return;
  }

  const logs = buildBroadcastLogs();

  const sig = buildMetaSignature(logs);
  const position = buildPositionDtoOrNull();

  if (isAndroidBackgroundBroadcastEnabled()) {
    if (sig !== lastMetaSignature) {
      lastMetaSignature = sig;
      await BackgroundBroadcast.syncMetadata({
        metadataJson: JSON.stringify(buildBroadcastLogSnapshot(logs)),
        vehicleName: currentActiveVehicle?.name,
        vin: currentActiveVehicle?.vehicleIdentifier,
      });
    }

    scheduleAndroidSyncFrame({
      valuesJson: JSON.stringify(buildAndroidFrameValues(logs)),
      positionJson: JSON.stringify(position ?? {}),
      sourceFrameRateHz: getSourceFrameRateHz(),
      allowNativeGpsFallback: shouldAllowNativeGpsFallback(),
    });
    return;
  }

  if (sig !== lastMetaSignature) {
    scheduleMetaResend();
  }

  const now = Date.now();
  if (now - lastBroadcastFrameTraceAtMs >= BROADCAST_FRAME_TRACE_INTERVAL_MS) {
    lastBroadcastFrameTraceAtMs = now;
    logTraceX(222, {
      kind: "broadcast-frame",
      deviceId,
      telemetryCount: logs.length,
      hasPosition: position !== null,
    });
  }
  await sendTelemetryFromLogs(deviceId, logs, position);
}

export function resetMonitoringState(): void {
  isMonitoring.set(false);

  if (metaResendTimer) {
    clearTimeout(metaResendTimer);
    metaResendTimer = null;
  }

  lastMetaSignature = "";
  lastBroadcastFrameTraceAtMs = 0;
  lastAndroidSyncFrameAtMs = 0;
  pendingAndroidSyncFrame = null;
  androidSyncFrameInFlight = false;
  if (androidSyncFrameTimer) {
    clearTimeout(androidSyncFrameTimer);
    androidSyncFrameTimer = null;
  }
  broadcastConnectionState.set("idle");
  setBackgroundBroadcastDebugState({
    state: "idle",
    lastError: null,
  });
}
