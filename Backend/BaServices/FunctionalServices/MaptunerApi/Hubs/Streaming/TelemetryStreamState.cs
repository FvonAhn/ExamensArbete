using System.Collections.Concurrent;
using System.Linq;
using MaptunerApi.Models.Telemetry;

namespace MaptunerApi.Hubs.Streaming;

/// <summary>
/// Thread-safe, in-memory stream state.
/// Tracks senders, last frame timestamps, cached metadata, and end reasons.
/// </summary>
public sealed class TelemetryStreamState
{
    private readonly ConcurrentDictionary<string, TelemetryMetaFrameDto> _latestMeta = new();
    private readonly ConcurrentDictionary<string, long> _lastFrameAtMs = new();
    private readonly ConcurrentDictionary<string, string> _senderByDeviceId = new();
    private readonly ConcurrentDictionary<string, string> _senderConnToDeviceId = new();
    private readonly ConcurrentDictionary<string, StreamEndReason> _endReasonByDeviceId = new();
    private readonly ConcurrentDictionary<string, long> _endedAtMs = new();

    // RTT (Round-Trip Time) measurements per connection (milliseconds).
    // Key: connectionId, Value: RTT in milliseconds.
    private readonly ConcurrentDictionary<string, long> _rttByConnection = new();

    // Track which connections are listening to which devices (for webapp RTT tracking).
    // Key: deviceId, Value: Set of connectionIds that have joined this device group with their RTT.
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, long>> _webAppRttsByDevice = new();

    // After a user stop we ignore late frames for this long (ms) to avoid flapping.
    private const int USER_STOP_STICKY_MS = 3000;

    public void TouchFrame(string connectionId, string deviceId, long nowMs)
    {
        deviceId = Normalize(deviceId);
        connectionId = Normalize(connectionId);

        if (TryGetEnded(deviceId, out var r, out var endedAt) &&
            r == StreamEndReason.User &&
            nowMs - endedAt <= USER_STOP_STICKY_MS)
        {
            return;
        }

        RegisterSender(deviceId, connectionId);
        _lastFrameAtMs[deviceId] = nowMs;
        _endReasonByDeviceId.TryRemove(deviceId, out _);
        _endedAtMs.TryRemove(deviceId, out _);
    }

    public void RegisterSender(string deviceId, string connectionId)
    {
        deviceId = Normalize(deviceId);
        connectionId = Normalize(connectionId);

        _senderByDeviceId[deviceId] = connectionId;
        _senderConnToDeviceId[connectionId] = deviceId;
    }

    public bool TryRemoveSender(string connectionId, out string deviceId)
    {
        connectionId = Normalize(connectionId);

        if (_senderConnToDeviceId.TryRemove(connectionId, out var storedDeviceId))
        {
            deviceId = Normalize(storedDeviceId);
            _senderByDeviceId.TryRemove(deviceId, out _);
            // Also clean up RTT measurement
            RemoveRtt(connectionId);
            return true;
        }

        deviceId = "";
        return false;
    }

    public void UnregisterSenderForDevice(string deviceId)
    {
        deviceId = Normalize(deviceId);

        if (_senderByDeviceId.TryRemove(deviceId, out var connId))
        {
            connId = Normalize(connId);
            _senderConnToDeviceId.TryRemove(connId, out _);
        }
    }

    /// <summary>
    /// Registers a webapp listener for RTT tracking.
    /// </summary>
    public void RegisterWebAppListener(string deviceId, string connectionId)
    {
        deviceId = Normalize(deviceId);
        connectionId = Normalize(connectionId);

        var perDevice = _webAppRttsByDevice.GetOrAdd(deviceId, _ => new ConcurrentDictionary<string, long>());
        perDevice[connectionId] = 0; // RTT will be updated when reported
    }

