// app/routes/app.integrations.google.callback.tsx
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "~/shopify.server";
import { prisma } from "~/db.server";
import { encryptString, getGoogleOAuthClient, verifyState } from "~/lib/google.server";

function redirect(to: string) {
  return new Response(null, { status: 302, headers: { Location: to } });
}

function safeJsonParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

type PackedState = { state: string; returnTo?: string };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  const packed = safeJsonParse<PackedState>(url.searchParams.get("state"));
  const rawState = packed?.state || "";
  const returnTo = packed?.returnTo || "/app/integrations";

  if (error) {
    return redirect(`${returnTo}?google=error&reason=${encodeURIComponent(error)}`);
  }
  if (!code) {
    return redirect(`${returnTo}?google=error&reason=missing_code`);
  }

  const ver = verifyState(rawState, session.shop);
  if (!ver.ok) {
    return redirect(`${returnTo}?google=error&reason=bad_state`);
  }

  const client = getGoogleOAuthClient();
  const { tokens } = await client.getToken(code);

  const accessToken = tokens.access_token ?? null;
  const refreshToken = tokens.refresh_token ?? null;

  const expiresAt =
    typeof tokens.expiry_date === "number" ? new Date(tokens.expiry_date) : undefined;

  const scope =
    typeof tokens.scope === "string" && tokens.scope.trim().length
      ? tokens.scope.trim()
      : null;

  if (!accessToken) {
    return redirect(`${returnTo}?google=error&reason=missing_access_token`);
  }

  const shopRow = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });
  if (!shopRow) {
    return redirect(`${returnTo}?google=error&reason=shop_not_found`);
  }

  const existing = await prisma.oAuthGoogle.findUnique({
    where: { shopId: shopRow.id },
    select: { id: true, refreshTokenEnc: true },
  });

  const accessTokenEnc = encryptString(accessToken);
  const refreshTokenEnc =
    refreshToken ? encryptString(refreshToken) : existing?.refreshTokenEnc ?? "";

  await prisma.oAuthGoogle.upsert({
    where: { shopId: shopRow.id },
    update: {
      accessTokenEnc,
      refreshTokenEnc,
      scope,
      ...(expiresAt ? { expiresAt } : {}),
    },
    create: {
      shopId: shopRow.id,
      accessTokenEnc,
      refreshTokenEnc,
      scope,
      expiresAt: expiresAt ?? new Date(Date.now() + 55 * 60 * 1000),
    },
  });

  await prisma.sheetsConnection.upsert({
    where: { shopId_spreadsheetId: { shopId: shopRow.id, spreadsheetId: "primary" } },
    update: { active: true },
    create: {
      shopId: shopRow.id,
      spreadsheetId: "primary",
      active: true,
    },
  });

  return redirect(`${returnTo}?google=connected`);
};

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
