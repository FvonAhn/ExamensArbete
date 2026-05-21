import * as signalR from "@microsoft/signalr";
import { writable } from "svelte/store";
import type {
  PositionDto,
  TelemetryFrameDto,
  TelemetryMetaFrameDto,
  TelemetryParameterMetaDto,
} from "./telemetry-dtos";

import { get } from "svelte/store";
import { frameRateData } from "../../stores/monitoring-framerate";
import { currentActiveVehicle } from "../../stores/vehicles";

let connection: signalR.HubConnection | null = null;

let activeDeviceId: string | null = null;
let activeHubUrl: string | null = null;
let onReconnectedCallback: (() => void | Promise<void>) | null = null;
let rejoinRetryTimerId: ReturnType<typeof setTimeout> | null = null;
let telemetryFrameInFlight = false;
let latestQueuedTelemetryFrame: TelemetryFrameDto | null = null;
let telemetrySendPumpTimerId: ReturnType<typeof setTimeout> | null = null;
let lastTelemetryFrameSentAtMs = 0;
let nextTelemetryFrameSendAtMs = 0;
let pingInFlight = false;
let smoothedRttMs: number | null = null;
export type BroadcastConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

export const broadcastConnectionState =
  writable<BroadcastConnectionState>("idle");

// Round-trip time (RTT) measurement interval
let rttIntervalId: ReturnType<typeof setInterval> | null = null;
let visibilityChangeHandler: (() => void) | null = null;
const RTT_MEASUREMENT_INTERVAL_ACTIVE_MS = 2000;
const RTT_MEASUREMENT_INTERVAL_BACKGROUND_MS = 8000;
const RTT_EWMA_ALPHA = 0.3;
const MIN_TELEMETRY_FRAME_INTERVAL_MS = 40; // Target 25 FPS cadence with latest-only coalescing
const INITIAL_CONNECT_RETRY_DELAYS_MS = [0, 250, 750, 1500, 3000];

function hasBrowserDom(): boolean {
  return typeof document !== "undefined";
}

function isOnlineOrUnknown(): boolean {
  if (typeof navigator === "undefined" || typeof navigator.onLine !== "boolean") {
    return true;
  }
  return navigator.onLine;
}

function getRttMeasurementIntervalMs(): number {
  if (hasBrowserDom() && document.hidden) {
    return RTT_MEASUREMENT_INTERVAL_BACKGROUND_MS;
  }
  return RTT_MEASUREMENT_INTERVAL_ACTIVE_MS;
}

const reconnectPolicy: signalR.IRetryPolicy = {
  nextRetryDelayInMilliseconds: (ctx) => {
    // Fast first retries for quick recovery, then back off to protect battery.
    const schedule = [0, 300, 800, 1500, 3000, 5000, 10000, 20000, 30000];
    const baseDelay = schedule[Math.min(ctx.previousRetryCount, schedule.length - 1)];

    // If the browser reports offline, avoid hot-loop retries.
    const offlineFloor = isOnlineOrUnknown() ? 0 : 5000;
    const adjustedBaseDelay = Math.max(baseDelay, offlineFloor);

    const jitter =
      adjustedBaseDelay > 0
        ? Math.floor(Math.random() * Math.min(1500, adjustedBaseDelay * 0.25))
        : 0;
    return adjustedBaseDelay + jitter;
  },
};

type TelemetrySenderOptions = {
  onReconnected?: () => void | Promise<void>;
};

function clearRejoinRetryTimer(): void {
  if (rejoinRetryTimerId !== null) {
    clearTimeout(rejoinRetryTimerId);
    rejoinRetryTimerId = null;
  }
}

function resetSendAndRttState(): void {
  telemetryFrameInFlight = false;
  latestQueuedTelemetryFrame = null;
  if (telemetrySendPumpTimerId !== null) {
    clearTimeout(telemetrySendPumpTimerId);
    telemetrySendPumpTimerId = null;
  }
  lastTelemetryFrameSentAtMs = 0;
  nextTelemetryFrameSendAtMs = 0;
  pingInFlight = false;
  smoothedRttMs = null;
}

function scheduleTelemetrySendPump(): void {
  if (telemetrySendPumpTimerId !== null) return;

  const now = Date.now();
  if (nextTelemetryFrameSendAtMs <= 0) {
    nextTelemetryFrameSendAtMs =
      lastTelemetryFrameSentAtMs > 0
        ? lastTelemetryFrameSentAtMs + MIN_TELEMETRY_FRAME_INTERVAL_MS
        : now;
  }

  const delay = Math.max(0, nextTelemetryFrameSendAtMs - now);

  telemetrySendPumpTimerId = setTimeout(() => {
    telemetrySendPumpTimerId = null;
    void runTelemetrySendPump();
  }, delay);
}

