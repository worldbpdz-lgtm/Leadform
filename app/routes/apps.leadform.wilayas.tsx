// app/routes/apps.leadform.wilayas.tsx
import type { LoaderFunctionArgs } from "react-router";
import prisma from "~/db.server";
import { verifyAppProxyRequest } from "~/lib/appProxy.server";

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
