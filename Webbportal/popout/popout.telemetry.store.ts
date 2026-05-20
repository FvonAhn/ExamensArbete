import * as signalR from "@microsoft/signalr";
import { writable } from "svelte/store";
import type { Writable } from "svelte/store";
import type { TelemetryParameterMeta, TelemetryLiveFrame } from "$lib/monitoring/telemetry.domain";
import {
  mapRawFrameToTelemetry,
  mapRawMetaToParameterMeta,
  type TelemetryFrameDto,
  type TelemetryMetaFrameDto,
} from "$lib/monitoring/telemetry.domain";
import { telemetryUrls } from "$lib/monitoring/telemetry.config";
import { ensureSeriesColors } from "$lib/monitoring/telemetry.chartOptions";

export interface PopoutTelemetrySnapshot {
  labels: string[];
  seriesHistory: Record<string, number[]>;
  parameterMeta: Record<string, TelemetryParameterMeta>;
  telemetry: {
    deviceId: string;
    values: Record<string, number>;
  } | null;
  enabledSeries: string[];
  seriesColors: Record<string, string>;
  poppedValueKeys: string[];
}

type TelemetryPayload = Partial<PopoutTelemetrySnapshot>;
type TelemetrySessionPayload = {
  token?: string | null;
  deviceId?: string | null;
};

type StreamStopReason = "user" | "unexpected" | "timeout";

const MAX_POINTS = 150;
const FRAME_INTERVAL_MS = 40;
const JITTER_BUFFER_DELAY_MS = 70;
const MAX_EXTRAPOLATION_HOLD_MS = 220;
const FRAME_BUFFER_MAX = 64;
const FRAME_BUFFER_MAX_AGE_MS = 5000;

export const labels = writable<string[]>([]);
export const seriesHistory = writable<Record<string, number[]>>({});
export const parameterMeta = writable<Record<string, TelemetryParameterMeta>>({});
export const telemetry = writable<PopoutTelemetrySnapshot["telemetry"]>(null);
export const enabledSeries: Writable<string[]> = writable<string[]>([]);
export const seriesColors = writable<Record<string, string>>({});
export const telemetrySnapshot = writable<PopoutTelemetrySnapshot>({
  labels: [],
  seriesHistory: {},
  parameterMeta: {},
  telemetry: null,
  enabledSeries: [],
  seriesColors: {},
  poppedValueKeys: [],
});
export const poppedValueKeys = writable<string[]>([]);

let currentSnapshot: PopoutTelemetrySnapshot = {
  labels: [],
  seriesHistory: {},
  parameterMeta: {},
  telemetry: null,
  enabledSeries: [],
  seriesColors: {},
  poppedValueKeys: [],
};

let directConnection: signalR.HubConnection | null = null;
let directToken: string | null = null;
let directDeviceId: string | null = null;
let bufferedFrames: TelemetryLiveFrame[] = [];
let framePumpTimerId: ReturnType<typeof setTimeout> | null = null;
let renderCursorTimestampMs = 0;
let lastAcceptedTimestampMs = -Infinity;
let lastRenderedTimestampMs = -Infinity;
let frameNextTickAtMs = 0;
let lastRawFrameReceivedAtMs = 0;
let hasDirectFrames = false;

function parseStopReason(value: unknown): StreamStopReason {
  if (value === "user" || value === "unexpected" || value === "timeout") return value;
  return "unexpected";
}

function applySnapshot(snapshot: PopoutTelemetrySnapshot): void {
  currentSnapshot = snapshot;
  telemetrySnapshot.set(snapshot);
  labels.set(snapshot.labels);
  seriesHistory.set(snapshot.seriesHistory);
  parameterMeta.set(snapshot.parameterMeta);
  telemetry.set(snapshot.telemetry);
  enabledSeries.set(snapshot.enabledSeries);
  seriesColors.set(snapshot.seriesColors);
  poppedValueKeys.set(snapshot.poppedValueKeys);
}

function mergeUiPayload(payload: TelemetryPayload): void {
  if (!hasDirectFrames) {
    applySnapshot({
      labels: payload.labels ?? [],
      seriesHistory: payload.seriesHistory ?? {},
      parameterMeta: payload.parameterMeta ?? {},
      telemetry: payload.telemetry ?? null,
      enabledSeries: payload.enabledSeries ?? [],
      seriesColors: payload.seriesColors ?? {},
      poppedValueKeys: payload.poppedValueKeys ?? [],
    });
    return;
  }

  applySnapshot({
    ...currentSnapshot,
    parameterMeta: payload.parameterMeta ?? currentSnapshot.parameterMeta,
    enabledSeries: payload.enabledSeries ?? currentSnapshot.enabledSeries,
    seriesColors: payload.seriesColors ?? currentSnapshot.seriesColors,
    poppedValueKeys: payload.poppedValueKeys ?? currentSnapshot.poppedValueKeys,
  });
}

