// app/routes/app.integrations.google.start.tsx
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "~/shopify.server";
import { GOOGLE_SCOPES, getGoogleOAuthClient, makeState } from "~/lib/google.server";

function redirect(to: string) {
  return new Response(null, { status: 302, headers: { Location: to } });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const client = getGoogleOAuthClient();

  const url = new URL(request.url);

  // Preserve shop/host/embedded params so we return to the embedded page
  const embedParams = new URLSearchParams(url.searchParams);
  embedParams.delete("returnTo");

  const returnTo =
    url.searchParams.get("returnTo") ||
    (embedParams.toString() ? `/app/integrations?${embedParams.toString()}` : "/app/integrations");

  const state = makeState(session.shop);

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [...GOOGLE_SCOPES],
    state: JSON.stringify({ state, returnTo }),
    include_granted_scopes: true,
  });

  return redirect(authUrl);
};

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
