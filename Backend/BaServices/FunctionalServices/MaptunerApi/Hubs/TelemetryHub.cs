using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using MaptunerApi.Hubs.Streaming;
using MaptunerApi.Models.Telemetry;

namespace MaptunerApi.Hubs;

[Authorize]
public sealed class TelemetryHub : Hub
{
    private readonly ILogger<TelemetryHub> _logger;
    private readonly TelemetryStreamState _state;

    // How long a stream must be quiet before we stop treating disconnects as "unexpected".
    private const int ACTIVE_WINDOW_MS = 8000;

    public TelemetryHub(ILogger<TelemetryHub> logger, TelemetryStreamState state)
    {
        _logger = logger;
        _state = state;
    }

    public Task<string[]> GetLiveDeviceIds()
    {
        return Task.FromResult(_state.GetLiveDeviceIdsSnapshot());
    }

    private Task BroadcastLiveDeviceIdsChanged()
    {
        var ids = _state.GetLiveDeviceIdsSnapshot();
        return Clients.All.SendAsync("LiveDeviceIdsChanged", ids);
    }

    /// <summary>
    /// Client subscribes to updates for a specific device.
    /// Sends cached metadata immediately if available.
    /// </summary>
    public async Task JoinDeviceGroup(string deviceId)
    {
        deviceId = TelemetryHubNaming.RequireDeviceId(deviceId);

        _logger.LogInformation(
            "Client {ConnectionId} joined device group {DeviceId}",
            Context.ConnectionId,
            deviceId
        );

        await Groups.AddToGroupAsync(Context.ConnectionId, TelemetryHubNaming.DeviceGroup(deviceId));

        // Register this connection as a webapp listener (if it's not the sender)
        if (!_state.TryGetActiveSender(deviceId, out var senderConn) || senderConn != Context.ConnectionId)
        {
            _state.RegisterWebAppListener(deviceId, Context.ConnectionId);
        }

        if (_state.TryGetMeta(deviceId, out var cachedMeta))
        {
            await Clients.Caller.SendAsync("TelemetryMetaUpdated", cachedMeta);
        }
    }

    /// <summary>
    /// Returns a snapshot of the current stream state for a device.
    /// </summary>
    public Task<TelemetryStreamStateDto> GetStreamState(string deviceId)
    {
        deviceId = TelemetryHubNaming.RequireDeviceId(deviceId);
        return Task.FromResult(_state.GetSnapshot(deviceId));
    }

    /// <summary>
    /// Receives a live telemetry frame from a sender and broadcasts it to all listeners.
    /// Also updates last-frame timestamp and sender tracking in TelemetryStreamState.
    /// </summary>
    public async Task SendTelemetryFrame(TelemetryFrameDto frame)
    {
        if (frame is null)
            throw new HubException("Frame is required.");

        var deviceId = TelemetryHubNaming.RequireDeviceId(frame.DeviceId);

        if (frame.Timestamp == 0)
            frame.Timestamp = TelemetryHubNaming.NowMs();

        var wasLive = _state.TryGetActiveSender(deviceId, out _);

        _state.TouchFrame(Context.ConnectionId, deviceId, frame.Timestamp);

        var isLive = _state.TryGetActiveSender(deviceId, out _);
        if (!wasLive && isLive)
        {
            await BroadcastLiveDeviceIdsChanged();
        }

        // Get latency summary for this device and broadcast it along with the frame.
        var latencySummary = _state.GetLatencySummary(deviceId);

        await Clients.Group(TelemetryHubNaming.DeviceGroup(deviceId))
            .SendAsync("TelemetryUpdated", frame);

        await Clients.Group(TelemetryHubNaming.DeviceGroup(deviceId))
            .SendAsync("LatencySummary", latencySummary);
    }

    /// <summary>
    /// Client sends ping timestamp, server responds with server timestamp. Client then calls ReportRtt.
    /// </summary>
    public Task<long> Ping(long clientTimestamp)
    {
        return Task.FromResult(TelemetryHubNaming.NowMs());
    }

