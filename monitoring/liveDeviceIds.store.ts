import { writable } from "svelte/store";

// Store for live device ids (Set for fast lookup)
export const liveDeviceIds = writable<Set<string>>(new Set());

export function setLiveDeviceIds(ids: string[] | null | undefined) {
  liveDeviceIds.set(new Set((ids ?? []).filter(Boolean)));
}