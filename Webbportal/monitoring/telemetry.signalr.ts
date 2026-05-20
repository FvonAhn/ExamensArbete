import * as signalR from "@microsoft/signalr";
import {
  mapRawFrameToTelemetry,
  mapRawMetaToParameterMeta,
  type TelemetryFrameDto,
  type TelemetryMetaFrameDto,
  type TelemetryLiveFrame,
} from "./telemetry.domain";
import {
  pushTelemetryFrame,
  updateLatencyFromSummary,
  setTelemetryMeta,
  setVehicleMeta,
  refreshRateStr,
  markStreamStopped,
  streamStatus,
  type StreamStopReason,
} from "./telemetry.store";
import { telemetryUrls, telemetryConfig } from "./telemetry.config";
import { selectedDeviceId } from "./telemetry.session.store";
import { get } from "svelte/store";
import { telemetryRuntimeSession } from "./telemetry.runtime.store";

import { setLiveDeviceIds } from "./liveDeviceIds.store";
import { pushFrameForRecording } from "./recording-store";

import { setLatestPosition, clearLatestPosition } from "./position.store";

let connection: signalR.HubConnection | null = null;
let accessToken: string | null = null;
let uiFramePumpTimerId: ReturnType<typeof setTimeout> | null = null;
let bufferedFrames: TelemetryLiveFrame[] = [];
let lastAcceptedTimestampByDevice: Record<string, number> = {};
let lastRenderedTimestampByDevice: Record<string, number> = {};
let lastRawFrameReceivedAtMs = 0;
let lastRawArrivalAtMs = 0;
let smoothedArrivalJitterMs = 0;
let renderCursorTimestampMs = 0;
let lastUiPumpTickAtMs = 0;
// Dev-only VIN override. Set to true to force the VIN below, false to use the VIN from SignalR.
const DEV_USE_VIN_OVERRIDE = true;
const DEV_VIN_OVERRIDE = "YDV69495K819";

const RTT_MEASUREMENT_INTERVAL_ACTIVE_MS = 2000;
const RTT_MEASUREMENT_INTERVAL_BACKGROUND_MS = 8000;
const RTT_EWMA_ALPHA = 0.3;
const UI_FRAME_INTERVAL_DEFAULT_MS = 40;
const FRAME_BUFFER_MAX_SIZE = 64;
const FRAME_BUFFER_MAX_AGE_MS = 5000;
const MAX_EXTRAPOLATION_HOLD_MS = 220;
const FRAME_TIMESTAMP_RESET_THRESHOLD_MS = 5000;
const STALL_FREEZE_MS = 300;
const ARRIVAL_JITTER_ALPHA = 0.25;
let rttIntervalId: ReturnType<typeof setInterval> | null = null;
let pingInFlight = false;
let smoothedRttMs: number | null = null;
let visibilityChangeHandler: (() => void) | null = null;

function resolveVehicleVin(vin: string | null | undefined): string | null {
  return DEV_USE_VIN_OVERRIDE ? DEV_VIN_OVERRIDE : (vin ?? null);
}

if (typeof window !== "undefined") {
  streamStatus.set(null);
}

function resolveDeviceId(): string {
  return get(selectedDeviceId) ?? telemetryConfig.defaultDeviceId;
}

function parseStopReason(value: any): StreamStopReason {
  if (value === "user" || value === "unexpected" || value === "timeout") return value;
  return "unexpected";
}

function hasBrowserDom(): boolean {
  return typeof document !== "undefined";
}

function getRttMeasurementIntervalMs(): number {
  if (hasBrowserDom() && document.hidden) {
    return RTT_MEASUREMENT_INTERVAL_BACKGROUND_MS;
  }
  return RTT_MEASUREMENT_INTERVAL_ACTIVE_MS;
}

function getUiFrameIntervalMs(): number {
  return UI_FRAME_INTERVAL_DEFAULT_MS;
}

function getJitterBufferDelayMs(): number {
  const intervalMs = getUiFrameIntervalMs();
  const adaptiveDelay = intervalMs * 1.25 + smoothedArrivalJitterMs * 2;
  return Math.max(45, Math.min(100, Math.round(adaptiveDelay)));
}

function updateArrivalJitter(nowMs: number): void {
  if (lastRawArrivalAtMs > 0) {
    const observedIntervalMs = nowMs - lastRawArrivalAtMs;
    const intervalDeltaMs = Math.abs(observedIntervalMs - UI_FRAME_INTERVAL_DEFAULT_MS);
    smoothedArrivalJitterMs =
      smoothedArrivalJitterMs === 0
        ? intervalDeltaMs
        : smoothedArrivalJitterMs + ARRIVAL_JITTER_ALPHA * (intervalDeltaMs - smoothedArrivalJitterMs);
  }

  lastRawArrivalAtMs = nowMs;
}

