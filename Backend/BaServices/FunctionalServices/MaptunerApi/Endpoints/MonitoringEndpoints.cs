using MaptunerApi.Endpoints.Auth;
using MaptunerApi.Endpoints.Internal;
using MaptunerApi.Hubs;
using MbUsers;
using MbUsers.client;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using System.ComponentModel.DataAnnotations;
using System.Security.Claims;

namespace MaptunerApi.Endpoints;

public class MonitoringEndpoints : IEndpoints
{
    private const string Tag = "Monitoring";
    private const string BaseRoute = "api/monitoring";

    public static void AddServices(IServiceCollection services, IConfiguration configuration)
    {
    }

    public static void DefineEndpoints(IEndpointRouteBuilder app)
    {
        app.MapGet($"{BaseRoute}/status", GetStatus)
            .WithName("GetMonitoringStatus")
            .WithSummary("Get telemetry hub status")
            .WithDescription("Returns basic status information about the telemetry monitoring hub, including connection details.")
            .ProducesOk<MonitoringStatusResponse>()
            .ProducesUnauthorized()
            .RequireAuthorization()
            .WithTags(Tag);

        app.MapGet($"{BaseRoute}/connection-info", GetConnectionInfo)
            .WithName("GetMonitoringConnectionInfo")
            .WithSummary("Get SignalR connection information")
            .WithDescription("Returns the information needed to connect to the SignalR hub, including the endpoint URL and authentication requirements.")
            .ProducesOk<ConnectionInfoResponse>()
            .ProducesUnauthorized()
            .RequireAuthorization()
            .WithTags(Tag);

        app.MapGet($"{BaseRoute}/test-auth", TestAuth)
            .WithName("TestMonitoringAuth")
            .WithSummary("Test authentication token")
            .WithDescription("Validates that your JWT token is working correctly for monitoring endpoints. Returns your user claims.")
            .ProducesOk<AuthTestResponse>()
            .ProducesUnauthorized()
            .RequireAuthorization()
            .WithTags(Tag);

        app.MapGet($"{BaseRoute}/connections", GetMonitoringConnections)
            .WithName("GetMonitoringConnections")
            .WithSummary("Get monitoring connections")
            .WithDescription("Returns monitoring related user connections.")
            .ProducesOk<List<MonitoringConnectionResponse>>()
            .ProducesUnauthorized()
            .RequireAuthorization()
            .WithTags(Tag);

        app.MapPost($"{BaseRoute}/connections/invite", SendInvite)
            .WithName("SendMonitoringInvite")
            .WithSummary("Send a user invite")
            .WithDescription("Creates a new invite relationship between two users.")
            .ProducesOk<MonitoringConnectionActionResponse>()
            .ProducesBadRequest()
            .Produces(StatusCodes.Status409Conflict)
            .ProducesUnauthorized()
            .RequireAuthorization()
            .WithTags(Tag);

        app.MapPut($"{BaseRoute}/connections/accept", AcceptInvite)
            .WithName("AcceptMonitoringInvite")
            .WithSummary("Accept a user invite")
            .WithDescription("Accepts an existing invite by id (query parameter).")
            .ProducesOk<MonitoringConnectionActionResponse>()
            .Produces(StatusCodes.Status404NotFound)
            .Produces(StatusCodes.Status403Forbidden)
            .Produces(StatusCodes.Status409Conflict)
            .ProducesUnauthorized()
            .RequireAuthorization()
            .WithTags(Tag);

        app.MapDelete($"{BaseRoute}/connections/remove", RemoveConnection)
            .WithName("RemoveMonitoringConnection")
            .WithSummary("Remove a monitoring connection")
            .WithDescription("Removes an existing monitoring connection by id (query parameter).")
            .ProducesNoContent()
            .Produces(StatusCodes.Status404NotFound)
            .Produces(StatusCodes.Status403Forbidden)
            .ProducesUnauthorized()
            .RequireAuthorization()
            .WithTags(Tag);

        app.MapGet($"{BaseRoute}/maptuners", GetMaptunersForLiveStream)
            .WithName("GetMaptunersForLiveStream")
            .WithSummary("Get Maptuners for live stream")
            .WithDescription("Returns a list of the user's own Maptuners and shared Maptuners.")
            .ProducesOk<List<MaptunerInfo>>()
            .ProducesUnauthorized()
            .RequireAuthorization()
            .WithTags(Tag);
    }