    /// <summary>
    /// Unregisters a connection from listening to a device.
    /// </summary>
    public void UnregisterWebAppListener(string deviceId, string connectionId)
    {
        deviceId = Normalize(deviceId);
        connectionId = Normalize(connectionId);

        if (_webAppRttsByDevice.TryGetValue(deviceId, out var webAppRtts))
        {
            webAppRtts.TryRemove(connectionId, out _);

            if (webAppRtts.IsEmpty)
            {
                _webAppRttsByDevice.TryRemove(deviceId, out _);
            }
        }
    }

    /// <summary>
    /// Updates RTT measurement for a connection.
    /// </summary>
    public void UpdateRtt(string connectionId, long rttMs)
    {
        connectionId = Normalize(connectionId);
        if (rttMs <= 0) return;

        _rttByConnection[connectionId] = rttMs;

        // Update any webapp device tracking
        foreach (var (deviceId, webAppRtts) in _webAppRttsByDevice)
        {
            if (webAppRtts.ContainsKey(connectionId))
            {
                webAppRtts[connectionId] = rttMs;
            }
        }
    }

    /// <summary>
    /// Removes RTT measurement for a connection and from webapp tracking.
    /// </summary>
    public void RemoveRtt(string connectionId)
    {
        connectionId = Normalize(connectionId);
        _rttByConnection.TryRemove(connectionId, out _);

        foreach (var (deviceId, webAppRtts) in _webAppRttsByDevice)
        {
            webAppRtts.TryRemove(connectionId, out _);
            if (webAppRtts.IsEmpty)
            {
                _webAppRttsByDevice.TryRemove(deviceId, out _);
            }
        }
    }

    /// <summary>
    /// Tries to get the RTT measurement for a connection.
    /// </summary>
    public bool TryGetRtt(string connectionId, out long rttMs)
    {
        connectionId = Normalize(connectionId);
        return _rttByConnection.TryGetValue(connectionId, out rttMs);
    }

    public bool TryGetActiveSender(string deviceId, out string connectionId)
    {
        deviceId = Normalize(deviceId);
        return _senderByDeviceId.TryGetValue(deviceId, out connectionId!);
    }

    public bool TryCacheMeta(string deviceId, TelemetryMetaFrameDto meta)
    {
        deviceId = Normalize(deviceId);

        // Normalize inputs
        meta.DeviceId = deviceId;
        meta.VehicleName = string.IsNullOrWhiteSpace(meta.VehicleName) ? null : meta.VehicleName.Trim();
        meta.Vin = string.IsNullOrWhiteSpace(meta.Vin) ? null : meta.Vin.Trim().ToUpperInvariant();

        var count = meta.Parameters?.Count ?? 0;
        // Allow caching if any of params, vehicle name, or VIN is present
        if (count == 0 &&
            string.IsNullOrWhiteSpace(meta.VehicleName) &&
            string.IsNullOrWhiteSpace(meta.Vin))
            return false;

        _latestMeta[deviceId] = meta;
        return true;
    }

    public bool TryGetMeta(string deviceId, out TelemetryMetaFrameDto meta)
    {
        deviceId = Normalize(deviceId);
        return _latestMeta.TryGetValue(deviceId, out meta!);
    }

    /// <summary>
    /// Sticky priority: User > Unexpected > Timeout.
    /// Returns true if marker updated and status should be emitted.
    /// </summary>
    public bool TrySetEnded(string deviceId, StreamEndReason reason, long nowMs)
    {
        deviceId = Normalize(deviceId);

        if (reason == StreamEndReason.None)
            return false;

        if (_endReasonByDeviceId.TryGetValue(deviceId, out var existing))
        {
            if (existing == StreamEndReason.User)
                return false;
            if (existing == StreamEndReason.Unexpected && reason == StreamEndReason.Timeout)
                return false;
            if (existing == reason)
                return false;
        }

        _endReasonByDeviceId[deviceId] = reason;
        _endedAtMs[deviceId] = nowMs;
        return true;
    }

