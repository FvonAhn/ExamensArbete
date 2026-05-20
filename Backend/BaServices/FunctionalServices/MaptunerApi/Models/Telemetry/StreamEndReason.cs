namespace MaptunerApi.Models.Telemetry;

/// <summary>
/// Internal reasons for why a stream ended.
/// These map to wire strings when sent to clients.
/// </summary>
public enum StreamEndReason
{
    None = 0,
    User = 1,
    Unexpected = 2,
    Timeout = 3
}