function clearFramePump(): void {
  if (framePumpTimerId !== null) {
    clearTimeout(framePumpTimerId);
    framePumpTimerId = null;
  }

  bufferedFrames = [];
  renderCursorTimestampMs = 0;
  lastAcceptedTimestampMs = -Infinity;
  lastRenderedTimestampMs = -Infinity;
  frameNextTickAtMs = 0;
  lastRawFrameReceivedAtMs = 0;
  hasDirectFrames = false;
}

function pruneBufferedFrames(nowMs: number): void {
  const cutoff = nowMs - FRAME_BUFFER_MAX_AGE_MS;
  while (bufferedFrames.length > 2 && bufferedFrames[0].timestamp < cutoff) {
    bufferedFrames.shift();
  }

  if (bufferedFrames.length > FRAME_BUFFER_MAX) {
    bufferedFrames.splice(0, bufferedFrames.length - FRAME_BUFFER_MAX);
  }
}

function pushFrame(frame: TelemetryLiveFrame): void {
  if (!Number.isFinite(frame.timestamp) || frame.timestamp <= lastAcceptedTimestampMs) {
    return;
  }

  lastAcceptedTimestampMs = frame.timestamp;
  const last = bufferedFrames[bufferedFrames.length - 1];
  const coalesceWindowMs = Math.max(6, Math.floor(FRAME_INTERVAL_MS / 4));

  if (last && frame.timestamp - last.timestamp <= coalesceWindowMs) {
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
    } else if (typeof b === "number") {
      values[key] = b;
    } else if (typeof a === "number") {
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
  if (bufferedFrames.length === 0) return null;
  if (bufferedFrames.length === 1) {
    const only = bufferedFrames[0];
    if (targetTimestamp - only.timestamp <= MAX_EXTRAPOLATION_HOLD_MS) {
      return { ...only, timestamp: Math.round(targetTimestamp) };
    }
    return null;
  }

  for (let i = 1; i < bufferedFrames.length; i++) {
    const left = bufferedFrames[i - 1];
    const right = bufferedFrames[i];

    if (targetTimestamp <= right.timestamp) {
      if (targetTimestamp <= left.timestamp) return left;
      return buildInterpolatedFrame(left, right, targetTimestamp);
    }
  }

  const last = bufferedFrames[bufferedFrames.length - 1];
  if (targetTimestamp - last.timestamp <= MAX_EXTRAPOLATION_HOLD_MS) {
    return { ...last, timestamp: Math.round(targetTimestamp) };
  }

  return null;
}

function appendFrameToSnapshot(frame: TelemetryLiveFrame): void {
  const nextLabels = [...currentSnapshot.labels, frame.timestamp.toString()];
  if (nextLabels.length > MAX_POINTS) nextLabels.shift();

  const nextHistory: Record<string, number[]> = { ...currentSnapshot.seriesHistory };
  for (const [key, value] of Object.entries(frame.values ?? {})) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const arr = [...(nextHistory[key] ?? []), value];
    if (arr.length > MAX_POINTS) arr.shift();
    nextHistory[key] = arr;
  }

  const nextColors = ensureSeriesColors(Object.keys(frame.values ?? {}), currentSnapshot.seriesColors);

  applySnapshot({
    labels: nextLabels,
    seriesHistory: nextHistory,
    parameterMeta: currentSnapshot.parameterMeta,
    telemetry: {
      deviceId: frame.deviceId,
      values: {
        ...(currentSnapshot.telemetry?.values ?? {}),
        ...(frame.values ?? {}),
      },
    },
    enabledSeries: currentSnapshot.enabledSeries,
    seriesColors: nextColors,
    poppedValueKeys: currentSnapshot.poppedValueKeys,
  });
}

