import { writable } from 'svelte/store';

export type TelemetryTileSize = 'compact' | 'detailed';

export const TELEMETRY_TILE_SIZE_OPTIONS = [
  { value: 'compact', label: 'Compact' },
  { value: 'detailed', label: 'Detailed' },
] as const;

const TELEMETRY_TILE_SIZE_STORAGE_KEY = 'suite.telemetry.tileSize';
const DEFAULT_TILE_SIZE: TelemetryTileSize = 'compact';

function isTelemetryTileSize(value: unknown): value is TelemetryTileSize {
  return value === 'compact' || value === 'detailed';
}

function createTelemetryTileSizePreference() {
  const storedValue =
    typeof window !== 'undefined'
      ? window.localStorage.getItem(TELEMETRY_TILE_SIZE_STORAGE_KEY)
      : null;

  const initialValue = isTelemetryTileSize(storedValue) ? storedValue : DEFAULT_TILE_SIZE;

  const { subscribe, set } = writable<TelemetryTileSize>(initialValue);

  return {
    subscribe,
    set: (value: TelemetryTileSize) => {
      set(value);

      if (typeof window === 'undefined') return;

      try {
        window.localStorage.setItem(TELEMETRY_TILE_SIZE_STORAGE_KEY, value);
      } catch {
        // Ignore persistence failures.
      }
    },
  };
}

export const telemetryTileSizePreference = createTelemetryTileSizePreference();