function pruneFrameBuffer(nowMs: number): void {
  if (bufferedFrames.length <= 1) return;

  const cutoff = nowMs - FRAME_BUFFER_MAX_AGE_MS;
  while (bufferedFrames.length > 2 && bufferedFrames[0].timestamp < cutoff) {
    bufferedFrames.shift();
  }

  if (bufferedFrames.length > FRAME_BUFFER_MAX_SIZE) {
    bufferedFrames.splice(0, bufferedFrames.length - FRAME_BUFFER_MAX_SIZE);
  }
}

function clearUiFramePump(): void {
  if (uiFramePumpTimerId !== null) {
    clearTimeout(uiFramePumpTimerId);
    uiFramePumpTimerId = null;
  }

  bufferedFrames = [];
  lastAcceptedTimestampByDevice = {};
  lastRenderedTimestampByDevice = {};
  lastRawFrameReceivedAtMs = 0;
  lastRawArrivalAtMs = 0;
  smoothedArrivalJitterMs = 0;
  renderCursorTimestampMs = 0;
  lastUiPumpTickAtMs = 0;
}

function resetFrameOrderingForDevice(deviceId: string): void {
  delete lastAcceptedTimestampByDevice[deviceId];
  delete lastRenderedTimestampByDevice[deviceId];
  bufferedFrames = bufferedFrames.filter((frame) => frame.deviceId !== deviceId);
}

function shouldAcceptFrameTimestamp(deviceId: string, ts: number, allowEqual = false): boolean {
  if (!Number.isFinite(ts)) return false;

  const prevTs = lastAcceptedTimestampByDevice[deviceId];
  if (prevTs == null) {
    lastAcceptedTimestampByDevice[deviceId] = ts;
    return true;
  }

  if (ts > prevTs || (allowEqual && ts === prevTs)) {
    lastAcceptedTimestampByDevice[deviceId] = ts;
    return true;
  }

  if (prevTs - ts >= FRAME_TIMESTAMP_RESET_THRESHOLD_MS) {
    resetFrameOrderingForDevice(deviceId);
    lastAcceptedTimestampByDevice[deviceId] = ts;
    return true;
  }

  return false;
}

function pushFrameToBuffer(frame: TelemetryLiveFrame): void {
  const last = bufferedFrames[bufferedFrames.length - 1];
  const coalesceWindowMs = Math.max(6, Math.floor(getUiFrameIntervalMs() / 4));

  if (
    last &&
    last.deviceId === frame.deviceId &&
    frame.timestamp - last.timestamp <= coalesceWindowMs
  ) {
    bufferedFrames[bufferedFrames.length - 1] = frame;
    return;
  }

  bufferedFrames.push(frame);
}

function buildInterpolatedFrame(
  left: TelemetryLiveFrame,
  right: TelemetryLiveFrame,
  targetTimestamp: number,
): TelemetryLiveFrame {
  const span = Math.max(1, right.timestamp - left.timestamp);
  const t = Math.max(0, Math.min(1, (targetTimestamp - left.timestamp) / span));
  const keys = new Set<string>([
    ...Object.keys(left.values ?? {}),
    ...Object.keys(right.values ?? {}),
  ]);
  const values: Record<string, number> = {};

  for (const key of keys) {
    const a = left.values?.[key];
    const b = right.values?.[key];

    if (typeof a === "number" && typeof b === "number") {
      values[key] = a + (b - a) * t;
      continue;
    }

    if (typeof b === "number") {
      values[key] = b;
      continue;
    }

    if (typeof a === "number") {
      values[key] = a;
    }
  }

  return {
    deviceId: right.deviceId || left.deviceId,
    timestamp: Math.round(targetTimestamp),
    values,
    position: right.position ?? left.position,
  };
}

function sampleFrameAt(targetTimestamp: number): TelemetryLiveFrame | null {
  const len = bufferedFrames.length;
  if (len === 0) return null;
  if (len === 1) return bufferedFrames[0];

  for (let i = 1; i < len; i++) {
    const left = bufferedFrames[i - 1];
    const right = bufferedFrames[i];

    if (targetTimestamp <= right.timestamp) {
      if (targetTimestamp <= left.timestamp) return left;
      return buildInterpolatedFrame(left, right, targetTimestamp);
    }
  }

  const last = bufferedFrames[len - 1];
  if (targetTimestamp - last.timestamp <= MAX_EXTRAPOLATION_HOLD_MS) {
    return {
      ...last,
      timestamp: Math.round(targetTimestamp),
    };
  }

  return null;
}

