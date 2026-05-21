export type TelemetryValueDto = {
  key: string;
  value: number;
};

export type PositionDto = {
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  speed: number | null;
  heading: number | null;
  altitude: number | null;
  altitudeAccuracy: number | null;
  noise?: number | null;
  satellites?: number | null;
  gpsFrameIndex?: number | null;
  emptyFrameIndex?: number | null;
  gpsStatus?: number | null;
  imuStatus?: number | null;
  headingMotion?: number | null;
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
};

export type TelemetryFrameDto = {
  deviceId: string;
  timestamp: number;
  values: TelemetryValueDto[];
  framerateStr?: string;

  // null or undefined means no position is sent (no monitored GPS features or no sample available)
  position?: PositionDto | null;
};

export type TelemetryParameterMetaDto = {
  key: string;
  name: string;
  unit: string;
  module: string;
  min: number;
  max: number;
};

export type TelemetryMetaFrameDto = {
  deviceId: string;
  parameters: TelemetryParameterMetaDto[];
  vehicleName?: string;
  vin?: string;
};