async function runTelemetrySendPump(): Promise<void> {
  if (telemetryFrameInFlight) return;
  if (!latestQueuedTelemetryFrame) return;
  if (!connection || connection.state !== signalR.HubConnectionState.Connected) return;

  telemetryFrameInFlight = true;
  try {
    const frameToSend = latestQueuedTelemetryFrame;
    latestQueuedTelemetryFrame = null;

    try {
      await connection.invoke("SendTelemetryFrame", frameToSend);
      lastTelemetryFrameSentAtMs = Date.now();
      nextTelemetryFrameSendAtMs = Math.max(
        nextTelemetryFrameSendAtMs + MIN_TELEMETRY_FRAME_INTERVAL_MS,
        lastTelemetryFrameSentAtMs + Math.floor(MIN_TELEMETRY_FRAME_INTERVAL_MS * 0.5),
      );
    } catch (err) {
      console.error("Failed to send telemetry frame", err);
      return;
    }
  } finally {
    telemetryFrameInFlight = false;
  }

  // If newer data arrived while sending, schedule next frame with rate cap.
  if (latestQueuedTelemetryFrame) {
    scheduleTelemetrySendPump();
  }
}

function scheduleRejoinRetry(conn: signalR.HubConnection): void {
  if (rejoinRetryTimerId !== null) return;

  rejoinRetryTimerId = setTimeout(async () => {
    rejoinRetryTimerId = null;

    if (connection !== conn || !activeDeviceId) return;
    if (conn.state !== signalR.HubConnectionState.Connected) return;

    try {
      await conn.invoke("JoinDeviceGroup", activeDeviceId);
      broadcastConnectionState.set("connected");
      await onReconnectedCallback?.();
    } catch (err) {
      console.warn("[telemetry-sender] Delayed re-join failed.", err);
      broadcastConnectionState.set("disconnected");
      scheduleRejoinRetry(conn);
    }
  }, 2000);
}

export async function startTelemetrySender(
  deviceId: string,
  hubUrl: string,
  accessTokenFactory: () => string | Promise<string>,
  options?: TelemetrySenderOptions,
) {
  if (connection) {
    if (activeDeviceId === deviceId && activeHubUrl === hubUrl) return;
    await stopTelemetrySender(activeDeviceId ?? undefined);
  }
  onReconnectedCallback = options?.onReconnected ?? null;
  broadcastConnectionState.set("connecting");

  const buildConnection = () =>
    new signalR.HubConnectionBuilder()
      .withUrl(hubUrl, {
        accessTokenFactory,
        transport: signalR.HttpTransportType.WebSockets,
      })
      .withAutomaticReconnect(reconnectPolicy)
      .build();

  const startAndJoin = async (conn: signalR.HubConnection) => {
    await conn.start();
    await conn.invoke("JoinDeviceGroup", deviceId);
  };

  const conn = buildConnection();
  connection = conn;

  conn.onreconnecting((err) => {
    console.warn("[telemetry-sender] Reconnecting...", err);
    stopRttMeasurement();
    resetSendAndRttState();
    clearRejoinRetryTimer();
    broadcastConnectionState.set("reconnecting");
  });

  conn.onreconnected(async () => {
    if (connection !== conn || !activeDeviceId) return;
    clearRejoinRetryTimer();

    try {
      await conn.invoke("JoinDeviceGroup", activeDeviceId);
      startRttMeasurement();
      broadcastConnectionState.set("connected");
      await onReconnectedCallback?.();
    } catch (err) {
      console.warn("[telemetry-sender] Reconnected but re-join failed.", err);
      broadcastConnectionState.set("disconnected");
      scheduleRejoinRetry(conn);
    }
  });

  conn.onclose((err) => {
    if (connection !== conn) return;
    stopRttMeasurement();
    resetSendAndRttState();
    clearRejoinRetryTimer();
    broadcastConnectionState.set("disconnected");
    console.warn("[telemetry-sender] Connection closed.", err);
  });

  try {
    let startErr: unknown = null;
    for (const delay of INITIAL_CONNECT_RETRY_DELAYS_MS) {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        await startAndJoin(conn);
        startErr = null;
        break;
      } catch (err) {
        startErr = err;
      }
    }

    if (startErr) throw startErr;

    activeDeviceId = deviceId;
    activeHubUrl = hubUrl;
    attachVisibilityHandler();
    startRttMeasurement();
    broadcastConnectionState.set("connected");
  } catch (err) {
    try {
      await conn.stop();
    } catch {
      /* ignore */
    }
    if (connection === conn) connection = null;
    onReconnectedCallback = null;
    resetSendAndRttState();
    clearRejoinRetryTimer();
    detachVisibilityHandler();
    broadcastConnectionState.set("disconnected");
    throw err;
  }
}

export async function stopTelemetrySender(deviceId?: string) {
  if (!connection) return;
  const conn = connection;
  connection = null;

  const effectiveDeviceId = deviceId ?? activeDeviceId;

  try {
    if (effectiveDeviceId && conn.state === signalR.HubConnectionState.Connected) {
      try {
        await conn.invoke("StopTelemetryStream", effectiveDeviceId);
      } catch (err) {
        console.warn("[telemetry-sender] StopTelemetryStream invoke failed:", err);
      }
    }
  } finally {
    try {
      await conn.stop();
    } catch {
      /* ignore */
    }

    activeDeviceId = null;
    activeHubUrl = null;
    onReconnectedCallback = null;
    resetSendAndRttState();
    clearRejoinRetryTimer();
    detachVisibilityHandler();
    broadcastConnectionState.set("idle");

    stopRttMeasurement();
  }
}

