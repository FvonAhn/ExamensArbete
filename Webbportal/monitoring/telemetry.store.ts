import { writable, get } from "svelte/store";
import type { TelemetryLiveFrame, TelemetryParameterMeta } from "./telemetry.domain";
import { telemetryWindow, chartWindow, calibrationMapsWindow, valuePopoutWindows } from "../popout/popout.logic";
import { enabledSeries } from "./enabledSeries.store";
import { ensureSeriesColors } from "./telemetry.chartOptions";
import { telemetryRuntimeSession } from "./telemetry.runtime.store";
import { selectedDeviceId } from "./telemetry.session.store";
import { telemetryConfig } from "./telemetry.config";
import { DEFAULT_TOOLTIP_OPACITY, normalizeTooltipOpacity } from "../chart-tooltip";

export interface TelemetryState {
  deviceId: string;
  values: Record<string, number>;
}

export interface TelemetryChartSnapshot {
  labels: string[];
  seriesHistory: Record<string, number[]>;
  parameterMeta: Record<string, TelemetryParameterMeta>;
  enabledSeries: string[];
  seriesColors: Record<string, string>;
  windowSeconds: number;
  highlightedSeriesKey: string | null;
  tooltipOpacity: number;
}

const DEFAULT_CHART_WINDOW_SECONDS = 60;
const MAX_RETAINED_POINTS = 2400;

export const labels = writable<string[]>([]);
export const seriesHistory = writable<Record<string, number[]>>({});
export const parameterMeta = writable<Record<string, TelemetryParameterMeta>>({});
export const telemetry = writable<TelemetryState>({ deviceId: "N/A", values: {} });
export const chartSnapshot = writable<TelemetryChartSnapshot>({
  labels: [],
  seriesHistory: {},
  parameterMeta: {},
  enabledSeries: [],
  seriesColors: {},
  windowSeconds: DEFAULT_CHART_WINDOW_SECONDS,
  highlightedSeriesKey: null,
  tooltipOpacity: DEFAULT_TOOLTIP_OPACITY,
});
export const chartWindowSeconds = writable<number>(DEFAULT_CHART_WINDOW_SECONDS);
export const highlightedSeriesKey = writable<string | null>(null);
export const chartTooltipOpacity = writable<number>(DEFAULT_TOOLTIP_OPACITY);

export const latencyMs = writable<number | null>(null);
export const refreshRateStr = writable<string | null>(null);

export const vehicleName = writable<string | null>(null);
export const vehicleVin = writable<string | null>(null);

// Color map for stable per-series rendering in the chart
export const seriesColors = writable<Record<string, string>>({});

export type StreamStopReason = "user" | "unexpected" | "timeout";

export const streamStatus = writable<{
  state: "running" | "stopped";
  reason?: StreamStopReason;
  timestampMs?: number;
  message?: string;
  dismissed?: boolean;
} | null>(null);

// Require a few consecutive frames before auto-resuming after a stop
const RESUME_FRAME_THRESHOLD = 2;
const resumeFrameCountByDevice = writable<Record<string, number>>({});
// ----------------------------------------------------
// Canonical GPS speed handling
// ----------------------------------------------------
// We have historically seen both of these keys in the system.
// Suite should NEVER show both at the same time.
const GPS_SPEED_KEY_CANON = "GPS#speedGps";
const GPS_SPEED_KEY_ALT = "GPS#speedGps#0";

function canonicalizeTelemetryValues(
  incoming: Record<string, number> | undefined | null,
): Record<string, number> {
  const values = { ...(incoming ?? {}) };

  const hasCanon = Object.prototype.hasOwnProperty.call(values, GPS_SPEED_KEY_CANON);
  const hasAlt = Object.prototype.hasOwnProperty.call(values, GPS_SPEED_KEY_ALT);

  // If both exist -> keep canonical, drop alt to avoid double tiles
  if (hasCanon && hasAlt) {
    delete values[GPS_SPEED_KEY_ALT];
    return values;
  }

  // If only alt exists -> rename it to canonical
  if (!hasCanon && hasAlt) {
    values[GPS_SPEED_KEY_CANON] = values[GPS_SPEED_KEY_ALT];
    delete values[GPS_SPEED_KEY_ALT];
  }

  return values;
}

