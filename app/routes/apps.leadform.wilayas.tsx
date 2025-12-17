import type { LoaderFunctionArgs } from "react-router";
import prisma from "~/db.server";

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

async function verifyAppProxyRequest(url: URL): Promise<VerifyResult> {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) return { ok: false, reason: "Missing SHOPIFY_API_SECRET" };

  const providedHmac =
    url.searchParams.get("hmac") || url.searchParams.get("signature");
  const shop = url.searchParams.get("shop");

  if (!providedHmac || !shop) {
    return { ok: false, reason: "Missing shop or hmac" };
  }

  // Shopify App Proxy rule:
  // - take original query string
  // - remove hmac/signature
  // - DO NOT re-encode values
  const query = url.search.slice(1);
  const message = query
    .split("&")
    .filter(
      (part) =>
        !part.startsWith("hmac=") &&
        !part.startsWith("signature=")
    )
    .sort()
    .join("&");

  const { createHmac, timingSafeEqual } = await import("node:crypto");
  const digest = createHmac("sha256", secret)
    .update(message)
    .digest("hex");

  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(providedHmac, "utf8");

  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "Bad signature" };
  }

  return { ok: true, shop };
}


export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const verified = await verifyAppProxyRequest(url);
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
