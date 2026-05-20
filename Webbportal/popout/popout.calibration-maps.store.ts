import * as signalR from "@microsoft/signalr";
import { writable } from "svelte/store";
import {
  mapRawFrameToTelemetry,
  mapRawMetaToParameterMeta,
  type TelemetryFrameDto,
  type TelemetryMetaFrameDto,
  type TelemetryParameterMeta,
} from "$lib/monitoring/telemetry.domain";
import { telemetryUrls } from "$lib/monitoring/telemetry.config";

export const liveVehicleVin = writable<string | null>(null);
export const liveTelemetryValues = writable<Record<string, number>>({});
export const liveParameterMeta = writable<Record<string, TelemetryParameterMeta>>({});

type CalibrationMapsPayload = {
  vin?: string | null;
  telemetry?: Record<string, number>;
  parameterMeta?: Record<string, TelemetryParameterMeta>;
};

type CalibrationMapsSessionPayload = {
  token?: string | null;
  deviceId?: string | null;
};

let directConnection: signalR.HubConnection | null = null;
let directToken: string | null = null;
let directDeviceId: string | null = null;
let hasDirectFrames = false;

function resolveVehicleVin(vin: string | null | undefined): string | null {
  return vin ?? null;
}

function mergeNumericValues(values: Record<string, number> | null | undefined): void {
  if (!values || typeof values !== "object") return;

  liveTelemetryValues.update((current) => ({
    ...current,
    ...values,
  }));
}

function mergeParameterMeta(nextMeta: Record<string, TelemetryParameterMeta> | null | undefined): void {
  if (!nextMeta || typeof nextMeta !== "object") return;

  liveParameterMeta.update((current) => ({
    ...current,
    ...nextMeta,
  }));
}

function mergeUiPayload(payload: CalibrationMapsPayload): void {
  const vin = payload?.vin;
  if (typeof vin === "string" || vin === null) {
    liveVehicleVin.set(resolveVehicleVin(vin));
  }

  if (!hasDirectFrames) {
    liveTelemetryValues.set(
      payload?.telemetry && typeof payload.telemetry === "object" ? payload.telemetry : {},
    );
    liveParameterMeta.set(
      payload?.parameterMeta && typeof payload.parameterMeta === "object"
        ? payload.parameterMeta
        : {},
    );
    return;
  }

  mergeNumericValues(payload?.telemetry);
  mergeParameterMeta(payload?.parameterMeta);
}

async function stopDirectConnection(): Promise<void> {
  if (!directConnection) return;

  try {
    await directConnection.stop();
  } catch (err) {
    console.warn("[CalibrationMapsPopout] Failed to stop direct connection", err);
  } finally {
    directConnection = null;
    hasDirectFrames = false;
  }
}

async function ensureDirectConnection(session: CalibrationMapsSessionPayload): Promise<void> {
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
    const nextMeta: Record<string, TelemetryParameterMeta> = {};
    for (const meta of mapRawMetaToParameterMeta(frame)) {
      nextMeta[meta.key] = meta;
    }

    mergeParameterMeta(nextMeta);

    if (typeof frame.vin === "string" || frame.vin === null) {
      liveVehicleVin.set(resolveVehicleVin(frame.vin));
    }
  });

  connection.on("TelemetryUpdated", (frame: TelemetryFrameDto) => {
    const mapped = mapRawFrameToTelemetry(frame);
    hasDirectFrames = true;
    mergeNumericValues(mapped.values);
  });

  connection.onreconnected(async () => {
    try {
      await connection.invoke("JoinDeviceGroup", deviceId);
    } catch (err) {
      console.warn("[CalibrationMapsPopout] Failed to rejoin device group", err);
    }
  });

  connection.onclose(() => {
    directConnection = null;
    hasDirectFrames = false;
  });

  try {
    await connection.start();
    await connection.invoke("JoinDeviceGroup", deviceId);
    directConnection = connection;
  } catch (err) {
    console.warn("[CalibrationMapsPopout] Failed to start direct connection", err);
    await stopDirectConnection();
  }
}

if (typeof window !== "undefined") {
  if (window.opener) {
    window.opener.postMessage({ type: "calibration-maps:ready" }, window.location.origin);
  }

  window.addEventListener("message", (e) => {
    if (e.data?.type === "calibration-maps:session") {
      void ensureDirectConnection((e.data?.payload ?? {}) as CalibrationMapsSessionPayload);
      return;
    }

    if (e.data?.type === "calibration-maps:payload") {
      mergeUiPayload((e.data?.payload ?? {}) as CalibrationMapsPayload);
    }
  });

  window.addEventListener("beforeunload", () => {
    void stopDirectConnection();
  });
}
