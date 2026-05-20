// Backend DTO for a single parameter definition (TelemetryMetaFrameDto.Parameters)
export interface RawTelemetryParameterDto {
  key: string;
  name: string;
  unit: string;
  module: string;
  min: number;
  max: number;
}

// Backend DTO for metadata broadcast for a device
export interface TelemetryMetaFrameDto {
  deviceId: string;
  parameters: RawTelemetryParameterDto[];
  vehicleName?: string;
  vin?: string;
}

// Frontend-friendly parameter metadata
export interface TelemetryParameterMeta {
  key: string;
  name: string;
  unit?: string;
  module?: string;
  min?: number;
  max?: number;
}

// Normalizes backend names to avoid primaryKey-like values leaking into UI
function normalizeName(rawName: string, key: string): string {
  let name = rawName || key;

  if (name.includes("#")) {
    const parts = name.split("#");
    if (parts.length >= 2) name = parts[1];
  }

  if (name.startsWith("Vehicle")) {
    name = name.replace(/^Vehicle/, "");
  }

  return name;
}

// Maps backend metadata into UI-friendly parameter metadata
export function mapRawMetaToParameterMeta(
  frame: TelemetryMetaFrameDto,
): TelemetryParameterMeta[] {
  return frame.parameters.map((p) => ({
    key: p.key,
    name: normalizeName(p.name, p.key),
    unit: p.unit,
    module: p.module,
    min: p.min,
    max: p.max,
  }));
}

// Backend DTO for a single live telemetry value (TelemetryValueDto)
export interface TelemetryValueDto {
  key: string;
  value: number;
}

export interface PositionDto {
  latitude: number | null;
  longitude: number | null;

  accuracy?: number | null;
  speed?: number | null; // m/s
  heading?: number | null;
  altitude?: number | null;
  altitudeAccuracy?: number | null;
  noise?: number | null;
  satellites?: number | null;
  gpsFrameIndex?: number | null;
  emptyFrameIndex?: number | null;
  gpsStatus?: number | null;
  imuStatus?: number | null;
  headingVehicle?: number | null;
  xAngRate?: number | null;
  yAngRate?: number | null;
  zAngRate?: number | null;
  xAccel?: number | null;
  yAccel?: number | null;
  zAccel?: number | null;
  utcYear?: number | null;
  utcMonth?: number | null;
  utcDay?: number | null;
  utcHour?: number | null;
  utcMinute?: number | null;
  utcSecond?: number | null;
  utcMillisecond?: number | null;
}

// Backend DTO for a live telemetry frame for a device
export interface TelemetryFrameDto {
  deviceId: string;
  timestamp: number;
  values: TelemetryValueDto[];
  framerateStr?: string;
  position?: PositionDto;
}

// Frontend-friendly live frame with O(1) value lookup by key
export interface TelemetryLiveFrame {
  deviceId: string;
  timestamp: number;
  values: Record<string, number>;
  position?: PositionDto;
}

// Converts array values into a dictionary for fast lookups
export function mapRawFrameToTelemetry(
  frame: TelemetryFrameDto
): TelemetryLiveFrame {
  const result: Record<string, number> = {};

  for (const v of frame.values) result[v.key] = v.value;

  return {
    deviceId: frame.deviceId,
    timestamp: frame.timestamp,
    values: result,
    position: frame.position,
  };
}
