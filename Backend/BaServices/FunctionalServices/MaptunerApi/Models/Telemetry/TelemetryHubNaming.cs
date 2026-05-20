using Microsoft.AspNetCore.SignalR;

namespace MaptunerApi.Models.Telemetry;

/// <summary>
/// Helper methods for hub naming conventions and common utilities.
/// </summary>
public static class TelemetryHubNaming
{
    /// <summary>
    /// Builds the SignalR group name for a device.
    /// </summary>
    public static string DeviceGroup(string deviceId)
        => $"device:{RequireDeviceId(deviceId)}";

    /// <summary>
    /// Validates and normalizes a deviceId for hub usage.
    /// Throws a HubException if the value is null or whitespace.
    /// </summary>
    public static string RequireDeviceId(string? deviceId)
    {
        if (string.IsNullOrWhiteSpace(deviceId))
            throw new HubException("DeviceId is required.");

        return deviceId.Trim();
    }

    /// <summary>
    /// Returns current Unix time in milliseconds.
    /// </summary>
    public static long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    /// <summary>
    /// Maps internal StreamEndReason enum to the wire string used in DTOs.
    /// </summary>
    public static string ReasonToWire(StreamEndReason reason) => reason switch
    {
        StreamEndReason.User => "user",
        StreamEndReason.Unexpected => "unexpected",
        StreamEndReason.Timeout => "timeout",
        _ => "unknown"
    };
}