    private static IResult GetStatus(
        ILogger<MonitoringEndpoints> logger,
        IHubContext<TelemetryHub> hubContext)
    {
        logger.LogInformation("Monitoring status requested");

        var response = new MonitoringStatusResponse
        {
            Status = "active",
            HubEndpoint = "/monitoring-broadcast",
            Message = "Telemetry hub is operational",
            ServerTime = DateTimeOffset.UtcNow
        };

        return Results.Ok(response);
    }

    private static IResult GetConnectionInfo(
        HttpContext context,
        ILogger<MonitoringEndpoints> logger)
    {
        logger.LogInformation("Connection info requested");

        var scheme = context.Request.Scheme;
        var host = context.Request.Host.Value;
        var hubPath = "/monitoring-broadcast";

        var response = new ConnectionInfoResponse
        {
            HubEndpoint = hubPath,
            FullUrl = $"{scheme}://{host}{hubPath}",
            AuthenticationMethod = "JWT",
            AuthenticationNote = "For SignalR WebSocket connections, pass JWT token as query parameter: ?access_token=YOUR_JWT_TOKEN",
            Methods = new[]
            {
                "JoinDeviceGroup(deviceId) - Subscribe to device telemetry",
                "SendTelemetryFrame(frame) - Broadcast telemetry data",
                "SendTelemetryMeta(frame) - Broadcast parameter metadata"
            },
            ClientEvents = new[]
            {
                "TelemetryUpdated - Fires when new telemetry data arrives",
                "TelemetryMetaUpdated - Fires when parameter metadata is updated"
            }
        };

        return Results.Ok(response);
    }

    private static IResult TestAuth(
        HttpContext context,
        ILogger<MonitoringEndpoints> logger)
    {
        var user = context.User;

        logger.LogInformation("Auth test requested by user: {UserId}",
            user.FindFirst(ClaimTypes.NameIdentifier)?.Value ?? "unknown");

        var response = new AuthTestResponse
        {
            IsAuthenticated = user.Identity?.IsAuthenticated ?? false,
            AuthenticationType = user.Identity?.AuthenticationType ?? "none",
            UserName = user.Identity?.Name ?? "unknown",
            Claims = user.Claims.Select(c => new ClaimInfo
            {
                Type = c.Type,
                Value = c.Value
            }).ToArray(),
            Message = "Your JWT token is valid and authentication is working correctly."
        };

        return Results.Ok(response);
    }

    private static async Task<IResult> GetMonitoringConnections(
        HttpContext context,
        IMbUsers users,
        ILogger<MonitoringEndpoints> logger)
    {
        try
        {
            var a = context.Auth(users, logger);

            if (a.Result == AuthResult.ResultCodes.SessionNotFound)
                return Results.Unauthorized();

            using (logger.ScopeUserId(a.Session))
            {
                var reply = users.GetMonitoringConnections(a.Session.UserId);

                // Consistent Result mapping
                if (reply?.Result == null)
                    return Results.Problem();

                if (!reply.Result.Ok)
                    return Results.BadRequest(reply.Result.Info);

                var inviteResponses = reply.Invites.Select(i => new MonitoringConnectionResponse
                {
                    Id = i.Id,
                    Status = i.Status,
                    OwnerEmailAddress = i.OwnerEmailAddress ?? "",
                    InvitedEmailAddress = i.InvitedEmailAddress ?? ""
                }).ToList();

                return Results.Ok(inviteResponses);
            }
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to get monitoring connections");
            return Results.Problem();
        }
    }

