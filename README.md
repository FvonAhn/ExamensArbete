# Live Monitor showcase extract

This repository is a curated source-code extract for the Live Monitor feature. It is intended for review and presentation, not for standalone compilation.

## What is included

- `Backend/` contains the REST endpoints, SignalR hub, stream state, DTOs, and the gRPC user-service additions used by Live Monitor.
- `Webbportal/` contains the Svelte/SvelteKit monitoring views, telemetry stores, popout views, recording helpers, and SignalR client.
- `Mobilapplikation/` contains the mobile broadcast UI, invite flow, telemetry sender, and Android foreground-service bridge.

## End-to-end flow

1. The mobile application connects to the SignalR hub and joins a device group with `JoinDeviceGroup`.
2. The mobile application sends metadata with `SendTelemetryMeta` and live frames with `SendTelemetryFrame`.
3. The backend hub broadcasts `TelemetryMetaUpdated`, `TelemetryUpdated`, `LatencySummary`, `TelemetryStreamStatus`, and `LiveDeviceIdsChanged`.
4. The web portal subscribes to the selected device group and renders charts, values, maps, calibration maps, and popout windows.

## Intentionally omitted

The extract leaves out the surrounding application shells, build files, authentication setup, shared UI libraries, generated gRPC files, database configuration, and environment-specific deployment configuration. The visible code keeps the integration points and feature logic so the architecture can be followed without exposing the full proprietary systems.

When distributing this as a review archive, export the working tree without `.git/` so Git history and remote metadata are not included.
