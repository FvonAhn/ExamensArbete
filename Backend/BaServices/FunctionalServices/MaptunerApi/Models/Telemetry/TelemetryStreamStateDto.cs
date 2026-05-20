namespace MaptunerApi.Models.Telemetry;

/// <summary>
/// Snapshot of the current stream state for a device.
/// </summary>
public class TelemetryStreamStateDto
{
    public string DeviceId { get; set; } = "";
    public bool IsRunning { get; set; }
    public string? EndReason { get; set; } // "user" | "unexpected" | "timeout"
    public long? EndedAtMs { get; set; }
    public bool HasCachedMeta { get; set; }
    public long? LastFrameAtMs { get; set; }
}



