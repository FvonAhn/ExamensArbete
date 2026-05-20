namespace MaptunerApi.Models.Telemetry;

/// <summary>
/// Latency summary containing RTT measurements from both ends (app and webapp).
/// Sent to webapp along with telemetry frames to display total latency.
/// </summary>
public class LatencySummaryDto
{
    public long? AppToServerRttMs { get; set; }
    public long? WebAppToServerRttMs { get; set; }
    public long? TotalLatencyMs { get; set; }
}

