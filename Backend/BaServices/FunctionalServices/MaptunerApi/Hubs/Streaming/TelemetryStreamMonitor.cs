using MaptunerApi.Models.Telemetry;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Hosting;

namespace MaptunerApi.Hubs.Streaming;

/// <summary>
/// Background service that checks for stale streams and emits timeout status,
/// and cleans up ended markers after a TTL.
/// </summary>
public sealed class TelemetryStreamMonitor : BackgroundService
{
    private readonly ILogger<TelemetryStreamMonitor> _logger;
    private readonly TelemetryStreamState _state;
    private readonly IHubContext<MaptunerApi.Hubs.TelemetryHub> _hub;

    private const int STALE_MS = 8000;
    private const int ENDED_TTL_MS = 60 * 60 * 1000;
    private static readonly TimeSpan TICK = TimeSpan.FromSeconds(2);

    public TelemetryStreamMonitor(
        ILogger<TelemetryStreamMonitor> logger,
        TelemetryStreamState state,
        IHubContext<MaptunerApi.Hubs.TelemetryHub> hub)
    {
        _logger = logger;
        _state = state;
        _hub = hub;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            var now = TelemetryHubNaming.NowMs();

            // 1) timeout stale streams
            foreach (var (deviceId, lastAt) in _state.LastFramesSnapshot())
            {
                if (now - lastAt < STALE_MS)
                    continue;

                var shouldEmit = _state.TrySetEnded(deviceId, StreamEndReason.Timeout, now);
                if (!shouldEmit)
                    continue;

                _logger.LogInformation(
                    "Telemetry stream timed out for {DeviceId} (last frame {Age} ms ago).",
                    deviceId,
                    now - lastAt
                );

                _state.UnregisterSenderForDevice(deviceId);
                _state.ClearVolatile(deviceId);

                await _hub.Clients.Group(TelemetryHubNaming.DeviceGroup(deviceId))
                    .SendAsync("TelemetryStreamStatus", new TelemetryStreamStatusDto
                    {
                        DeviceId = deviceId,
                        Status = "stopped",
                        Reason = "timeout",
                        TimestampMs = now
                    }, cancellationToken: stoppingToken);
            }

            // 2) cleanup ended markers after TTL
            foreach (var deviceId in _state.EndedDevicesSnapshot())
            {
                if (_state.TryGetEnded(deviceId, out _, out var endedAt) &&
                    now - endedAt >= ENDED_TTL_MS)
                {
                    _state.ClearEnded(deviceId);
                }
            }

            await Task.Delay(TICK, stoppingToken);
        }
    }
}



