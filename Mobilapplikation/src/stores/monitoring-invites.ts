import {
  getAccessTokenCached,
  getAccessTokenNew,
  getBaseUrlMobileApi,
} from "./auth";

export type SendInviteResult = {
  ok: boolean;
  info?: string;
};

export type MonitoringConnection = {
  id: number;
  status: number;
  userEmail: string;
  invitedUserEmail: string;
};

type AuthTestResponse = {
  userName?: string;
  claims?: Array<{ type: string; value: string }>;
};

function normalizeEmail(email: string): string {
  return (email ?? "").trim().toLowerCase();
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

function isValidEmail(email: string): boolean {
  return looksLikeEmail(email);
}

async function getBearerToken(baseUrl: string): Promise<string> {
  let token = getAccessTokenCached(baseUrl);
  if (!token || token.length < 10) token = await getAccessTokenNew(baseUrl);
  return token;
}

async function readError(res: Response): Promise<string> {
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    try {
      const json: any = await res.json();
      return json?.info || json?.detail || json?.message || "Request failed.";
    } catch {
      return "Request failed.";
    }
  }

  return (await res.text().catch(() => "")) || "Request failed.";
}

let cachedMyEmail: string | null = null;

function pickEmailFromAuthTest(r: AuthTestResponse | null): string | null {
  if (!r) return null;

  for (const c of r.claims ?? []) {
    const v = typeof c?.value === "string" ? c.value : "";
    if (!v) continue;

    const normalized = normalizeEmail(v);
    if (looksLikeEmail(normalized)) return normalized;
  }

  return null;
}


// Returns the signed in user email.

export async function getMyEmail(): Promise<string | null> {
  if (cachedMyEmail) return cachedMyEmail;

  const baseUrl = getBaseUrlMobileApi();
  const token = await getBearerToken(baseUrl);

  const res = await fetch(`${baseUrl}/api/live-telemetry/test-auth`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) return null;

  const json = (await res.json().catch(() => null)) as AuthTestResponse | null;
  const email = pickEmailFromAuthTest(json);

  if (email) cachedMyEmail = email;

  return email;
}


// Sends a single monitoring invite by email.

export async function sendMonitoringInvite(
  invitedUserEmail: string
): Promise<SendInviteResult> {
  const email = normalizeEmail(invitedUserEmail);

  if (!email) return { ok: false, info: "Email is required." };
  if (!isValidEmail(email)) return { ok: false, info: "Invalid email address." };

  const baseUrl = getBaseUrlMobileApi();
  const token = await getBearerToken(baseUrl);

  const res = await fetch(`${baseUrl}/api/live-telemetry/connections/invite`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ invitedUserEmail: email }),
  });

  if (!res.ok) {
    const msg = await readError(res);
    throw new Error(msg);
  }

  return { ok: true };
}


// Fetches all monitoring connections (incoming + outgoing).

export async function getMonitoringConnections(): Promise<MonitoringConnection[]> {
  const baseUrl = getBaseUrlMobileApi();
  const token = await getBearerToken(baseUrl);

  const res = await fetch(`${baseUrl}/api/live-telemetry/connections`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    const msg = await readError(res);
    throw new Error(msg);
  }

  const json = (await res.json().catch(() => [])) as unknown;
  return Array.isArray(json) ? (json as MonitoringConnection[]) : [];
}


// Removes a connection/invite by id.

export async function removeMonitoringConnection(id: number): Promise<void> {
  const baseUrl = getBaseUrlMobileApi();
  const token = await getBearerToken(baseUrl);

  const res = await fetch(
    `${baseUrl}/api/live-telemetry/connections/remove?id=${id}`,
    {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${token}`,
      },
    }
  );

  if (res.status === 204) return;

  if (!res.ok) {
    const msg = await readError(res);
    throw new Error(msg);
  }
}