function scheduleUiFramePump(): void {
  if (uiFramePumpTimerId !== null) return;

  const run = () => {
    uiFramePumpTimerId = null;

    const now = Date.now();
    pruneFrameBuffer(now);

    const latest = bufferedFrames[bufferedFrames.length - 1];
    const streamLooksStalled =
      lastRawFrameReceivedAtMs > 0 &&
      now - lastRawFrameReceivedAtMs >= Math.max(STALL_FREEZE_MS, getUiFrameIntervalMs() * 3);

    if (latest && !streamLooksStalled) {
      const frameIntervalMs = getUiFrameIntervalMs();
      const bufferedTargetTimestamp = latest.timestamp - getJitterBufferDelayMs();
      const playableMaxTimestamp = latest.timestamp + MAX_EXTRAPOLATION_HOLD_MS;

      if (renderCursorTimestampMs <= 0) {
        renderCursorTimestampMs = bufferedTargetTimestamp;
      } else {
        const elapsedSinceLastPumpMs =
          lastUiPumpTickAtMs > 0 ? now - lastUiPumpTickAtMs : frameIntervalMs;
        const boundedStepMs = Math.max(
          frameIntervalMs * 0.5,
          Math.min(frameIntervalMs * 2, elapsedSinceLastPumpMs),
        );
        renderCursorTimestampMs += boundedStepMs;
      }
      lastUiPumpTickAtMs = now;

      if (renderCursorTimestampMs < bufferedTargetTimestamp - frameIntervalMs * 3) {
        renderCursorTimestampMs = bufferedTargetTimestamp - frameIntervalMs;
      }

      const targetTimestamp = Math.min(renderCursorTimestampMs, playableMaxTimestamp);
      const sampled = sampleFrameAt(targetTimestamp) ?? latest;
      const lastRenderedTs = lastRenderedTimestampByDevice[sampled.deviceId] ?? -Infinity;

      if (sampled.timestamp > lastRenderedTs) {
        lastRenderedTimestampByDevice[sampled.deviceId] = sampled.timestamp;
        pushTelemetryFrame(sampled);
      }
    }

    if (!connection || connection.state === signalR.HubConnectionState.Disconnected) {
      return;
    }

    uiFramePumpTimerId = setTimeout(run, getUiFrameIntervalMs());
  };

  uiFramePumpTimerId = setTimeout(run, getUiFrameIntervalMs());
}

function handleStreamStopped(reason: StreamStopReason, timestampMs?: number): void {
  clearUiFramePump();
  markStreamStopped(reason, timestampMs);
  clearLatestPosition();
}

function attachVisibilityHandler(): void {
  if (!hasBrowserDom() || visibilityChangeHandler) return;

  visibilityChangeHandler = () => {
    if (!connection || connection.state !== signalR.HubConnectionState.Connected) return;
    startRttMeasurement();
  };

  document.addEventListener("visibilitychange", visibilityChangeHandler);
}

function detachVisibilityHandler(): void {
  if (!hasBrowserDom() || !visibilityChangeHandler) return;
  document.removeEventListener("visibilitychange", visibilityChangeHandler);
  visibilityChangeHandler = null;
}

function toNumericValues(input: unknown): Record<string, number> {
  if (!input || typeof input !== "object") return {};

  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === "number") {
      if (Number.isFinite(v)) out[k] = v;
      continue;
    }

    if (typeof v === "string") {
      const n = Number.parseFloat(v);
      if (Number.isFinite(n)) out[k] = n;
    }
  }

  return out;
}

