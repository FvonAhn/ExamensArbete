# Telemetry Monitoring - SignalR Hub Integration

## Overview

The telemetry monitoring feature has been successfully integrated into the MaptunerAPI. This enables real-time streaming of monitoring data from Maptuner applications to the Maptuner Suite website via SignalR.

### Two Types of Endpoints

```
REST API Endpoints (Swagger-visible)
├─ GET /api/monitoring/status          [Standard Auth Header]
├─ GET /api/monitoring/connection-info [Standard Auth Header]  
└─ GET /api/monitoring/test-auth       [Standard Auth Header]

SignalR WebSocket Hub (NOT in Swagger)
└─ /monitoring-broadcast               [Query String Auth]
   ├─ JoinDeviceGroup(deviceId)
   ├─ SendTelemetryFrame(frame)
   ├─ SendTelemetryMeta(frame)
   ├─ GetStreamState(deviceId)
   ├─ Ping(clientTimestamp)
   ├─ ReportRtt(rttMs)
   └─ StopTelemetryStream(deviceId)
```

## Endpoint

**SignalR Hub URL:** `https://your-server:5050/monitoring-broadcast`

## Authentication

### Two Different Authentication Methods

This API uses **different authentication methods** for REST endpoints vs SignalR WebSocket connections:

#### REST Endpoints (Standard Authorization Header)
The REST API endpoints (`/api/monitoring/*`) use **standard Authorization header** authentication, just like all other API endpoints:

```http
GET /api/monitoring/status HTTP/1.1
Authorization: Bearer YOUR_JWT_TOKEN
```

#### SignalR Hub (Query String)
The SignalR WebSocket connection (`/monitoring-broadcast`) **must use query string authentication** because:
- Browser WebSocket APIs don't support custom headers during connection handshake
- This is a standard limitation of WebSockets, not a design choice
- Query string is the recommended approach for SignalR JWT authentication

```
https://your-server:5050/monitoring-broadcast?access_token=YOUR_JWT_TOKEN
```

**Important:** This is normal for SignalR - the query string approach is Microsoft's recommended pattern for JWT with SignalR.

## Hub Methods

### 1. JoinDeviceGroup(deviceId)

Clients (typically websites) call this method to subscribe to telemetry updates from a specific device.

**Parameters:**
- `deviceId` (string): The unique identifier of the device to monitor

**Example (JavaScript):**
```javascript
await connection.invoke("JoinDeviceGroup", "device123");
```

### 2. SendTelemetryFrame(frame)

Maptuner apps call this method to broadcast telemetry data.

**Parameters:**
- `frame` (TelemetryFrameDto):
  - `DeviceId` (string): Device identifier
  - `Timestamp` (long): Unix timestamp in milliseconds (auto-generated if 0)
  - `Values` (array): Array of TelemetryValueDto objects
  - `FramerateStr` (string, optional): Frame rate information

