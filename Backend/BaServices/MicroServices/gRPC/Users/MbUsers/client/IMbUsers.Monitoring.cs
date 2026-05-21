// Extracted from the original backend: BaServices\MicroServices\gRPC\Users\MbUsers\client\IMbUsers.cs
// Client interface methods used by MonitoringEndpoints
// Narrow showcase extract. It is not intended to compile standalone.

// ----- source lines 80-87 -----
    public GetMonitoringConnectionsReply? GetMonitoringConnections(int userId);

    public SendInviteReply? SendInvite(int senderId, string invitedEmailAddress);
    public AcceptInviteReply? AcceptInvite(int inviteId, int actingUserId);
    public RemoveInviteReply? RemoveInvite(int inviteId, int actingUserId);

    // Ny metod för att hämta Maptuners
    public GetMaptunersForLiveStreamReply? GetMaptunersForLiveStream(int userId);