function ensureFramePump(): void {
  if (framePumpTimerId !== null) return;

  const run = () => {
    const nowPerfMs = performance.now();
    framePumpTimerId = null;

    const nowMs = Date.now();
    pruneBufferedFrames(nowMs);

    const latest = bufferedFrames[bufferedFrames.length - 1];
    const streamLooksStalled =
      lastRawFrameReceivedAtMs > 0 &&
      nowMs - lastRawFrameReceivedAtMs >= FRAME_INTERVAL_MS * 4;

    if (latest && !streamLooksStalled) {
      const bufferedTargetTimestamp = latest.timestamp - JITTER_BUFFER_DELAY_MS;
      const playableMaxTimestamp = latest.timestamp + MAX_EXTRAPOLATION_HOLD_MS;

      if (renderCursorTimestampMs <= 0) {
        renderCursorTimestampMs = bufferedTargetTimestamp;
      } else {
        renderCursorTimestampMs += FRAME_INTERVAL_MS;
      }

      if (renderCursorTimestampMs < bufferedTargetTimestamp - FRAME_INTERVAL_MS * 2) {
        renderCursorTimestampMs = bufferedTargetTimestamp - FRAME_INTERVAL_MS;
      }

      const targetTimestamp = Math.min(renderCursorTimestampMs, playableMaxTimestamp);
      const sampled = sampleFrameAt(targetTimestamp);
      if (sampled && sampled.timestamp > lastRenderedTimestampMs) {
        lastRenderedTimestampMs = sampled.timestamp;
        hasDirectFrames = true;
        appendFrameToSnapshot(sampled);
      }
    }

    if (!directConnection || directConnection.state === signalR.HubConnectionState.Disconnected) {
      return;
    }

    const base = frameNextTickAtMs > 0 ? frameNextTickAtMs : nowPerfMs;
    frameNextTickAtMs = base + FRAME_INTERVAL_MS;
    const delayMs = Math.max(0, frameNextTickAtMs - performance.now());
    framePumpTimerId = setTimeout(run, delayMs);
  };

  frameNextTickAtMs = performance.now() + FRAME_INTERVAL_MS;
  framePumpTimerId = setTimeout(run, FRAME_INTERVAL_MS);
}

async function stopDirectConnection(): Promise<void> {
  if (!directConnection) return;

  try {
    await directConnection.stop();
  } catch (err) {
    console.warn("[TelemetryPopout] Failed to stop direct connection", err);
  } finally {
    directConnection = null;
    clearFramePump();
  }
}

async function ensureDirectConnection(session: TelemetrySessionPayload): Promise<void> {
  const token = typeof session.token === "string" ? session.token : null;
  const deviceId = typeof session.deviceId === "string" ? session.deviceId : null;
  if (!token || !deviceId) return;

  if (directConnection && directToken === token && directDeviceId === deviceId) {
    return;
  }

  await stopDirectConnection();
  directToken = token;
  directDeviceId = deviceId;

  const connection = new signalR.HubConnectionBuilder()
    .withUrl(`${telemetryUrls.telemetryHub}?access_token=${token}`)
    .withAutomaticReconnect()
    .build();

  connection.on("TelemetryMetaUpdated", (frame: TelemetryMetaFrameDto) => {
    const nextMeta = { ...currentSnapshot.parameterMeta };
    for (const meta of mapRawMetaToParameterMeta(frame)) {
      nextMeta[meta.key] = meta;
    }

    applySnapshot({
      ...currentSnapshot,
      parameterMeta: nextMeta,
    });
  });

  connection.on("TelemetryUpdated", (frame: TelemetryFrameDto) => {
    const mapped = mapRawFrameToTelemetry(frame);
    lastRawFrameReceivedAtMs = Date.now();
    pushFrame(mapped);
    pruneBufferedFrames(lastRawFrameReceivedAtMs);
    ensureFramePump();
  });

  connection.on("TelemetryStreamStatus", (status: any) => {
    parseStopReason(status?.reason);
    clearFramePump();
  });

  connection.onreconnected(async () => {
    try {
      await connection.invoke("JoinDeviceGroup", deviceId);
    } catch (err) {
      console.warn("[TelemetryPopout] Failed to rejoin device group", err);
    }
  });

  connection.onclose(() => {
    directConnection = null;
    clearFramePump();
  });

  try {
    await connection.start();
    await connection.invoke("JoinDeviceGroup", deviceId);
    directConnection = connection;
  } catch (err) {
    console.warn("[TelemetryPopout] Failed to start direct connection", err);
    await stopDirectConnection();
  }
}

if (typeof window !== "undefined" && window.opener) {
  window.opener.postMessage({ type: "telemetry:ready" }, window.location.origin);
}

if (typeof window !== "undefined") {
  window.addEventListener("message", (e) => {
    if (e.data?.type === "telemetry:session") {
      void ensureDirectConnection((e.data?.payload ?? {}) as TelemetrySessionPayload);
      return;
    }

    if (e.data?.type === "telemetry:payload") {
      mergeUiPayload((e.data?.payload ?? {}) as TelemetryPayload);
    }
  });

  window.addEventListener("beforeunload", () => {
    void stopDirectConnection();
  });
}