function withGpsSpeedMetaAliases(
  map: Record<string, TelemetryParameterMeta>,
): Record<string, TelemetryParameterMeta> {
  const next = { ...map };

  const canon = next[GPS_SPEED_KEY_CANON];
  const alt = next[GPS_SPEED_KEY_ALT];

  // If we have one, ensure the other exists pointing to the same meta
  if (canon && !alt) next[GPS_SPEED_KEY_ALT] = canon;
  if (alt && !canon) next[GPS_SPEED_KEY_CANON] = alt;

  return next;
}

function syncChartSnapshot(): void {
  chartSnapshot.set({
    labels: get(labels),
    seriesHistory: get(seriesHistory),
    parameterMeta: get(parameterMeta),
    enabledSeries: get(enabledSeries),
    seriesColors: get(seriesColors),
    windowSeconds: get(chartWindowSeconds),
    highlightedSeriesKey: get(highlightedSeriesKey),
    tooltipOpacity: get(chartTooltipOpacity),
  });
}

export function setChartWindowSeconds(value: number): void {
  const normalized = Number.isFinite(value) ? Math.max(10, Math.min(60, Math.round(value))) : DEFAULT_CHART_WINDOW_SECONDS;
  chartWindowSeconds.set(normalized);
  syncChartSnapshot();
  scheduleBroadcasts();
}

export function setChartTooltipOpacity(value: number): void {
  chartTooltipOpacity.set(normalizeTooltipOpacity(value));
  syncChartSnapshot();
  scheduleBroadcasts();
}

export function setHighlightedSeriesKey(value: string | null): void {
  highlightedSeriesKey.set(typeof value === "string" && value.trim() ? value : null);
  syncChartSnapshot();
  scheduleBroadcasts();
}

// Clears all stores that represent live state for the selected device
export function resetTelemetryState(): void {
  labels.set([]);
  seriesHistory.set({});
  parameterMeta.set({});
  telemetry.set({ deviceId: "N/A", values: {} });
  latencyMs.set(null);
  refreshRateStr.set(null);
  vehicleName.set(null);
  vehicleVin.set(null);
  seriesColors.set({});
  streamStatus.set(null);
  resumeFrameCountByDevice.set({});
  syncChartSnapshot();

  // Ensure popouts clear immediately when device changes
  scheduleBroadcasts();
}

export function dismissStreamStatus(): void {
  streamStatus.update((prev) => (prev ? { ...prev, dismissed: true } : prev));
}

export function markStreamStopped(reason: StreamStopReason, timestampMs?: number) {
  const message =
    reason === "user"
      ? "Broadcast was stopped by user."
      : reason === "timeout"
        ? "No telemetry received. Broadcast may have stopped."
        : "Broadcast ended unexpectedly.";

  streamStatus.set({
    state: "stopped",
    reason,
    timestampMs,
    message,
    dismissed: false,
  });

  refreshRateStr.set(null);
  latencyMs.set(null);

  const currentDeviceId = get(telemetry).deviceId;
  if (currentDeviceId && currentDeviceId !== "N/A") {
    resumeFrameCountByDevice.update((m) => ({ ...m, [currentDeviceId]: 0 }));
  }
}

// Replaces the parameter metadata map (key -> meta)
export function setTelemetryMeta(parameters: TelemetryParameterMeta[]): void {
  const incoming: Record<string, TelemetryParameterMeta> = {};
  for (const p of parameters) incoming[p.key] = p;

  // Merge instead of replace, so GPS meta doesn't disappear
  parameterMeta.update((prev) => {
    const merged = { ...prev, ...incoming };
    return withGpsSpeedMetaAliases(merged);
  });
  syncChartSnapshot();
}

