// Checks that the caller is a signed-in user of our Entra tenant.
// The browser sends its Microsoft ID token in the X-Taskmeil-Token header
// (Static Web Apps overwrites the standard Authorization header).

let jwksPromise;

function getJwks(tenantId) {
  if (!jwksPromise) {
    jwksPromise = import("jose").then(({ createRemoteJWKSet }) =>
      createRemoteJWKSet(
        new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`)
      )
    );
  }
  return jwksPromise;
}

class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.status = status;
  }
}

async function verifyUser(token) {
  const tenantId = process.env.ENTRA_TENANT_ID;
  const clientId = process.env.ENTRA_CLIENT_ID;
  if (!tenantId || !clientId) {
    throw new AuthError("Server is missing ENTRA_TENANT_ID or ENTRA_CLIENT_ID.", 500);
  }
  if (!token) throw new AuthError("Missing sign-in token.");

  const { jwtVerify } = await import("jose");
  let payload;
  try {
    ({ payload } = await jwtVerify(token, await getJwks(tenantId), {
      issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      audience: clientId,
    }));
  } catch {
    throw new AuthError("Sign-in token is invalid or expired.");
  }
  if (payload.tid !== tenantId) throw new AuthError("Wrong tenant.", 403);

  // Optional: ALLOWED_USERS="a@uusmaa.ee,b@uusmaa.ee" limits who may use Claude.
  const allowed = (process.env.ALLOWED_USERS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const user = String(payload.preferred_username || payload.email || "").toLowerCase();
  if (allowed.length && !allowed.includes(user)) {
    throw new AuthError("This account is not allowed to use Claude here.", 403);
  }
  return { user, name: payload.name || user };
}

module.exports = { verifyUser, AuthError };
