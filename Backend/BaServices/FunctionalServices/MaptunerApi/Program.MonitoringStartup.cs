// Extracted from binaccess: BaServices\FunctionalServices\MaptunerApi\Program.cs
// SignalR, JWT query-string auth, streaming state, and hub route registration
// Narrow showcase extract. It is not intended to compile standalone.

// ----- source lines 83-88 -----
// SignalR for telemetry broadcasting
builder.Services.AddSignalR();

// Telemetry streaming state & monitor
builder.Services.AddSingleton<TelemetryStreamState>();
builder.Services.AddHostedService<TelemetryStreamMonitor>();

// ----- source lines 121-130 -----
    // Allow SignalR to read JWT from query string (required for WebSocket connections)
    o.Events = new JwtBearerEvents
    {
        OnMessageReceived = context =>
        {
            var accessToken = context.Request.Query["access_token"];
            var path = context.HttpContext.Request.Path;
            if (!string.IsNullOrEmpty(accessToken) && 
                path.StartsWithSegments("/monitoring-broadcast"))
            {

// ----- source lines 192-193 -----
// Map SignalR hub for telemetry broadcasting
app.MapHub<MaptunerApi.Hubs.TelemetryHub>("/monitoring-broadcast")