export async function startTelemetryConnection(token: string) {
  console.log("[Telemetry.SignalR] startTelemetryConnection called");
  if (connection) return;

  accessToken = token;
  clearUiFramePump();
  pingInFlight = false;
  smoothedRttMs = null;
  telemetryRuntimeSession.set({
    token,
    deviceId: resolveDeviceId(),
  });
  // Reset vehicle identity for a new live session so stale VIN state does not
  // keep Calibration Maps available when the next stream has not sent metadata yet.
  setVehicleMeta({
    vehicleName: null,
    vin: DEV_USE_VIN_OVERRIDE ? resolveVehicleVin(null) : null,
  });

  connection = new signalR.HubConnectionBuilder()
    .withUrl(`${telemetryUrls.telemetryHub}?access_token=${token}`)
    .withAutomaticReconnect()
    .build();

  connection.on("TelemetryMetaUpdated", (frame: TelemetryMetaFrameDto) => {
    setTelemetryMeta(mapRawMetaToParameterMeta(frame));
    setVehicleMeta({
      vehicleName: frame.vehicleName ?? null,
      vin: resolveVehicleVin(frame.vin),
    });
  });

  connection.on("TelemetryUpdated", (frame: TelemetryFrameDto) => {
    const nowMs = Date.now();
    updateArrivalJitter(nowMs);
    lastRawFrameReceivedAtMs = nowMs;

    if (frame.position) {
      setLatestPosition(frame.position);
    }

    const mapped = mapRawFrameToTelemetry(frame);
    const numericValues = toNumericValues((mapped as any)?.values);
    if (Object.keys(numericValues).length > 0) {
      pushFrameForRecording(numericValues);
    }

    if (frame.framerateStr != null) {
      refreshRateStr.set(frame.framerateStr);
    }

    if (!shouldAcceptFrameTimestamp(frame.deviceId, frame.timestamp)) return;

    pushFrameToBuffer(mapped);
    pruneFrameBuffer(nowMs);
    scheduleUiFramePump();
  });

  connection.on("TelemetryStreamStatus", (s: any) => {
    const reason = parseStopReason(s?.reason);
    const ts = typeof s?.timestampMs === "number" ? s.timestampMs : Date.now();
    handleStreamStopped(reason, ts);
  });

  connection.on("LatencySummary", (summary: any) => {
    if (!summary) return;

    updateLatencyFromSummary({
      appToServerRttMs: summary.appToServerRttMs ?? summary.AppToServerRttMs,
      webAppToServerRttMs: summary.webAppToServerRttMs ?? summary.WebAppToServerRttMs,
      totalLatencyMs: summary.totalLatencyMs ?? summary.TotalLatencyMs,
    });
  });

  connection.on("LiveDeviceIdsChanged", (ids: string[]) => {
    setLiveDeviceIds(ids);
  });

  connection.onreconnecting(() => {
    clearUiFramePump();
    clearLatestPosition();
  });

  connection.onreconnected(async () => {
    const deviceId = resolveDeviceId();
    if (!connection) return;

    await connection.invoke("JoinDeviceGroup", deviceId);

    try {
      const ids = await connection.invoke<string[]>("GetLiveDeviceIds");
      setLiveDeviceIds(ids);
    } catch {
      setLiveDeviceIds([]);
    }

    startRttMeasurement();
    scheduleUiFramePump();
  });

  connection.onclose(() => {
    clearUiFramePump();
  });

  try {
    await connection.start();

    const deviceId = resolveDeviceId();
    telemetryRuntimeSession.set({
      token: accessToken,
      deviceId,
    });
    await connection.invoke("JoinDeviceGroup", deviceId);

    try {
      const ids = await connection.invoke<string[]>("GetLiveDeviceIds");
      setLiveDeviceIds(ids);
    } catch {
      setLiveDeviceIds([]);
    }

    clearLatestPosition();
    attachVisibilityHandler();
    startRttMeasurement();
    scheduleUiFramePump();
  } catch (err) {
    console.error("[Telemetry.SignalR] failed to start connection", err);
  }
}

export async function stopTelemetryConnection() {
  if (!connection) return;

  stopRttMeasurement();
  clearUiFramePump();
  detachVisibilityHandler();
  smoothedRttMs = null;
  pingInFlight = false;

  try {
    await connection.stop();
  } catch (err) {
    console.error("[Telemetry.SignalR] error while stopping connection", err);
  } finally {
    connection = null;
    telemetryRuntimeSession.set({ token: null, deviceId: null });
    clearLatestPosition();
  }
}

export async function restartTelemetryConnection() {
  if (!accessToken) {
    console.error("[Telemetry.SignalR] Cannot restart connection: no access token available");
    return;
  }

  if (!connection) {
    await startTelemetryConnection(accessToken);
    return;
  }

  try {
    await connection.stop();
  } finally {
    connection = null;
  }

  clearLatestPosition();
  await startTelemetryConnection(accessToken);
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
    console.error("[Telemetry.SignalR] RTT measurement failed:", err);
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
  if (rttIntervalId === null) return;
  clearInterval(rttIntervalId);
  rttIntervalId = null;
}