// Stores vehicle identity metadata (separate from parameter metadata)
export function setVehicleMeta(meta: { vehicleName?: string | null; vin?: string | null }): void {
  vehicleName.set(meta.vehicleName ?? null);
  vehicleVin.set(meta.vin ?? null);
}

export function updateLatencyFromTimestamp(timestamp: number): void {
  if (!timestamp || !Number.isFinite(timestamp)) {
    latencyMs.set(null);
    return;
  }

  const latency = Date.now() - timestamp;
  latencyMs.update((prev) => (prev === null ? latency : Math.round(prev * 0.8 + latency * 0.2)));
}

// Uses server-provided total latency (app -> server -> webapp), with RTT fallback
export function updateLatencyFromSummary(summary: {
  appToServerRttMs?: number | null;
  webAppToServerRttMs?: number | null;
  totalLatencyMs?: number | null;
}): void {
  if (summary.totalLatencyMs != null && summary.totalLatencyMs > 0) {
    const newLatency = summary.totalLatencyMs;
    latencyMs.update((prev) =>
      prev === null ? newLatency : Math.round(prev * 0.8 + newLatency * 0.2)
    );
    return;
  }

  if ((summary.appToServerRttMs ?? 0) > 0 && (summary.webAppToServerRttMs ?? 0) > 0) {
    const calculatedTotal = Math.round(
      summary.appToServerRttMs! / 2 + summary.webAppToServerRttMs! / 2
    );

    latencyMs.update((prev) =>
      prev === null ? calculatedTotal : Math.round(prev * 0.8 + calculatedTotal * 0.2)
    );
    return;
  }

  latencyMs.set(null);
}

// Full snapshot for telemetry popout (tiles/table need the device state too)
export function getTelemetrySnapshot() {
  return {
    labels: get(labels),
    seriesHistory: get(seriesHistory),
    parameterMeta: get(parameterMeta),
    telemetry: get(telemetry),
    enabledSeries: get(enabledSeries),
    seriesColors: get(seriesColors),
    vehicleName: get(vehicleName),
    vin: get(vehicleVin),
    // Expose which value-popout windows are currently open so that
    // the telemetry popout window can reflect popped-out state in its UI.
    poppedValueKeys: Array.from(get(valuePopoutWindows).keys()),
  };
}

// Smaller snapshot for chart popout
export function getChartSnapshot() {
  return get(chartSnapshot);
}

/**
 * Build a minimal snapshot for a specific value popout.
 * Only includes data for the specific key to reduce payload size.
 */
function getValuePopoutSnapshot(key: string) {
  const allLabels = get(labels);
  const allHistory = get(seriesHistory);
  const allMeta = get(parameterMeta);
  const allTelemetry = get(telemetry);
  const allColors = get(seriesColors);

  // Only include data for the specific key
  return {
    labels: allLabels,
    seriesHistory: key in allHistory ? { [key]: allHistory[key] } : {},
    parameterMeta: key in allMeta ? { [key]: allMeta[key] } : {},
    telemetry: {
      deviceId: allTelemetry.deviceId,
      values: key in allTelemetry.values ? { [key]: allTelemetry.values[key] } : {},
    },
    enabledSeries: [key],
    seriesColors: key in allColors ? { [key]: allColors[key] } : {},
  };
}

/** Send telemetry snapshot ONLY to telemetryWindow (the telemetry/popout). */
function broadcastTelemetrySnapshot() {
  try {
    const w = get(telemetryWindow);
    if (w && !w.closed) {
      w.postMessage({ type: "telemetry:payload", payload: getTelemetrySnapshot() });
    }
  } catch (err) {
    console.error("[Telemetry] broadcastTelemetrySnapshot failed", err);
  }
}

