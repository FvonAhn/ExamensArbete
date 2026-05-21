// Extracted from the original backend: BaServices\MicroServices\gRPC\Users\MbUsers\client\MbUsers.cs
// gRPC client wrappers used by MonitoringEndpoints
// Narrow showcase extract. It is not intended to compile standalone.

// ----- source lines 575-647 -----
    public GetMonitoringConnectionsReply? GetMonitoringConnections(int userId)
    {
        try
        {
            var client = UserClient.GetOrCreate(_url, _cert);
            var reply = client.GetMonitoringConnections(new GetMonitoringConnectionsRequest { UserId = userId });
            return reply;
        }
        catch (Exception)
        {
            UserClient.Reset();
            throw;
        }
    }

    public SendInviteReply? SendInvite(int senderId, string invitedEmailAddress)
    {
        try
        {
            var client = UserClient.GetOrCreate(_url, _cert);

            var reply = client.SendInvite(new SendInviteRequest { UserId = senderId, InvitedEmailAddress = invitedEmailAddress });

            return reply;
        }
        catch (Exception)
        {
            UserClient.Reset();
            throw;
        }
    }

    public AcceptInviteReply? AcceptInvite(int inviteId, int actingUserId)
    {
        try
        {
            var client = UserClient.GetOrCreate(_url, _cert);
            var reply = client.AcceptInvite(new AcceptInviteRequest { InviteId = inviteId, ActingUserId = actingUserId });
            return reply;
        }
        catch (Exception)
        {
            UserClient.Reset();
            throw;
        }
    }

    public RemoveInviteReply? RemoveInvite(int inviteId, int actingUserId)
    {
        try
        {
            var client = UserClient.GetOrCreate(_url, _cert);
            var reply = client.RemoveInvite(new RemoveInviteRequest { InviteId = inviteId, ActingUserId = actingUserId });
            return reply;
        }
        catch (Exception)
        {
            UserClient.Reset();
            throw;
        }
    }

    public GetMaptunersForLiveStreamReply? GetMaptunersForLiveStream(int userId)
    {
        try
        {
            var client = UserClient.GetOrCreate(_url, _cert);
            var reply = client.GetMaptunersForLiveStream(new GetMaptunersForLiveStreamRequest { UserId = userId });
            return reply;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to get Maptuners for live stream");



