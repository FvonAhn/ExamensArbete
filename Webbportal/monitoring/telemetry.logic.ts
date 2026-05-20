import { derived, writable, get } from "svelte/store";
import { telemetry, parameterMeta } from "./telemetry.store";
import { highlightedSeriesKey } from "./telemetry.store";
import { vehicleVin } from "./telemetry.store";
import { enabledSeries, enabledSeriesKeys, MAX_ENABLED } from "./enabledSeries.store";
import { selectedDeviceId } from "./telemetry.session.store";
import { telemetryConfig } from "./telemetry.config";

export const hasInitialized = writable(false);

const ENABLED_SERIES_CACHE_STORAGE_KEY = "suite.telemetry.enabledSeriesByDeviceVin";
const ENABLED_SERIES_CACHE_LIMIT = 40;

type EnabledSeriesCacheEntry = {
  keys: string[];
  updatedAt: number;
};

function normalizeScopePart(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getEnabledSeriesScopeKey(deviceId: string | null, vin: string | null): string | null {
  const normalizedDeviceId = normalizeScopePart(deviceId);
  const normalizedVin = normalizeScopePart(vin);

  if (!normalizedDeviceId || !normalizedVin) return null;
  return `${normalizedDeviceId}::${normalizedVin.toUpperCase()}`;
}

function readEnabledSeriesCache(): Record<string, EnabledSeriesCacheEntry> {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return {};

  try {
    const raw = localStorage.getItem(ENABLED_SERIES_CACHE_STORAGE_KEY);
    if (!raw) return {};

    const parsed = JSON.parse(raw) as Record<string, EnabledSeriesCacheEntry> | null;
    if (!parsed || typeof parsed !== "object") return {};

    return Object.fromEntries(
      Object.entries(parsed).filter(([, entry]) =>
        !!entry &&
        Array.isArray(entry.keys) &&
        typeof entry.updatedAt === "number",
      ),
    );
  } catch {
    return {};
  }
}

function writeEnabledSeriesCache(cache: Record<string, EnabledSeriesCacheEntry>): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return;

  try {
    const limitedEntries = Object.entries(cache)
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, ENABLED_SERIES_CACHE_LIMIT);

    localStorage.setItem(
      ENABLED_SERIES_CACHE_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(limitedEntries)),
    );
  } catch {
    // Ignore local cache write failures.
  }
}

function loadEnabledSeriesForScope(scopeKey: string): string[] | null {
  const cache = readEnabledSeriesCache();
  const entry = cache[scopeKey];
  if (!entry) return null;

  return entry.keys.filter((key): key is string => typeof key === "string" && key.length > 0);
}

function persistEnabledSeriesForScope(scopeKey: string, keys: string[]): void {
  const dedupedKeys = Array.from(
    new Set(keys.filter((key): key is string => typeof key === "string" && key.length > 0)),
  );

  const cache = readEnabledSeriesCache();
  cache[scopeKey] = {
    keys: dedupedKeys,
    updatedAt: Date.now(),
  };
  writeEnabledSeriesCache(cache);
}

function getCurrentEnabledSeriesScopeKey(): string | null {
  return getEnabledSeriesScopeKey(
    get(selectedDeviceId) ?? telemetryConfig.defaultDeviceId,
    get(vehicleVin),
  );
}

function applySelection(keys: string[]): void {
  enabledSeriesKeys.set(new Set(keys));
  if (!keys.includes(get(highlightedSeriesKey))) {
    highlightedSeriesKey.set(null);
  }
}

let lastAppliedScopeKey: string | null = null;

export function extractParamNameFromKey(key: string): string {
  const parts = key.split("#");
  if (parts.length >= 2) return parts[1];
  return key.replace(/^Vehicle/, "");
}

export const valueKeys = derived(telemetry, ($t) =>
  Object.keys($t?.values ?? {})
);

export const metaMap = derived(parameterMeta, ($m) => $m ?? {});

export const visibleSeries = derived(
  [valueKeys, metaMap],
  ([$valueKeys, $metaMap]) =>
    $valueKeys.map((key) => {
      const meta = $metaMap[key];

      return (
        meta ?? {
          key,
          name: extractParamNameFromKey(key),
        }
      );
    })
);

visibleSeries.subscribe((list) => {
  if (get(hasInitialized)) return;
  if (list.length === 0) return;

  const scopeKey = getCurrentEnabledSeriesScopeKey();
  const availableKeys = new Set(list.map((m) => m.key));
  const cachedKeys = scopeKey ? loadEnabledSeriesForScope(scopeKey) : null;
  const nextKeys = cachedKeys !== null
    ? cachedKeys.filter((key) => availableKeys.has(key))
    : list.slice(0, MAX_ENABLED).map((m) => m.key);

  applySelection(nextKeys);
  lastAppliedScopeKey = scopeKey;
  hasInitialized.set(true);
});

derived(
  [selectedDeviceId, vehicleVin],
  ([$selectedDeviceId, $vehicleVin]) =>
    getEnabledSeriesScopeKey($selectedDeviceId ?? telemetryConfig.defaultDeviceId, $vehicleVin),
).subscribe((scopeKey) => {
  if (scopeKey === lastAppliedScopeKey) return;

  hasInitialized.set(false);
});

enabledSeries.subscribe(($enabledSeries) => {
  if (!get(hasInitialized)) return;

  const scopeKey = getCurrentEnabledSeriesScopeKey();
  if (!scopeKey) return;

  persistEnabledSeriesForScope(scopeKey, $enabledSeries);
});

export function toggleSeries(key: string) {
  enabledSeriesKeys.update((prev) => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    if (!next.has(get(highlightedSeriesKey))) {
      highlightedSeriesKey.set(null);
    }
    return next;
  });
}

export function disableSeries(key: string) {
  enabledSeriesKeys.update((prev) => {
    const next = new Set(prev);
    next.delete(key);
    if (!next.has(get(highlightedSeriesKey))) {
      highlightedSeriesKey.set(null);
    }
    return next;
  });
}

export function clearAllEnabledSeries() {
  enabledSeriesKeys.set(new Set());
  highlightedSeriesKey.set(null);
}

export function enableSeriesByKeys(keys: string[]) {
  enabledSeriesKeys.set(new Set(keys.filter((key) => typeof key === "string" && key.length > 0)));
}