**Example (C#):**
```csharp
var frame = new TelemetryFrameDto
{
    DeviceId = "device123",
    Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
    Values = new[]
    {
        new TelemetryValueDto { Key = "rpm", Value = 3500.0 },
        new TelemetryValueDto { Key = "speed", Value = 85.5 }
    }
};

await connection.InvokeAsync("SendTelemetryFrame", frame);
```

### 3. SendTelemetryMeta(frame)

Maptuner apps call this method to send parameter metadata (names, units, ranges).

**Parameters:**
- `frame` (TelemetryMetaFrameDto):
  - `DeviceId` (string): Device identifier
  - `Parameters` (array): Array of TelemetryParameterMetaDto objects
  - `VehicleName` (string, optional): Vehicle name
  - `Vin` (string, optional): Vehicle VIN

**Example (C#):**
```csharp
var meta = new TelemetryMetaFrameDto
{
    DeviceId = "device123",
    VehicleName = "BMW 320d",
    Parameters = new[]
    {
        new TelemetryParameterMetaDto 
        { 
            Key = "rpm", 
            Name = "Engine RPM", 
            Unit = "rpm",
            Module = "Engine",
            Min = 0,
            Max = 7000
        }
    }
};

await connection.InvokeAsync("SendTelemetryMeta", meta);
```

### 4. GetStreamState(deviceId)

Returns a snapshot of the current stream state for a device.

**Response:** `TelemetryStreamStateDto`
- `isRunning` (bool)
- `endReason` ("user" | "unexpected" | "timeout" | null)
- `endedAtMs` (long? ms)
- `hasCachedMeta` (bool)
- `lastFrameAtMs` (long? ms)

```csharp
var state = await connection.InvokeAsync<TelemetryStreamStateDto>("GetStreamState", "device123");
```

### 5. StopTelemetryStream(deviceId)

Sender explicitly stops the stream. Emits a `TelemetryStreamStatus` with reason `user`.

```csharp
await connection.InvokeAsync("StopTelemetryStream", "device123");
```

## Client Events

Clients listening to telemetry updates will receive these events:

### TelemetryUpdated

Fired when new telemetry data is available.

**Payload:** `TelemetryFrameDto`

**Example (JavaScript):**
```javascript
connection.on("TelemetryUpdated", (frame) => {
    console.log(`Received telemetry from ${frame.deviceId}`);
    frame.values.forEach(v => {
        console.log(`${v.key}: ${v.value}`);
    });
});
```

### TelemetryMetaUpdated

Fired when parameter metadata is updated.

**Payload:** `TelemetryMetaFrameDto`

**Example (JavaScript):**
```javascript
connection.on("TelemetryMetaUpdated", (meta) => {
  console.log(`Metadata for ${meta.deviceId}: ${meta.vehicleName} VIN=${meta.vin ?? ""}`);
  meta.parameters.forEach(p => {
    console.log(`${p.name} (${p.unit}): ${p.min}-${p.max}`);
  });
});
```
### TelemetryStreamStatus

Fired when the stream stops or times out. Reasons: `user`, `unexpected`, `timeout`.

**Payload:** `TelemetryStreamStatusDto`

```javascript
connection.on("TelemetryStreamStatus", (status) => {
    console.log(`Stream for ${status.deviceId} stopped. Reason: ${status.reason}`);
});
```

## Connection Example (JavaScript/TypeScript)

```javascript
import * as signalR from "@microsoft/signalr";

// Get JWT token from your auth system
const jwtToken = "your_jwt_token_here";

// Create connection with JWT token in query string
const connection = new signalR.HubConnectionBuilder()
    .withUrl(`https://your-server:5050/monitoring-broadcast?access_token=${jwtToken}`)
    .withAutomaticReconnect()
    .build();

// Set up event handlers
connection.on("TelemetryUpdated", (frame) => {
    // Handle telemetry data
    updateUI(frame);
});

connection.on("TelemetryMetaUpdated", (meta) => {
    // Handle metadata
    setupParameters(meta);
});

// Latency summary (app RTT, web RTT, total)
connection.on("LatencySummary", (latency) => {
  console.log("Latency summary", latency);
});

// Connect and join device group
await connection.start();
await connection.invoke("JoinDeviceGroup", "device123");

// Optional: fetch current stream state
const state = await connection.invoke("GetStreamState", "device123");
console.log("Current stream state", state);

// Optional: listen for stop/timeouts
connection.on("TelemetryStreamStatus", (status) => {
  console.log("Stream status", status);
});

// Measure RTT from client:
const pingSent = Date.now();
const serverTimestamp = await connection.invoke("Ping", pingSent);
const rtt = Date.now() - pingSent;
await connection.invoke("ReportRtt", rtt);
```

## REST API Endpoints

These endpoints will appear in Swagger and can be tested there. All use standard Authorization header authentication.

### GET `/api/monitoring/status`

Returns basic information about the hub status.

**Authentication:** Required (JWT via Authorization header: `Bearer YOUR_JWT_TOKEN`)

**Response:**
```json
{
    "status": "active",
    "hubEndpoint": "/monitoring-broadcast",
    "message": "Telemetry hub is operational",
    "serverTime": "2025-12-12T10:30:00Z"
}
```

### GET `/api/monitoring/connection-info`

Returns detailed information needed to connect to the SignalR hub.

**Authentication:** Required (JWT via Authorization header: `Bearer YOUR_JWT_TOKEN`)

**Response:**
```json
{
    "hubEndpoint": "/monitoring-broadcast",
    "fullUrl": "https://your-server:5050/monitoring-broadcast",
    "authenticationMethod": "JWT",
    "authenticationNote": "For SignalR WebSocket connections, pass JWT token as query parameter: ?access_token=YOUR_JWT_TOKEN",
    "methods": [
        "JoinDeviceGroup(deviceId) - Subscribe to device telemetry",
        "SendTelemetryFrame(frame) - Broadcast telemetry data",
        "SendTelemetryMeta(frame) - Broadcast parameter metadata"
    ],
    "clientEvents": [
        "TelemetryUpdated - Fires when new telemetry data arrives",
        "TelemetryMetaUpdated - Fires when parameter metadata is updated"
    ]
}
```

### GET `/api/monitoring/test-auth`

Test endpoint to verify your JWT token is working correctly.

**Authentication:** Required (JWT via Authorization header: `Bearer YOUR_JWT_TOKEN`)

**Response:**
```json
{
    "isAuthenticated": true,
    "authenticationType": "Bearer",
    "userName": "user@example.com",
    "claims": [
        { "type": "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier", "value": "123" },
        { "type": "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name", "value": "user@example.com" }
    ],
    "message": "Your JWT token is valid and authentication is working correctly."
}
```

## Architecture

```
[Maptuner App] ---(JWT)---> [SignalR Hub: /monitoring-broadcast]
                                     |
                                     +---(broadcasts to)---> [Website 1]
                                     |
                                     +---(broadcasts to)---> [Website 2]
```

## Security Features

1. **JWT Authentication Required:** All connections must authenticate with a valid JWT token
2. **Device Grouping:** Clients only receive data from devices they explicitly subscribe to
3. **CORS Enabled:** Currently allows all origins for testing (can be restricted in production)
4. **Authorization Attribute:** Hub is decorated with `[Authorize]` to enforce authentication

## Testing

1. Ensure MaptunerAPI is running on port 5050
2. Obtain a valid JWT token by authenticating with the API
3. Connect to the SignalR hub with the token in the query string
4. Join a device group using `JoinDeviceGroup`
5. Send test telemetry data using `SendTelemetryFrame`
6. Verify that subscribed clients receive the `TelemetryUpdated` event

## Files Added/Modified

### New Files:
- `Models/Telemetry/TelemetryFrameDto.cs`
- `Models/Telemetry/TelemetryMetaFrameDto.cs`
- `Models/Telemetry/TelemetryValueDto.cs`
- `Models/Telemetry/TelemetryParameterMetaDto.cs`
- `Hubs/TelemetryHub.cs`
- `Endpoints/MonitoringEndpoints.cs`

### Modified Files:
- `Program.cs` - Added SignalR services and hub mapping

## Migration Notes

This implementation replaces the standalone `Telemetry.Gateway` project. Key differences:

1. **URL Changed:** From `/telemetryHub` to `/monitoring-broadcast`
2. **Port Changed:** Now uses MaptunerAPI port (5050) instead of separate port
3. **Authentication:** JWT now required for all connections
4. **CORS:** Integrated with MaptunerAPI's CORS policy

Update client applications to use the new endpoint URL and include JWT authentication.


