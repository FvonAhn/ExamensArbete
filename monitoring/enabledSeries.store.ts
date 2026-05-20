import { writable, derived } from "svelte/store";

export const MAX_ENABLED = 4;

export const enabledSeriesKeys = writable<Set<string>>(new Set());

export const enabledSeries = derived(
  enabledSeriesKeys,
  ($keys) => Array.from($keys)
);
