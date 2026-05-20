import { writable } from "svelte/store";

export type TelemetryRuntimeSession = {
  token: string | null;
  deviceId: string | null;
};

export const telemetryRuntimeSession = writable<TelemetryRuntimeSession>({
  token: null,
  deviceId: null,
});

