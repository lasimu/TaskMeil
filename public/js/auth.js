// Sign-in with a Microsoft work account (MSAL.js v5, redirect flow).
// Tokens stay in the browser; the Graph token is never sent to our server.

const msal = window.msal;
const cfg = window.TASKMEIL_CONFIG || {};

export const GRAPH_SCOPES = [
  "User.Read",
  "Mail.ReadWrite",
  "Mail.Send",
  "Calendars.ReadWrite",
  "Tasks.ReadWrite",
  "People.Read",
];

let pca;
let account = null;

export function isConfigured() {
  const isId = (v) => /^[0-9a-f-]{36}$/i.test(v || "");
  return isId(cfg.clientId) && isId(cfg.tenantId);
}

export async function initAuth() {
  pca = new msal.PublicClientApplication({
    auth: {
      clientId: cfg.clientId,
      authority: `https://login.microsoftonline.com/${cfg.tenantId}`,
      redirectUri: `${location.origin}/auth/`,
      postLogoutRedirectUri: `${location.origin}/`,
    },
    cache: { cacheLocation: "localStorage" },
  });
  await pca.initialize();
  const result = await pca.handleRedirectPromise();
  account = result?.account || pca.getActiveAccount() || pca.getAllAccounts()[0] || null;
  if (account) pca.setActiveAccount(account);
  return account;
}

export function getAccount() {
  return account;
}

export function login() {
  return pca.loginRedirect({ scopes: GRAPH_SCOPES, prompt: "select_account" });
}

export function logout() {
  return pca.logoutRedirect({ account });
}

async function silent(request) {
  try {
    return await pca.acquireTokenSilent({ account, ...request });
  } catch (err) {
    if (err instanceof msal.InteractionRequiredAuthError) {
      // The session ended or new consent is needed: go through Microsoft again.
      await pca.acquireTokenRedirect({ account, scopes: request.scopes });
      return new Promise(() => {}); // the page is navigating away
    }
    throw err;
  }
}

export async function getGraphToken() {
  return (await silent({ scopes: GRAPH_SCOPES })).accessToken;
}

// ID token that proves to /api/claude who is calling. Refreshed when close to expiry.
export async function getIdToken() {
  let result = await silent({ scopes: GRAPH_SCOPES });
  const exp = result.idTokenClaims?.exp || 0;
  if (exp * 1000 < Date.now() + 5 * 60 * 1000) {
    result = await silent({ scopes: GRAPH_SCOPES, forceRefresh: true });
  }
  return result.idToken;
}