    private static async Task<IResult> SendInvite(
        HttpContext context,
        IMbUsers users,
        SendInviteEmailRequest request,
        ILogger<MonitoringEndpoints> logger)
    {
        try
        {
            var a = context.Auth(users, logger);

            if (a.Result == AuthResult.ResultCodes.SessionNotFound)
                return Results.Unauthorized();

            using (logger.ScopeUserId(a.Session))
            {
                if (string.IsNullOrWhiteSpace(request.InvitedEmailAddress))
                    return Results.BadRequest("InvitedEmailAddress must be provided.");

                if (request.InvitedEmailAddress.Equals(a.Session.UserName, StringComparison.OrdinalIgnoreCase))
                    return Results.BadRequest("You cannot invite yourself.");

                var reply = users.SendInvite(a.Session.UserId, request.InvitedEmailAddress);

                // Consistent Result mapping
                if (reply?.Result == null)
                    return Results.Problem();

                if (!reply.Result.Ok)
                {
                    if (string.Equals(reply.Result.Info, "Invite already exists.", StringComparison.OrdinalIgnoreCase))
                        return Results.Conflict(reply.Result.Info);

                    return Results.BadRequest(reply.Result.Info);
                }

                if (reply.Invite == null)
                    return Results.Problem("Invite was not created.");

                return Results.Ok(new MonitoringConnectionActionResponse
                {
                    Id = reply.Invite.Id,
                    Status = reply.Invite.Status,
                    OwnerEmailAddress = reply.Invite.OwnerEmailAddress ?? "",
                    InvitedEmailAddress = reply.Invite.InvitedEmailAddress ?? ""
                });
            }
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to send invite");
            return Results.Problem();
        }
    }

    private static async Task<IResult> AcceptInvite(
        HttpContext context,
        IMbUsers users,
        [FromQuery] int id,
        ILogger<MonitoringEndpoints> logger)
    {
        try
        {
            var a = context.Auth(users, logger);

            if (a.Result == AuthResult.ResultCodes.SessionNotFound)
                return Results.Unauthorized();

            using (logger.ScopeUserId(a.Session))
            {
                if (id <= 0)
                    return Results.BadRequest("Invite id must be a positive integer.");

                var reply = users.AcceptInvite(id, a.Session.UserId);

                // Consistent Result mapping
                if (reply?.Result == null)
                    return Results.Problem();

                if (!reply.Result.Ok)
                {
                    // keep behavior stable, but map obvious cases cleanly
                    if (reply.Result.Info.Contains("not allowed", StringComparison.OrdinalIgnoreCase))
                        return Results.Forbid();

                    if (reply.Result.Info.Contains("not found", StringComparison.OrdinalIgnoreCase))
                        return Results.NotFound();

                    if (reply.Result.Info.Contains("already", StringComparison.OrdinalIgnoreCase))
                        return Results.Conflict(reply.Result.Info);

                    return Results.BadRequest(reply.Result.Info);
                }

                if (reply.Invite == null)
                    return Results.NotFound();

                return Results.Ok(new MonitoringConnectionActionResponse
                {
                    Id = reply.Invite.Id,
                    Status = reply.Invite.Status,
                    OwnerEmailAddress = reply.Invite.OwnerEmailAddress ?? "",
                    InvitedEmailAddress = reply.Invite.InvitedEmailAddress ?? ""
                });
            }
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to accept invite");
            return Results.Problem();
        }
    }