function broadcastChartSnapshot() {
  try {
    const w = get(chartWindow);
    if (w && !w.closed) {
      w.postMessage({ type: "chart:payload", payload: getChartSnapshot() });
    }
  } catch (err) {
    console.error("[Telemetry] broadcastChartSnapshot failed", err);
  }
}

function broadcastCalibrationMapsSnapshot() {
  try {
    const w = get(calibrationMapsWindow);
    if (w && !w.closed) {
      w.postMessage(
        {
          type: "calibration-maps:payload",
          payload: {
            vin: get(vehicleVin),
            telemetry: get(telemetry).values,
            parameterMeta: get(parameterMeta),
          },
        },
        window.location.origin
      );
    }
  } catch (err) {
    console.error("[Telemetry] broadcastCalibrationMapsSnapshot failed", err);
  }
}

/** Send telemetry snapshot to all value popout windows. */
function broadcastValuePopoutSnapshots() {
  try {
    const windows = get(valuePopoutWindows);
    if (windows.size === 0) return; // Early return if no windows

    // Create minimal snapshots per key instead of sending full snapshot to all
    for (const [key, w] of windows.entries()) {
      if (w) {
        try {
          // Try to send data - when maximized, window.closed might incorrectly return true
          // So we try to send anyway and catch errors
          const snapshot = getValuePopoutSnapshot(key);
          // Use "*" origin to handle maximization issues
          w.postMessage({ type: "telemetry:payload", payload: snapshot }, "*");
        } catch (err) {
          // Only remove window if we get a specific error indicating it's truly closed
          // Some errors when maximized are expected and should be ignored
          const errorMsg = err instanceof Error ? err.message : String(err);
          if (errorMsg.includes("target") || errorMsg.includes("closed")) {
            // Window is likely actually closed, remove it
            console.warn(`[Telemetry] Window for key ${key} appears closed, removing from list`);
            valuePopoutWindows.update((map) => {
              const newMap = new Map(map);
              newMap.delete(key);
              return newMap;
            });
          }
          // Otherwise, silently continue - window might be maximized and still valid
        }
      }
    }
  } catch (err) {
    console.error("[Telemetry] broadcastValuePopoutSnapshots failed", err);
  }
}

// -------------------------
// Broadcast throttling
// -------------------------
// Throttle broadcasts to max ~60fps to reduce overhead when multiple popouts are open
let broadcastScheduled = false;
let lastBroadcastTime = 0;
const BROADCAST_THROTTLE_MS = 16; // ~60fps max

function scheduleBroadcasts() {
  // In hidden tabs/windows, requestAnimationFrame is heavily throttled.
  // Push snapshots directly so visible popouts keep smooth updates.
  if (typeof document !== "undefined" && document.hidden) {
    const now = Date.now();
    if (now - lastBroadcastTime >= BROADCAST_THROTTLE_MS) {
      broadcastTelemetrySnapshot();
      broadcastChartSnapshot();
      broadcastCalibrationMapsSnapshot();
      broadcastValuePopoutSnapshots();
      lastBroadcastTime = now;
    }
    return;
  }

  // Use requestAnimationFrame for smooth batching
  if (broadcastScheduled) return;
  broadcastScheduled = true;

  requestAnimationFrame(() => {
    const now = Date.now();
    // Throttle to max once per BROADCAST_THROTTLE_MS
    if (now - lastBroadcastTime >= BROADCAST_THROTTLE_MS) {
      broadcastTelemetrySnapshot();
      broadcastChartSnapshot();
      broadcastCalibrationMapsSnapshot();
      broadcastValuePopoutSnapshots();
      lastBroadcastTime = now;
    }
    broadcastScheduled = false;
  });
}

