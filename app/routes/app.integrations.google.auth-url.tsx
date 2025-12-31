import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { GOOGLE_SCOPES, getGoogleOAuthClient, makeState } from "~/lib/google.server";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") || "/app/integrations";

  const client = getGoogleOAuthClient();
  const state = makeState(session.shop);

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [...GOOGLE_SCOPES],
    state: JSON.stringify({ state, returnTo }),
    include_granted_scopes: true,
  });

  return json({ ok: true, authUrl });
};
