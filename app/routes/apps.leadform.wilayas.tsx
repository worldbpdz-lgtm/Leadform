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
  const secret = process.env.SHOPIFY_API_SECRET || "";
  if (!secret) return { ok: false, reason: "Missing SHOPIFY_API_SECRET" };

  const shop = url.searchParams.get("shop");
  const sig = url.searchParams.get("signature");
  const hmac = url.searchParams.get("hmac");
  const provided = sig || hmac;

  if (!shop || !provided) return { ok: false, reason: "Missing shop/signature" };

  const pairs: string[] = [];
  url.searchParams.forEach((value, key) => {
    if (key === "signature" || key === "hmac") return;
    pairs.push(`${key}=${value}`);
  });
  pairs.sort();
  const message = pairs.join("&");

  const { createHmac, timingSafeEqual } = await import("node:crypto");
  const digest = createHmac("sha256", secret).update(message).digest("hex");

  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(provided, "utf8");
  const ok = a.length === b.length && timingSafeEqual(a, b);

  return ok ? { ok: true, shop } : { ok: false, reason: "Bad signature" };
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