    public bool TryGetEnded(string deviceId, out StreamEndReason reason, out long endedAtMs)
    {
        deviceId = Normalize(deviceId);

        if (_endReasonByDeviceId.TryGetValue(deviceId, out var r) &&
            _endedAtMs.TryGetValue(deviceId, out var at))
        {
            reason = r;
            endedAtMs = at;
            return true;
        }

        reason = StreamEndReason.None;
        endedAtMs = 0;
        return false;
    }

    public void ClearEnded(string deviceId)
    {
        deviceId = Normalize(deviceId);
        _endReasonByDeviceId.TryRemove(deviceId, out _);
        _endedAtMs.TryRemove(deviceId, out _);
    }

    public void ClearVolatile(string deviceId)
    {
        deviceId = Normalize(deviceId);
        _latestMeta.TryRemove(deviceId, out _);
        _lastFrameAtMs.TryRemove(deviceId, out _);
    }

    public KeyValuePair<string, long>[] LastFramesSnapshot() => _lastFrameAtMs.ToArray();
    public string[] EndedDevicesSnapshot() => _endedAtMs.Keys.ToArray();

    public bool TryGetLastFrameAt(string deviceId, out long lastAt)
    {
        deviceId = Normalize(deviceId);
        return _lastFrameAtMs.TryGetValue(deviceId, out lastAt);
    }

    /// <summary>
    /// Returns a snapshot of device ids that are currently considered live.
    /// A device is live if it has an active sender and has not been marked as ended.
    /// </summary>
    public string[] GetLiveDeviceIdsSnapshot()
    {
        return _senderByDeviceId.Keys
            .Where(deviceId => !_endReasonByDeviceId.ContainsKey(deviceId))
            .ToArray();
    }

    public TelemetryStreamStateDto GetSnapshot(string deviceId)
    {
        deviceId = Normalize(deviceId);

        var hasMeta = _latestMeta.ContainsKey(deviceId);
        var hasLastFrame = _lastFrameAtMs.TryGetValue(deviceId, out var lastAt);
        var isRunning = hasLastFrame && !_endReasonByDeviceId.ContainsKey(deviceId);

        string? endReason = null;
        long? endedAt = null;

        if (TryGetEnded(deviceId, out var r, out var at) && r != StreamEndReason.None)
        {
            endReason = TelemetryHubNaming.ReasonToWire(r);
            endedAt = at;
        }

        return new TelemetryStreamStateDto
        {
            DeviceId = deviceId,
            IsRunning = isRunning,
            EndReason = endReason,
            EndedAtMs = endedAt,
            HasCachedMeta = hasMeta,
            LastFrameAtMs = hasLastFrame ? lastAt : null
        };
    }

    /// <summary>
    /// Gets the latency summary for a device, including RTT from sender (app) and receivers (webapp).
    /// </summary>
    public LatencySummaryDto GetLatencySummary(string deviceId)
    {
        deviceId = Normalize(deviceId);

        long? appToServerRtt = null;
        long? webAppToServerRtt = null;
        long? totalLatency = null;

        if (TryGetActiveSender(deviceId, out var senderConnectionId) &&
            TryGetRtt(senderConnectionId, out var senderRtt))
        {
            appToServerRtt = senderRtt;
        }

        if (_webAppRttsByDevice.TryGetValue(deviceId, out var webAppRtts) && webAppRtts.Count > 0)
        {
            var validRtts = webAppRtts.Values.Where(rtt => rtt > 0).ToList();
            if (validRtts.Count > 0)
            {
                webAppToServerRtt = (long)validRtts.Average();
            }
        }

        if (appToServerRtt.HasValue && webAppToServerRtt.HasValue)
        {
            totalLatency = (appToServerRtt.Value / 2) + (webAppToServerRtt.Value / 2);
        }
        else if (appToServerRtt.HasValue)
        {
            totalLatency = appToServerRtt.Value / 2;
        }

        return new LatencySummaryDto
        {
            AppToServerRttMs = appToServerRtt,
            WebAppToServerRttMs = webAppToServerRtt,
            TotalLatencyMs = totalLatency
        };
    }

    private static string Normalize(string value) => value.Trim();
}



