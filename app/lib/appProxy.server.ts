import { createHmac, timingSafeEqual } from "node:crypto";
import { parse as parseQuery } from "node:querystring";

type VerifyOk = { ok: true; shop: string };
type VerifyFail = { ok: false; reason: string };
export type VerifyResult = VerifyOk | VerifyFail;

export function verifyAppProxyRequest(url: URL): VerifyResult {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) return { ok: false, reason: "Missing SHOPIFY_API_SECRET" };

  // App Proxy uses `signature` (hex). Some installs might include `hmac`, but `signature` is the expected param.
  const provided = url.searchParams.get("signature") || url.searchParams.get("hmac");
  const shop = url.searchParams.get("shop");
  if (!provided || !shop) return { ok: false, reason: "Missing shop/signature" };

  // Parse supports repeated params -> arrays
  const queryHash = parseQuery(url.search.slice(1));

  // Remove signature/hmac before signing
  delete (queryHash as any).signature;
  delete (queryHash as any).hmac;

  // Build sorted params exactly like Shopify docs:
  // "#{k}=#{Array(v).join(',')}" then sort then join with NO separator
  const sortedParams = Object.keys(queryHash)
    .map((k) => {
      const v = (queryHash as any)[k];
      const arr = Array.isArray(v) ? v : [v];
      return `${k}=${arr.join(",")}`;
    })
    .sort()
    .join("");

  const digest = createHmac("sha256", secret).update(sortedParams).digest("hex");

  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(provided, "utf8");
  const ok = a.length === b.length && timingSafeEqual(a, b);

  return ok ? { ok: true, shop } : { ok: false, reason: "Bad signature" };
}
