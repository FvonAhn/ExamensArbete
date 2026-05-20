namespace MaptunerApi.Models.Telemetry;

public class TelemetryFrameDto
{
    public string DeviceId { get; set; } = "";
    public long Timestamp { get; set; }
    public IReadOnlyList<TelemetryValueDto> Values { get; set; } = [];
    public string? FramerateStr { get; set; }
    public PositionDto? Position { get; set; }
}


