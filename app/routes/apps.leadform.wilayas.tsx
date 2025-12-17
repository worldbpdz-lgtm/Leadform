// app/routes/apps.leadform.wilayas.tsx
import type { LoaderFunctionArgs } from "react-router";
import prisma from "~/db.server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { parse as parseQuery } from "node:querystring";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

type VerifyOk = { ok: true; shop: string };
type VerifyFail = { ok: false; reason: string };
type VerifyResult = VerifyOk | VerifyFail;

function verifyAppProxyRequest(url: URL): VerifyResult {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) return { ok: false, reason: "Missing SHOPIFY_API_SECRET" };

  const provided = url.searchParams.get("signature") || url.searchParams.get("hmac");
  const shop = url.searchParams.get("shop");

  if (!provided || !shop) return { ok: false, reason: "Missing shop/signature" };

  const queryHash = parseQuery(url.search.slice(1)) as Record<string, any>;
  delete queryHash.signature;
  delete queryHash.hmac;

  const message = Object.keys(queryHash)
    .map((k) => {
      const v = queryHash[k];
      const arr = Array.isArray(v) ? v : [v];
      return `${k}=${arr.join(",")}`;
    })
    .sort()
    .join("");

  const digest = createHmac("sha256", secret).update(message).digest("hex");

  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(provided, "utf8");
  const ok = a.length === b.length && timingSafeEqual(a, b);

  return ok ? { ok: true, shop } : { ok: false, reason: "Bad signature" };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  const verified = verifyAppProxyRequest(url);
  if (!verified.ok) return json({ ok: false, error: verified.reason }, 401);

  // Ensure Shop exists (optional, but keeps tenancy consistent)
  const shopDomain: string = verified.shop;
  await prisma.shop.upsert({
    where: { shopDomain },
    update: { uninstalledAt: null },
    create: { shopDomain, installedAt: new Date() },
    select: { id: true },
  });

  const wilayas = await prisma.geoWilaya.findMany({
    orderBy: { code: "asc" },
    select: { code: true, nameFr: true, nameAr: true },
  });

  return json({ ok: true, wilayas });
};
