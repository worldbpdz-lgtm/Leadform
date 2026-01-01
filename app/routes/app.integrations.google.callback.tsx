// app/routes/app.integrations.google.callback.tsx
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import { prisma } from "~/db.server";
import { authenticate } from "~/shopify.server";
import {
  encryptString,
  getGoogleOAuthClient,
  verifyState,
} from "~/lib/google.server";

export const headers: HeadersFunction = () => ({
  "Cache-Control": "no-store",
});

function toIntegrations(params: Record<string, string>) {
  const qs = new URLSearchParams(params);
  return redirect(`/app/integrations?${qs.toString()}`);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return toIntegrations({ google: "error", reason: String(error) });
  }

  if (!code || !stateRaw) {
    return toIntegrations({ google: "error", reason: "missing_code_or_state" });
  }

  // ✅ verifyState(state) only
  const st = verifyState(stateRaw);
  if (!st.ok) {
    return toIntegrations({ google: "error", reason: `state_${st.reason}` });
  }

  // ✅ bind state to the same shop as the Shopify session
  if (st.shopDomain !== session.shop) {
    return toIntegrations({ google: "error", reason: "shop_mismatch" });
  }

  const shop = await prisma.shop.upsert({
    where: { shopDomain: session.shop },
    update: { uninstalledAt: null },
    create: { shopDomain: session.shop, installedAt: new Date() },
    select: { id: true },
  });

  const oauth = getGoogleOAuthClient();

  const tokenRes = await oauth.getToken(code);
  const tokens = tokenRes.tokens;

  const accessToken = tokens.access_token || "";
  const refreshToken = tokens.refresh_token || "";
  const expiryMs = typeof tokens.expiry_date === "number" ? tokens.expiry_date : null;

  if (!accessToken) {
    return toIntegrations({ google: "error", reason: "missing_access_token" });
  }

  // refresh_token may be omitted on re-connect; keep existing if present
  const existing = await prisma.oAuthGoogle.findUnique({
    where: { shopId: shop.id },
    select: { refreshTokenEnc: true },
  });

  const refreshTokenEnc = refreshToken
    ? encryptString(refreshToken)
    : existing?.refreshTokenEnc;

  // If you never obtained a refresh token, you can't do reliable background sync
  if (!refreshTokenEnc) {
    return toIntegrations({ google: "error", reason: "missing_refresh_token_reconsent" });
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

  return toIntegrations({ google: "connected" });
};