export function pushTelemetryFrame(frame: TelemetryLiveFrame): void {
  const currentStatus = get(streamStatus);

  if (currentStatus?.state === "stopped") {
    resumeFrameCountByDevice.update((m) => {
      const prev = m[frame.deviceId] ?? 0;
      const next = prev + 1;

      if (next >= RESUME_FRAME_THRESHOLD) {
        streamStatus.set({ state: "running" });
        return { ...m, [frame.deviceId]: 0 };
      }

      return { ...m, [frame.deviceId]: next };
    });
  } else {
    streamStatus.set({ state: "running" });
  }

  // ✅ Canonicalize incoming values (kills double tiles if both keys appear)
  const normalizedValues = canonicalizeTelemetryValues(frame.values);

  telemetry.update((prev) => ({
    deviceId: frame.deviceId,
    values: { ...prev.values, ...normalizedValues },
  }));

  labels.update((prev) => {
    const next = [...prev, frame.timestamp.toString()];
    if (next.length > MAX_RETAINED_POINTS) next.shift();
    return next;
  });

  seriesColors.update((prev) => {
    const keys = Object.keys(normalizedValues ?? {});
    return ensureSeriesColors(keys, prev);
  });

  seriesHistory.update((prev) => {
    const next: Record<string, number[]> = { ...prev };

    for (const [key, value] of Object.entries(normalizedValues)) {
      if (typeof value !== "number") continue;

      const arr = next[key] ? [...next[key]] : [];
      arr.push(value);
      if (arr.length > MAX_RETAINED_POINTS) arr.shift();
      next[key] = arr;
    }

    // ✅ If old alt-key history exists, drop it to prevent stale duplicate series
    if (GPS_SPEED_KEY_ALT in next) {
      delete next[GPS_SPEED_KEY_ALT];
    }

    return next;
  });

  syncChartSnapshot();

  // Broadcast separately — ONLY to the windows that need each payload.
  // Use throttling to avoid too frequent broadcasts
  scheduleBroadcasts();
}

const TELEMETRY_HANDLER_KEY = "__telemetryMessageHandler";
const OPEN_VALUE_POPOUT_PROCESSING_KEY = "__openValuePopoutProcessing";

