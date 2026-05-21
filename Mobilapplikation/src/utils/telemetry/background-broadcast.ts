import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export type BackgroundBroadcastState = {
  state: string;
  lastError?: string | null;
  lastFrameSentAtMs?: number;
  lastLocationAtMs?: number;
  lastMonitoringValueAtMs?: number;
};

export type BackgroundBroadcastPermissionState = {
  fineLocationGranted: boolean;
  backgroundLocationGranted: boolean;
  notificationsGranted: boolean;
};

export type BackgroundBroadcastStartOptions = {
  deviceId: string;
  hubUrl: string;
  accessToken: string;
  notificationTitle?: string;
  notificationText?: string;
  demoMode?: boolean;
};

export type BackgroundBroadcastSyncMetadataOptions = {
  metadataJson: string;
  vehicleName?: string;
  vin?: string;
};

export type BackgroundBroadcastSyncFrameOptions = {
  valuesJson: string;
  positionJson: string;
  sourceFrameRateHz?: number | null;
  allowNativeGpsFallback?: boolean;
};

export interface BackgroundBroadcastPlugin {
  start(options: BackgroundBroadcastStartOptions): Promise<BackgroundBroadcastState>;
  stop(): Promise<BackgroundBroadcastState>;
  syncMetadata(options: BackgroundBroadcastSyncMetadataOptions): Promise<BackgroundBroadcastState>;
  syncFrame(options: BackgroundBroadcastSyncFrameOptions): Promise<BackgroundBroadcastState>;
  getState(): Promise<BackgroundBroadcastState>;
  getPermissionStatus(): Promise<BackgroundBroadcastPermissionState>;
  openAppSettings(): Promise<void>;
  addListener(
    eventName: "stateChanged",
    listenerFunc: (state: BackgroundBroadcastState) => void,
  ): Promise<PluginListenerHandle>;
}

export const BackgroundBroadcast = registerPlugin<BackgroundBroadcastPlugin>(
  "BackgroundBroadcast",
);
