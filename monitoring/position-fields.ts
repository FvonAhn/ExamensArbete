import type { PositionDto } from "./telemetry.domain";

export type PositionSnapshotRow = {
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  rawSpeedMps: number | null;
  heading: number | null;
  altitude: number | null;
  altitudeAccuracy: number | null;
};

export type PositionFieldDef = {
  key: keyof PositionSnapshotRow;
  label: string;
  header: string;
  unit: string;
  digits?: number;
};

export const POSITION_FIELD_DEFS: PositionFieldDef[] = [
  { key: "latitude", label: "Lat", header: "Latitude", unit: "deg", digits: 6 },
  { key: "longitude", label: "Lon", header: "Longitude", unit: "deg", digits: 6 },
  { key: "accuracy", label: "Accuracy", header: "Accuracy", unit: "m" },
  { key: "rawSpeedMps", label: "Speed", header: "Raw Speed (GPS)", unit: "m/s" },
  { key: "heading", label: "Heading", header: "Heading", unit: "deg" },
  { key: "altitude", label: "Altitude", header: "Altitude", unit: "m" },
  { key: "altitudeAccuracy", label: "AltAccuracy", header: "Altitude Accuracy", unit: "m" },
];

function toFiniteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function toPositionSnapshot(
  position: PositionDto | null | undefined,
): PositionSnapshotRow {
  return {
    latitude: toFiniteOrNull(position?.latitude),
    longitude: toFiniteOrNull(position?.longitude),
    accuracy: toFiniteOrNull(position?.accuracy),
    rawSpeedMps: toFiniteOrNull(position?.speed),
    heading: toFiniteOrNull(position?.heading),
    altitude: toFiniteOrNull(position?.altitude),
    altitudeAccuracy: toFiniteOrNull(position?.altitudeAccuracy),
  };
}
