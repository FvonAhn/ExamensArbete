namespace MaptunerApi.Models.Telemetry;

public class TelemetryMetaFrameDto
{
    public string DeviceId { get; set; } = "";
    public IReadOnlyList<TelemetryParameterMetaDto> Parameters { get; set; } = [];
    public string? VehicleName { get; set; }
    public string? Vin { get; set; }
}


