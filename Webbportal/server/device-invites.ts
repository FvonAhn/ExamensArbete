import { apiFetch } from "$lib/api";
import { BASE_URL } from "../../utils/backend-constants";

export type ConnectionDto = {
  id: number;
  status: number;
  userEmail: string;
  invitedUserEmail: string;
};

export type PendingInvite = {
  id: number;
  userEmail: string | null;
  invitedUserEmail: string | null;
  status: number;
};

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEmail(value: unknown) {
  return clean(value).toLowerCase();
}

export function getAccessToken(locals: App.Locals): string | null {
  const accessToken = locals.accessToken?.trim();
  return accessToken ? accessToken : null;
}

async function safeText(response: Response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function safeJson<T>(response: Response, fallback: T): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    return fallback;
  }
}

function authHeaders(accessToken: string) {
  return {
    Accept: "application/json",
    Authorization: accessToken,
  };
}

function toPendingInvite(connection: ConnectionDto): PendingInvite | null {
  if (!connection || typeof connection.id !== "number") return null;

  return {
    id: connection.id,
    userEmail: clean(connection.userEmail) || null,
    invitedUserEmail: clean(connection.invitedUserEmail) || null,
    status: typeof connection.status === "number" ? connection.status : 0,
  };
}

export async function fetchPendingInvitesForUser(accessToken: string, currentUserEmail: string) {
  const response = await apiFetch(`${BASE_URL}/api/monitoring/connections`, {
    method: "GET",
    headers: authHeaders(accessToken),
  });

  if (!response.ok) {
    const text = await safeText(response);
    return {
      ok: false as const,
      error: text || `Request failed (${response.status})`,
      invites: [] as PendingInvite[],
    };
  }

  const connections = await safeJson<ConnectionDto[]>(response, []);
  const me = normalizeEmail(currentUserEmail);

  const invites = connections
    .map(toPendingInvite)
    .filter((invite): invite is PendingInvite => !!invite)
    .filter((invite) => invite.status === 0 && normalizeEmail(invite.invitedUserEmail) === me);

  return { ok: true as const, error: null as string | null, invites };
}

export async function acceptInvite(accessToken: string, inviteId: string) {
  const response = await apiFetch(
    `${BASE_URL}/api/monitoring/connections/accept?id=${encodeURIComponent(inviteId)}`,
    { method: "PUT", headers: authHeaders(accessToken) },
  );

  if (!response.ok) {
    const text = await safeText(response);
    return { ok: false as const, error: text || `Accept failed (${response.status})` };
  }

  return { ok: true as const, error: null as string | null };
}

export async function declineInvite(accessToken: string, inviteId: string) {
  const response = await apiFetch(
    `${BASE_URL}/api/monitoring/connections/remove?id=${encodeURIComponent(inviteId)}`,
    { method: "DELETE", headers: authHeaders(accessToken) },
  );

  if (!response.ok) {
    const text = await safeText(response);
    return { ok: false as const, error: text || `Decline failed (${response.status})` };
  }

  return { ok: true as const, error: null as string | null };
}
