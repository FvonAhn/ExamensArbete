import * as signalR from "@microsoft/signalr";
import { writable } from "svelte/store";
import type { PositionDto, TelemetryFrameDto } from "$lib/monitoring/telemetry.domain";
import { telemetryUrls } from "$lib/monitoring/telemetry.config";

export const latestPosition = writable<PositionDto | null>(null);

type LocationMapSessionPayload = {
  token?: string | null;
  deviceId?: string | null;
};

let directConnection: signalR.HubConnection | null = null;
let directToken: string | null = null;
let directDeviceId: string | null = null;

async function stopDirectConnection(): Promise<void> {
  if (!directConnection) return;

  try {
    await directConnection.stop();
  } catch (err) {
    console.warn("[LocationMapPopout] Failed to stop direct connection", err);
  } finally {
    directConnection = null;
  }
}

async function ensureDirectConnection(session: LocationMapSessionPayload): Promise<void> {
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

  connection.on("TelemetryUpdated", (frame: TelemetryFrameDto) => {
    latestPosition.set((frame.position as PositionDto | null | undefined) ?? null);
  });

  connection.onreconnected(async () => {
    try {
      await connection.invoke("JoinDeviceGroup", deviceId);
    } catch (err) {
      console.warn("[LocationMapPopout] Failed to rejoin device group", err);
    }
  });

  connection.onclose(() => {
    directConnection = null;
  });

  try {
    await connection.start();
    await connection.invoke("JoinDeviceGroup", deviceId);
    directConnection = connection;
  } catch (err) {
    console.warn("[LocationMapPopout] Failed to start direct connection", err);
    await stopDirectConnection();
  }
}

if (typeof window !== "undefined") {
  if (window.opener) {
    window.opener.postMessage({ type: "location-map:ready" }, window.location.origin);
  }

  window.addEventListener("message", (e) => {
    if (e.data?.type === "location-map:session") {
      void ensureDirectConnection((e.data.payload ?? {}) as LocationMapSessionPayload);
      return;
    }

    if (e.data?.type === "location-map:payload") {
      latestPosition.set((e.data.payload as PositionDto | null) ?? null);
    }
  });

  window.addEventListener("beforeunload", () => {
    void stopDirectConnection();
  });
}
