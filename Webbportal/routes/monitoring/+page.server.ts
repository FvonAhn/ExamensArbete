import type { PageServerLoad } from "./$types";
import { apiFetch } from "$lib/api";
import { BASE_URL } from "../../utils/backend-constants";

type DeviceDto = {
  maptunerId: string;
  isShared: boolean;
  name: string;
  userEmail: string;
};

export const load: PageServerLoad = async ({ locals, parent }) => {
  const accessToken = (locals as { accessToken?: string }).accessToken?.trim();

  if (!accessToken) {
    throw new Error("User not authenticated");
  }

  const parentData = await parent();

  // SignalR expects the raw token (without "Bearer ")
  const telemetryToken = accessToken.startsWith("Bearer ")
    ? accessToken.slice(7)
    : accessToken;

  const res = await apiFetch(`${BASE_URL}/api/monitoring/maptuners`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: accessToken,
    },
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(errorText || `Failed to fetch devices (${res.status})`);
  }

  const devices = (await res.json()) as DeviceDto[];

  return {
    ...parentData,
    accessToken,
    telemetryToken,
    devices,
  };
};
