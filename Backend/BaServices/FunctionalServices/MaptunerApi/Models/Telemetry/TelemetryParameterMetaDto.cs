namespace MaptunerApi.Models.Telemetry;

public class TelemetryParameterMetaDto
{
    public string Key { get; set; } = "";
    public string Name { get; set; } = "";
    public string Unit { get; set; } = "";
    public string Module { get; set; } = "";
    public double Min { get; set; }
    public double Max { get; set; }
}


