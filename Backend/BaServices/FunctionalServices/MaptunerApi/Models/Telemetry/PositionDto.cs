namespace MaptunerApi.Models.Telemetry;

// GPS position attached to a telemetry frame.
public sealed class PositionDto
{
    public double? Latitude { get; set; }
    public double? Longitude { get; set; }

    public double? Accuracy { get; set; }          // meters
    public double? Speed { get; set; }             // m/s
    public double? Heading { get; set; }           // degrees
    public double? Altitude { get; set; }          // meters
    public double? AltitudeAccuracy { get; set; }  // meters
}