    private static async Task<IResult> RemoveConnection(
        HttpContext context,
        IMbUsers users,
        [FromQuery] int id,
        ILogger<MonitoringEndpoints> logger)
    {
        try
        {
            var a = context.Auth(users, logger);

            if (a.Result == AuthResult.ResultCodes.SessionNotFound)
                return Results.Unauthorized();

            using (logger.ScopeUserId(a.Session))
            {
                if (id <= 0)
                    return Results.BadRequest("Connection id must be a positive integer.");

                var reply = users.RemoveInvite(id, a.Session.UserId);

                // Consistent Result mapping (but do not change overall behavior)
                if (reply?.Result == null)
                    return Results.NoContent();

                if (!reply.Result.Ok)
                {
                    if (reply.Result.Info.Contains("not allowed", StringComparison.OrdinalIgnoreCase))
                        return Results.Forbid();

                    if (reply.Result.Info.Contains("not found", StringComparison.OrdinalIgnoreCase))
                        return Results.NotFound();

                    return Results.BadRequest(reply.Result.Info);
                }

                if (!reply.Success)
                    return Results.NotFound();

                return Results.NoContent();
            }
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to remove connection");
            return Results.Problem();
        }
    }

    private static async Task<IResult> GetMaptunersForLiveStream(
        HttpContext context,
        IMbUsers users,
        ILogger<MonitoringEndpoints> logger)
    {
        try
        {
            var a = context.Auth(users, logger);

            if (a.Result == AuthResult.ResultCodes.SessionNotFound)
                return Results.Unauthorized();

            using (logger.ScopeUserId(a.Session))
            {
                var reply = users.GetMaptunersForLiveStream(a.Session.UserId);

                // Consistent Result mapping
                if (reply?.Result == null)
                    return Results.Problem();

                if (!reply.Result.Ok)
                    return Results.BadRequest(reply.Result.Info);

                var result = reply.Maptuners
                    .Select(m => new MaptunerInfo
                    {
                        MaptunerId = m.MaptunerId ?? "",
                        Name = m.Name ?? "",
                        IsShared = m.IsShared,
                        OwnerEmailAddress = m.OwnerEmailAddress ?? ""
                    })
                    .ToList();

                return Results.Ok(result);
            }
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to get Maptuners for live stream");
            return Results.Problem();
        }
    }

    // Response DTOs
    private class MonitoringStatusResponse
    {
        public string Status { get; set; } = "";
        public string HubEndpoint { get; set; } = "";
        public string Message { get; set; } = "";
        public DateTimeOffset ServerTime { get; set; }
    }

    private class ConnectionInfoResponse
    {
        public string HubEndpoint { get; set; } = "";
        public string FullUrl { get; set; } = "";
        public string AuthenticationMethod { get; set; } = "";
        public string AuthenticationNote { get; set; } = "";
        public string[] Methods { get; set; } = Array.Empty<string>();
        public string[] ClientEvents { get; set; } = Array.Empty<string>();
    }

    private class AuthTestResponse
    {
        public bool IsAuthenticated { get; set; }
        public string AuthenticationType { get; set; } = "";
        public string UserName { get; set; } = "";
        public ClaimInfo[] Claims { get; set; } = Array.Empty<ClaimInfo>();
        public string Message { get; set; } = "";
    }

    private class ClaimInfo
    {
        public string Type { get; set; } = "";
        public string Value { get; set; } = "";
    }

    private class MonitoringConnectionResponse
    {
        public int Id { get; set; }
        public int Status { get; set; }
        public string OwnerEmailAddress { get; set; } = "";
        public string InvitedEmailAddress { get; set; } = "";
    }

    private class MonitoringConnectionActionResponse
    {
        public int Id { get; set; }
        public int Status { get; set; }
        public string InvitedEmailAddress { get; set; } = "";
        public string OwnerEmailAddress { get; set; } = "";
    }

    private class SendInviteEmailRequest
    {
        [Required(ErrorMessage = "InvitedEmailAddress is required")]
        public string InvitedEmailAddress { get; set; } = "";
    }

    public class MaptunerInfo
    {
        public string MaptunerId { get; set; } = "";
        public string Name { get; set; } = "";
        public bool IsShared { get; set; }
        public string OwnerEmailAddress { get; set; } = "";
    }
}



