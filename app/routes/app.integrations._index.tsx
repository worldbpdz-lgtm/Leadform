import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "~/shopify.server";
import { prisma } from "~/db.server";

type LoaderData = {
  connected: boolean;
  tokenExpiresAt: string | null;
  spreadsheetId: string | null;
  spreadsheetUrl: string | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });

  if (!shop) {
    const data: LoaderData = { connected: false, tokenExpiresAt: null, spreadsheetId: null, spreadsheetUrl: null };
    return data;
  }

  const oauth = await prisma.oAuthGoogle.findUnique({
    where: { shopId: shop.id },
    select: { id: true, expiresAt: true },
  });

  const conn = await prisma.sheetsConnection.findFirst({
    where: { shopId: shop.id, active: true },
    select: { spreadsheetId: true, spreadsheetUrl: true },
  });

  const data: LoaderData = {
    connected: Boolean(oauth),
    tokenExpiresAt: oauth?.expiresAt ? oauth.expiresAt.toISOString() : null,
    spreadsheetId: conn?.spreadsheetId ?? null,
    spreadsheetUrl:
      conn?.spreadsheetUrl ??
      (conn?.spreadsheetId ? `https://docs.google.com/spreadsheets/d/${conn.spreadsheetId}` : null),
  };

  return data;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const fd = await request.formData();
  const intent = String(fd.get("intent") || "");

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });
  if (!shop) return { ok: false };

  if (intent === "disconnectGoogle") {
    await prisma.sheetsConnection.updateMany({
      where: { shopId: shop.id },
      data: { active: false },
    });

    await prisma.oAuthGoogle.deleteMany({ where: { shopId: shop.id } });

    return { ok: true };
  }

  return { ok: false };
};
