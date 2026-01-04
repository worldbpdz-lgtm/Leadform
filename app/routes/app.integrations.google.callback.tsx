// app/routes/app.integrations.google.callback.tsx
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import { prisma } from "~/db.server";
import { encryptString, getGoogleOAuthClient, verifyState } from "~/lib/google.server";

export const headers: HeadersFunction = () => ({
  "Cache-Control": "no-store",
});

function safeReturnTo(input: string | null) {
  const v = (input || "").trim();
  if (!v) return "/app/integrations";
  // Only allow same-origin relative paths
  if (!v.startsWith("/")) return "/app/integrations";
  return v;
}

function redirectWithParams(returnTo: string, params: Record<string, string>) {
  const base = safeReturnTo(returnTo);
  const u = new URL(base, "https://local");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return redirect(u.pathname + u.search);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  // Default fallback (we’ll override if state JSON provides returnTo)
  let returnTo = "/app/integrations";

  if (error) {
    return redirectWithParams(returnTo, { google: "error", reason: String(error) });
  }

  if (!code || !stateRaw) {
    return redirectWithParams(returnTo, { google: "error", reason: "missing_code_or_state" });
  }

  // Your start route sends: state = JSON.stringify({ state, returnTo })
  let signedState = stateRaw;
  try {
    const parsed = JSON.parse(stateRaw);
    if (parsed && typeof parsed === "object") {
      if (typeof (parsed as any).returnTo === "string") returnTo = (parsed as any).returnTo;
      if (typeof (parsed as any).state === "string") signedState = (parsed as any).state;
    }
  } catch {
    // If it wasn't JSON, treat stateRaw as the signed state
  }

  const st = verifyState(signedState);
  if (!st.ok) {
    return redirectWithParams(returnTo, { google: "error", reason: `state_${st.reason}` });
  }

  // IMPORTANT: do NOT require authenticate.admin() here.
  // This callback is hit by Google (top-level), often without Shopify embedded session cookies.
  const shopDomain = st.shopDomain;

  const shop = await prisma.shop.upsert({
    where: { shopDomain },
    update: { uninstalledAt: null },
    create: { shopDomain, installedAt: new Date() },
    select: { id: true },
  });

  const oauth = getGoogleOAuthClient();
  const tokenRes = await oauth.getToken(code);
  const tokens = tokenRes.tokens;

  const accessToken = tokens.access_token || "";
  const refreshToken = tokens.refresh_token || "";
  const expiryMs = typeof tokens.expiry_date === "number" ? tokens.expiry_date : null;

  if (!accessToken) {
    return redirectWithParams(returnTo, { google: "error", reason: "missing_access_token" });
  }

  // refresh_token may be omitted on reconnect; keep existing if present
  const existing = await prisma.oAuthGoogle.findUnique({
    where: { shopId: shop.id },
    select: { refreshTokenEnc: true },
  });

  const refreshTokenEnc = refreshToken ? encryptString(refreshToken) : existing?.refreshTokenEnc;

  if (!refreshTokenEnc) {
    return redirectWithParams(returnTo, { google: "error", reason: "missing_refresh_token_reconsent" });
  }

  const expiresAt = new Date(expiryMs ?? Date.now() + 55 * 60 * 1000);

  await prisma.oAuthGoogle.upsert({
    where: { shopId: shop.id },
    update: {
      accessTokenEnc: encryptString(accessToken),
      refreshTokenEnc,
      expiresAt,
      scope: tokens.scope ?? null,
    },
    create: {
      shopId: shop.id,
      accessTokenEnc: encryptString(accessToken),
      refreshTokenEnc,
      expiresAt,
      scope: tokens.scope ?? null,
    },
  });

  return redirectWithParams(returnTo, { google: "connected" });
};
