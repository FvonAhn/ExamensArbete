// Extracted from the original backend: BaServices\\MicroServices\\gRPC\\Users\\MbUsersService\Services\UserService.cs
// Backend service implementation for monitoring invites and shared Maptuners
// Narrow showcase extract. It is not intended to compile standalone.

// ----- source lines 1418-1788 -----
        public override Task<GetMonitoringConnectionsReply> GetMonitoringConnections(
            GetMonitoringConnectionsRequest request,
            ServerCallContext context)
        {
            try
            {
                using var conn = new SqlConnection(_settings.DbConn);
                conn.Open();

                // Lista med alla användarens inbjudningar / kopplingar
                var invites = new List<Invite>();

                // Hämta alla inbjudningar där användaren är avsändare eller mottagare
                const string sql = @"
                    SELECT
                        i.id,
                        i.owner_user_id,
                        i.invited_user_id,
                        i.status,
                        ISNULL(u.email_address, '')      AS owner_email_address,
                        ISNULL(inv.email_address, '')    AS invited_email_address
                    FROM LiveMonitorInvites i
                    LEFT JOIN ApplicationUsers u   ON u.id = i.owner_user_id
                    LEFT JOIN ApplicationUsers inv ON inv.id = i.invited_user_id
                    WHERE i.owner_user_id = @userId OR i.invited_user_id = @userId;
                ";

                using var cmd = new SqlCommand(sql, conn);
                cmd.Parameters.Add("@userId", SqlDbType.Int).Value = request.UserId;

                using var reader = cmd.ExecuteReader();
                while (reader.Read())
                {
                    invites.Add(new Invite
                    {
                        Id = reader.GetInt32(reader.GetOrdinal("id")),
                        UserId = reader.GetInt32(reader.GetOrdinal("owner_user_id")),
                        InvitedUserId = reader.GetInt32(reader.GetOrdinal("invited_user_id")),
                        Status = reader.GetInt32(reader.GetOrdinal("status")),
                        OwnerEmailAddress = reader.GetString(reader.GetOrdinal("owner_email_address")),
                        InvitedEmailAddress = reader.GetString(reader.GetOrdinal("invited_email_address")),
                    });
                }

                return Task.FromResult(new GetMonitoringConnectionsReply
                {
                    Result = MakeOkResult(),
                    Invites = { invites }
                });
            }
            catch (Exception e)
            {
                _logger.LogError(e, "{@request}", request);
                return Task.FromResult(new GetMonitoringConnectionsReply
                {
                    Result = MakeErrorResult(e.Message),
                    Invites = { }
                });
            }
        }


        public override Task<SendInviteReply> SendInvite(
            SendInviteRequest request, 
            ServerCallContext context)
        {
            try
            {
                using var conn = new SqlConnection(_settings.DbConn);
                conn.Open();

                // Validering av e-post
                var invitedEmail = (request.InvitedEmailAddress ?? string.Empty).Trim().ToLowerInvariant();
                if (string.IsNullOrEmpty(invitedEmail))
                {
                    return Task.FromResult(new SendInviteReply
                    {
                        Result = new Result { Ok = false, Info = "InvitedEmailAddress must be provided." }
                    });
                }

                // Hämta mottagarens användar-id via e-post
                int? invitedUserId = null;
                using (var cmd = new SqlCommand("SELECT TOP 1 id FROM ApplicationUsers WHERE LOWER(LTRIM(RTRIM(email_address))) = @email_address", conn))
                {
                    cmd.Parameters.Add("@email_address", SqlDbType.NVarChar, 256).Value = invitedEmail;

                    var result = cmd.ExecuteScalar();
                    if (result != null && result != DBNull.Value)
                        invitedUserId = Convert.ToInt32(result);
                }

                // Om mottagaren inte finns: returnera generiskt svar
                if (!invitedUserId.HasValue)
                {
                    return Task.FromResult(new SendInviteReply
                    {
                        Result = new Result { Ok = true, Info = "Invitation sent to the recipient." }
                    });
                }

                // Förhindra att användaren bjuder in sig själv
                if (invitedUserId.Value == request.UserId)
                {
                    return Task.FromResult(new SendInviteReply
                    {
                        Result = new Result { Ok = false, Info = "You cannot invite yourself." }
                    });
                }

                using var tx = conn.BeginTransaction(IsolationLevel.Serializable);

                // Stoppa dubletter
                using (var cmd = new SqlCommand(@"
                    IF EXISTS (
                        SELECT 1
                        FROM LiveMonitorInvites WITH (UPDLOCK, HOLDLOCK)
                        WHERE owner_user_id = @userId AND invited_user_id = @invitedUserId
                    )
                    BEGIN
                        SELECT CAST(-1 AS INT) AS NewId;
                        RETURN;
                    END

                    INSERT INTO LiveMonitorInvites (owner_user_id, invited_user_id, status)
                    VALUES (@userId, @invitedUserId, 0);

                    SELECT CAST(SCOPE_IDENTITY() AS INT) AS NewId;
                ", conn, tx))
                {
                    cmd.Parameters.Add("@userId", SqlDbType.Int).Value = request.UserId;
                    cmd.Parameters.Add("@invitedUserId", SqlDbType.Int).Value = invitedUserId.Value;

                    var newId = Convert.ToInt32(cmd.ExecuteScalar());

                    if (newId <= 0)
                    {
                        tx.Rollback();
                        return Task.FromResult(new SendInviteReply
                        {
                            Result = new Result { Ok = false, Info = "Invite already exists." }
                        });
                    }

                    tx.Commit();

                    return Task.FromResult(new SendInviteReply
                    {
                        Result = new Result { Ok = true, Info = "Invitation sent to the recipient." },
                        Invite = new Invite
                        {
                            Id = newId,
                            UserId = request.UserId,
                            InvitedUserId = invitedUserId.Value,
                            Status = 0
                        }
                    });
                }
            }
            catch (Exception e)
            {
                _logger.LogError(e, "{@request}", request);
                return Task.FromResult(new SendInviteReply
                {
                    Result = new Result { Ok = false, Info = e.Message }
                });
            }
        }


        public override Task<AcceptInviteReply> AcceptInvite(
            AcceptInviteRequest request,
            ServerCallContext context)
        {
            try
            {
                using var conn = new SqlConnection(_settings.DbConn);
                conn.Open();

                using var cmd = new SqlCommand(@"
                    UPDATE LiveMonitorInvites
                    SET status = 1
                    WHERE id = @inviteId
                      AND invited_user_id = @actingUserId
                      AND status = 0;

                    SELECT @@ROWCOUNT AS UpdatedRows;

                    SELECT id, owner_user_id, invited_user_id, status
                    FROM LiveMonitorInvites
                    WHERE id = @inviteId;
                ", conn);

                cmd.Parameters.Add("@inviteId", SqlDbType.Int).Value = request.InviteId;
                cmd.Parameters.Add("@actingUserId", SqlDbType.Int).Value = request.ActingUserId;

                using var reader = cmd.ExecuteReader();

                var updatedRows = 0;
                if (reader.Read())
                    updatedRows = reader.GetInt32(reader.GetOrdinal("UpdatedRows"));

                if (!reader.NextResult() || !reader.Read())
                {
                    return Task.FromResult(new AcceptInviteReply
                    {
                        Result = new Result { Ok = false, Info = "Invite not found." }
                    });
                }

                var invite = new Invite
                {
                    Id = reader.GetInt32(reader.GetOrdinal("id")),
                    UserId = reader.GetInt32(reader.GetOrdinal("owner_user_id")),
                    InvitedUserId = reader.GetInt32(reader.GetOrdinal("invited_user_id")),
                    Status = reader.GetInt32(reader.GetOrdinal("status")),
                };

                if (invite.InvitedUserId != request.ActingUserId)
                {
                    return Task.FromResult(new AcceptInviteReply
                    {
                        Result = new Result { Ok = false, Info = "You are not allowed to accept this invite." },
                        Invite = invite
                    });
                }

                if (updatedRows == 0)
                {
                    if (invite.Status == 1)
                    {
                        return Task.FromResult(new AcceptInviteReply
                        {
                            Result = new Result { Ok = false, Info = "Invite is already accepted." },
                            Invite = invite
                        });
                    }

                    return Task.FromResult(new AcceptInviteReply
                    {
                        Result = new Result { Ok = false, Info = "Invite is not pending." },
                        Invite = invite
                    });
                }

                return Task.FromResult(new AcceptInviteReply
                {
                    Result = new Result { Ok = true, Info = "" },
                    Invite = invite
                });
            }
            catch (Exception e)
            {
                _logger.LogError(e, "{@request}", request);
                return Task.FromResult(new AcceptInviteReply
                {
                    Result = new Result { Ok = false, Info = e.Message }
                });
            }
        }

        public override Task<RemoveInviteReply> RemoveInvite(
            RemoveInviteRequest request, 
            ServerCallContext context)
        {
            try
            {
                using var conn = new SqlConnection(_settings.DbConn);
                conn.Open();

                // Ta bort inbjudningen om användaren är avsändare eller mottagare
                using var cmd = new SqlCommand("DELETE FROM LiveMonitorInvites WHERE id = @inviteId AND (owner_user_id = @actingUserId OR invited_user_id = @actingUserId)", conn);
                cmd.Parameters.AddWithValue("@inviteId", request.InviteId);
                cmd.Parameters.AddWithValue("@actingUserId", request.ActingUserId);
                int rowsAffected = cmd.ExecuteNonQuery();

                return Task.FromResult(new RemoveInviteReply
                {
                    Result = MakeOkResult(),
                    Success = rowsAffected > 0
                });
            }
            catch (Exception e)
            {
                _logger.LogError(e, "{@request}", request);
                return Task.FromResult(new RemoveInviteReply
                {
                    Result = MakeErrorResult(e.Message),
                    Success = false
                });
            }
        }

        // Ny RPC-metod för att hämta Maptuners
        public override Task<GetMaptunersForLiveStreamReply> GetMaptunersForLiveStream(
            GetMaptunersForLiveStreamRequest request, 
            ServerCallContext context)
        {
            try
            {
                using var conn = new SqlConnection(_settings.DbConn);
                conn.Open();

                var maptuners = new List<MaptunerInfo>();

                // Användarens egna Maptuners
                using (var cmd = new SqlCommand(@"
                    SELECT m.device_identifier AS device_identifier_value, ISNULL(u.email_address,'') AS owner_email_address
                    FROM Devices m
                    LEFT JOIN ApplicationUsers u ON u.id = m.owner_user_id
                    WHERE m.owner_user_id = @userId
                ", conn))
                {
                    cmd.Parameters.Add("@userId", SqlDbType.Int).Value = request.UserId;

                    using var reader = cmd.ExecuteReader();
                    while (reader.Read())
                    {
                        var hwId = (byte[])reader["device_identifier_value"];
                        var hwIdHex = Convert.ToHexString(hwId);
                        var ownerEmail = (string)reader["owner_email_address"];

                        maptuners.Add(new MaptunerInfo
                        {
                            MaptunerId = hwIdHex,
                            Name = hwIdHex,
                            IsShared = false,
                            OwnerEmailAddress = ownerEmail
                        });
                    }
                }

                // Delade Maptuners (accepterade inbjudningar)
                using (var cmd = new SqlCommand(@"
                    SELECT m.device_identifier AS device_identifier_value, ISNULL(u.email_address,'') AS owner_email_address
                    FROM LiveMonitorInvites i
                    INNER JOIN Devices m ON m.owner_user_id = i.owner_user_id
                    LEFT JOIN ApplicationUsers u ON u.id = m.owner_user_id
                    WHERE i.invited_user_id = @userId AND i.status = 1
                ", conn))
                {
                    cmd.Parameters.Add("@userId", SqlDbType.Int).Value = request.UserId;

                    using var reader = cmd.ExecuteReader();
                    while (reader.Read())
                    {
                        var hwId = (byte[])reader["device_identifier_value"];
                        var hwIdHex = Convert.ToHexString(hwId);
                        var ownerEmail = (string)reader["owner_email_address"];

                        maptuners.Add(new MaptunerInfo
                        {
                            MaptunerId = hwIdHex,
                            Name = hwIdHex,
                            IsShared = true,
                            OwnerEmailAddress = ownerEmail
                        });
                    }
                }

                return Task.FromResult(new GetMaptunersForLiveStreamReply
                {
                    Result = MakeOkResult(),
                    Maptuners = { maptuners }
                });
            }
            catch (Exception e)
            {
                _logger.LogError(e, "{@request}", request);
                return Task.FromResult(new GetMaptunersForLiveStreamReply
                {