async function measureRtt(): Promise<void> {
  if (!connection || connection.state !== signalR.HubConnectionState.Connected) return;
  if (pingInFlight) return;
  pingInFlight = true;

  try {
    const sendTime = Date.now();
    await connection.invoke<number>("Ping", sendTime);
    const receiveTime = Date.now();
    const rttSample = Math.max(0, receiveTime - sendTime);
    smoothedRttMs =
      smoothedRttMs === null
        ? rttSample
        : smoothedRttMs + RTT_EWMA_ALPHA * (rttSample - smoothedRttMs);
    const stableRtt = Math.round(smoothedRttMs);

    await connection.invoke("ReportRtt", stableRtt);
  } catch (err) {
    console.error("[telemetry-sender] RTT measurement failed:", err);
  } finally {
    pingInFlight = false;
  }
}

function startRttMeasurement(): void {
  stopRttMeasurement();
  void measureRtt();
  rttIntervalId = setInterval(() => void measureRtt(), getRttMeasurementIntervalMs());
}

function stopRttMeasurement(): void {
  if (rttIntervalId !== null) {
    clearInterval(rttIntervalId);
    rttIntervalId = null;
  }
}

function attachVisibilityHandler(): void {
  if (!hasBrowserDom() || visibilityChangeHandler) {
    return;
  }

  visibilityChangeHandler = () => {
    if (!connection || connection.state !== signalR.HubConnectionState.Connected) {
      return;
    }
    // Re-create the timer using active/background cadence.
    startRttMeasurement();
  };

  document.addEventListener("visibilitychange", visibilityChangeHandler);
}

function detachVisibilityHandler(): void {
  if (!hasBrowserDom() || !visibilityChangeHandler) {
    return;
  }

  document.removeEventListener("visibilitychange", visibilityChangeHandler);
  visibilityChangeHandler = null;
}

// ----------------------------------------------------
// Helper functions
// ----------------------------------------------------
function shouldIncludeLog(log: any): boolean {
  // Send monitored values only.
  // If the log has no monitoring flag (legacy), include it by default.
  const m = log?.isMonitored;
  if (typeof m === "boolean") return m;
  return true;
}

function toNumberOrNull(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function buildKey(log: any): string {
  return (
    log?.primaryKey ??
    `${log?.module ?? "Vehicle"}#${log?.name ?? ""}#${log?.nId ?? 0}`
  );
}

// ----------------------------------------------------
// Send telemetry frame
// ----------------------------------------------------
export async function sendTelemetryFromLogs(
  deviceId: string,
  logs: any[],
  position: PositionDto | null,
) {
  if (!connection || connection.state !== signalR.HubConnectionState.Connected) return;

  const values = (logs ?? [])
    .filter(shouldIncludeLog)
    .map((log) => {
      const value = toNumberOrNull(log?.value ?? log?.valueStr);
      if (value === null) return null;
      return { key: buildKey(log), value };
    })
    .filter(Boolean) as { key: string; value: number }[];

    const fr = get(frameRateData);
  const targetFrameRate = 1000 / MIN_TELEMETRY_FRAME_INTERVAL_MS;
  const effectiveFrameRate =
    typeof fr?.frameRate === "number" && Number.isFinite(fr.frameRate) && fr.frameRate > 0
      ? Math.min(fr.frameRate, targetFrameRate)
      : targetFrameRate;
  const framerateStr = effectiveFrameRate.toFixed(2);

  const frame: TelemetryFrameDto = {
    deviceId,
    timestamp: Date.now(),
    values,
    framerateStr,
    position,
  };

  latestQueuedTelemetryFrame = frame;
  scheduleTelemetrySendPump();
}

// ----------------------------------------------------
// Send telemetry metadata
// ----------------------------------------------------
export async function sendTelemetryMetadataFromLogs(deviceId: string, logs: any[]) {
  if (!connection || connection.state !== signalR.HubConnectionState.Connected) return;

  const parameters: TelemetryParameterMetaDto[] = (logs ?? [])
    .filter(shouldIncludeLog)
    .map((log) => ({
      key: buildKey(log),
      name: log?.name ?? "",
      unit: log?.unit ?? "",
      module: log?.module ?? "",
      min: typeof log?.min === "number" ? log.min : 0,
      max: typeof log?.max === "number" ? log.max : 0,
    }));

  const frame: TelemetryMetaFrameDto = {
    deviceId,
    parameters,
    vehicleName: currentActiveVehicle?.name,
    vin: currentActiveVehicle?.vehicleIdentifier,
  };

  try {
    await connection.invoke("SendTelemetryMeta", frame);
  } catch (err) {
    console.error("Failed to send telemetry metadata frame", err);
  }
}