    /// <summary>
    /// Client reports RTT after ping round-trip.
    /// </summary>
    public Task ReportRtt(long rttMs)
    {
        _state.UpdateRtt(Context.ConnectionId, rttMs);
        return Task.CompletedTask;
    }

    /// <summary>
    /// Receives metadata (parameter definitions and vehicle name), caches it, and broadcasts to listeners.
    /// </summary>
    public async Task SendTelemetryMeta(TelemetryMetaFrameDto frame)
    {
        if (frame is null)
            throw new HubException("Meta frame is required.");

        var deviceId = TelemetryHubNaming.RequireDeviceId(frame.DeviceId);

        _state.TryCacheMeta(deviceId, frame);

        await Clients.Group(TelemetryHubNaming.DeviceGroup(deviceId))
            .SendAsync("TelemetryMetaUpdated", frame);
    }

    /// <summary>
    /// Sender explicitly stops the stream. Marks as ended by user and emits status.
    /// </summary>
    public async Task StopTelemetryStream(string deviceId)
    {
        deviceId = TelemetryHubNaming.RequireDeviceId(deviceId);
        var now = TelemetryHubNaming.NowMs();

        _state.TrySetEnded(deviceId, StreamEndReason.User, now);
        _state.UnregisterSenderForDevice(deviceId);
        _state.ClearVolatile(deviceId);

        _logger.LogInformation(
            "Telemetry stream stop requested by user for {DeviceId}. Caller={CallerConnectionId}",
            deviceId,
            Context.ConnectionId
        );

        var status = new TelemetryStreamStatusDto
        {
            DeviceId = deviceId,
            Status = "stopped",
            Reason = "user",
            TimestampMs = now
        };

        await Clients.Group(TelemetryHubNaming.DeviceGroup(deviceId))
            .SendAsync("TelemetryStreamStatus", status);

        await BroadcastLiveDeviceIdsChanged();
    }

    /// <summary>
    /// When a connection disconnects, decide if an active stream should emit an unexpected stop.
    /// </summary>
    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        _state.RemoveRtt(Context.ConnectionId);

        if (_state.TryRemoveSender(Context.ConnectionId, out var deviceId) &&
            !string.IsNullOrWhiteSpace(deviceId))
        {
            deviceId = deviceId.Trim();
            var now = TelemetryHubNaming.NowMs();

            if (_state.TryGetActiveSender(deviceId, out var currentSenderConn) &&
                currentSenderConn != Context.ConnectionId)
            {
                await base.OnDisconnectedAsync(exception);
                return;
            }

            if (_state.TryGetEnded(deviceId, out var reason, out _) &&
                reason == StreamEndReason.User)
            {
                await base.OnDisconnectedAsync(exception);
                return;
            }

            if (_state.TryGetLastFrameAt(deviceId, out var lastAt) &&
                now - lastAt > ACTIVE_WINDOW_MS)
            {
                await base.OnDisconnectedAsync(exception);
                return;
            }

            var shouldEmit = _state.TrySetEnded(deviceId, StreamEndReason.Unexpected, now);

            if (shouldEmit)
            {
                _logger.LogWarning(
                    "Sender connection {ConnectionId} disconnected unexpectedly for {DeviceId}.",
                    Context.ConnectionId,
                    deviceId
                );

                await Clients.Group(TelemetryHubNaming.DeviceGroup(deviceId))
                    .SendAsync("TelemetryStreamStatus", new TelemetryStreamStatusDto
                    {
                        DeviceId = deviceId,
                        Status = "stopped",
                        Reason = "unexpected",
                        TimestampMs = now
                    });
            }

            _state.UnregisterSenderForDevice(deviceId);
            _state.ClearVolatile(deviceId);

            await BroadcastLiveDeviceIdsChanged();
        }

        // Remove this connection from any webapp listener tracking
        if (!string.IsNullOrWhiteSpace(deviceId))
        {
            _state.UnregisterWebAppListener(deviceId, Context.ConnectionId);
        }

        await base.OnDisconnectedAsync(exception);
    }
}
