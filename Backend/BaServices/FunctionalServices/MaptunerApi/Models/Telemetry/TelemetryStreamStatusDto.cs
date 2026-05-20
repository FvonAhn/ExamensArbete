namespace MaptunerApi.Models.Telemetry;

/// <summary>
/// Stream status event that is pushed to all clients in the device group.
/// </summary>
public class TelemetryStreamStatusDto
{
    public string DeviceId { get; set; } = "";
    public string Status { get; set; } = "stopped"; // "running" | "stopped"
    public string Reason { get; set; } = "";        // "user" | "unexpected" | "timeout"
    public long TimestampMs { get; set; }
}



