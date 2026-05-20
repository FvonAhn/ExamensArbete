import { get, writable } from "svelte/store";
import type { PositionDto } from "./telemetry.domain";
import { locationMapWindow } from "$lib/popout/popout.logic";
import { telemetryRuntimeSession } from "./telemetry.runtime.store";
import { selectedDeviceId } from "./telemetry.session.store";
import { telemetryConfig } from "./telemetry.config";

export const latestPosition = writable<PositionDto | null>(null);

export function setLatestPosition(position: PositionDto | null) {
  latestPosition.set(position);
  broadcastLatestPosition();
}

export function clearLatestPosition() {
  setLatestPosition(null);
}

export function getLatestPositionSnapshot(): PositionDto | null {
  return get(latestPosition);
}

function broadcastLatestPosition() {
  if (typeof window === "undefined") return;

  const w = get(locationMapWindow);
  if (!w || w.closed) return;

  w.postMessage(
    { type: "location-map:payload", payload: getLatestPositionSnapshot() },
    window.location.origin
  );
}

if (typeof window !== "undefined") {
  window.addEventListener("message", (e) => {
    if (e.data?.type !== "location-map:ready") return;

    const w = get(locationMapWindow);
    if (!w) return;

    const runtime = get(telemetryRuntimeSession);
    const deviceId = get(selectedDeviceId) ?? telemetryConfig.defaultDeviceId;

    w.postMessage(
      {
        type: "location-map:session",
        payload: {
          token: runtime.token ?? null,
          deviceId,
        },
      },
      window.location.origin
    );

    w.postMessage(
      { type: "location-map:payload", payload: getLatestPositionSnapshot() },
      window.location.origin
    );
  });
}