function telemetryMessageHandler(e: MessageEvent) {
  if (e.data?.type === "telemetry:ready") {
    const w = get(telemetryWindow);
    if (w && !w.closed) {
      const runtime = get(telemetryRuntimeSession);
      const deviceId = get(selectedDeviceId) ?? telemetryConfig.defaultDeviceId;

      w.postMessage(
        {
          type: "telemetry:session",
          payload: {
            token: runtime.token ?? null,
            deviceId,
          },
        },
        window.location.origin
      );
      w.postMessage(
        { type: "telemetry:payload", payload: getTelemetrySnapshot() },
        window.location.origin
      );
    }
  }

    if (e.data?.type === "chart:ready") {
      const w = get(chartWindow);
      if (w && !w.closed) {
        const runtime = get(telemetryRuntimeSession);
        const deviceId = get(selectedDeviceId) ?? telemetryConfig.defaultDeviceId;

        w.postMessage(
          {
            type: "chart:session",
            payload: {
              token: runtime.token ?? null,
              deviceId,
            },
          },
          window.location.origin
        );
        w.postMessage(
          { type: "chart:payload", payload: getChartSnapshot() },
          window.location.origin
        );
      }
    }

    if (e.data?.type === "calibration-maps:ready") {
      const w = get(calibrationMapsWindow);
      if (w && !w.closed) {
        const runtime = get(telemetryRuntimeSession);
        const deviceId = get(selectedDeviceId) ?? telemetryConfig.defaultDeviceId;

        w.postMessage(
          {
            type: "calibration-maps:session",
            payload: {
              token: runtime.token ?? null,
              deviceId,
            },
          },
          window.location.origin
        );
        w.postMessage(
          {
            type: "calibration-maps:payload",
            payload: {
              vin: get(vehicleVin),
              telemetry: get(telemetry).values,
              parameterMeta: get(parameterMeta),
            },
          },
          window.location.origin
        );
      }
    }

    if (e.data?.type === "toggleSeries") {
      import("./telemetry.logic").then((mod) => mod.toggleSeries(e.data.key));
    }

    if (e.data?.type === "series:clear-all") {
      import("./telemetry.logic").then((mod) => mod.clearAllEnabledSeries());
      return;
    }

    if (e.data?.type === "series:add-all") {
      const keys = Array.isArray(e.data?.keys)
        ? e.data.keys.filter((key): key is string => typeof key === "string" && key.length > 0)
        : [];
      import("./telemetry.logic").then((mod) => mod.enableSeriesByKeys(keys));
      return;
    }

    if (e.data?.type === "chart:set-window-seconds") {
      setChartWindowSeconds(Number(e.data?.value));
      return;
    }

    if (e.data?.type === "chart:set-tooltip-opacity") {
      setChartTooltipOpacity(Number(e.data?.value));
      return;
    }

    if (e.data?.type === "hoverSeries") {
      setHighlightedSeriesKey(typeof e.data?.key === "string" ? e.data.key : null);
      return;
    }

    if (e.data?.type === "telemetry-value:ready") {
      const key = e.data.key;
      const windows = get(valuePopoutWindows);
      const w = windows.get(key);
      if (w) {
        try {
          // Check if window is still valid (even when maximized)
          if (!w.closed) {
            const runtime = get(telemetryRuntimeSession);
            const deviceId = get(selectedDeviceId) ?? telemetryConfig.defaultDeviceId;

            w.postMessage(
              {
                type: "telemetry:session",
                payload: {
                  token: runtime.token ?? null,
                  deviceId,
                },
              },
              "*"
            );
            const snapshot = getValuePopoutSnapshot(key);
            // Use "*" to avoid origin issues when maximized
            w.postMessage({ type: "telemetry:payload", payload: snapshot }, "*");
          }
        } catch (err) {
          console.warn(`[Telemetry] Failed to send to value popout for key ${key}`, err);
        }
      }
    }

    if (e.data?.type === "closeValuePopout") {
      const key = e.data.key;
      import("../popout/popout.logic").then((mod) => mod.closeValuePopout(key));
    }

    if (e.data?.type === "openValuePopout") {
      const key = e.data.key;
      if (typeof key !== "string" || !key) return;
      // Block duplicate processing – use window flag so all module instances share it
      const win = window as Window & { [key: string]: unknown };
      if (win[OPEN_VALUE_POPOUT_PROCESSING_KEY]) return;
      win[OPEN_VALUE_POPOUT_PROCESSING_KEY] = true;

      import("./telemetry.logic")
        .then((logicMod) => {
          logicMod.disableSeries(key);
          return import("../popout/popout.logic").then((popoutMod) => {
            const opened = popoutMod.openValuePopout(key);
            if (!opened) logicMod.toggleSeries(key);
            return opened;
          });
        })
        .finally(() => {
          (window as Window & { [key: string]: unknown })[OPEN_VALUE_POPOUT_PROCESSING_KEY] = false;
        });
    }
}

// Only in main window (no opener); popouts add duplicate listeners when they load this module.
// Remove-before-add prevents accumulation from HMR. Processing lock blocks duplicate handling.
if (typeof window !== "undefined" && !window.opener) {
  enabledSeries.subscribe(() => {
    syncChartSnapshot();
    scheduleBroadcasts();
  });
  highlightedSeriesKey.subscribe(() => {
    syncChartSnapshot();
    scheduleBroadcasts();
  });
  const win = window as Window & { [key: string]: unknown };
  const prev = win[TELEMETRY_HANDLER_KEY] as ((e: MessageEvent) => void) | undefined;
  if (prev) window.removeEventListener("message", prev);
  win[TELEMETRY_HANDLER_KEY] = telemetryMessageHandler;
  window.addEventListener("message", telemetryMessageHandler);
}
