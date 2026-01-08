  import { createHmac, timingSafeEqual } from "node:crypto";

  type VerifyOk = { ok: true; shop: string };
  type VerifyFail = { ok: false; reason: string };
  export type VerifyResult = VerifyOk | VerifyFail;

  /**
   * Shopify App Proxy verification.
   *
   * - If `signature` is present: join sorted `k=v` pairs with "" (no '&').
   * - If `hmac` is present: join sorted `k=v` pairs with "&".
   *
   * Supports repeated params via URLSearchParams.getAll() and joins values with "," (Shopify style).
   */
  export function verifyAppProxyRequest(url: URL): VerifyResult {
    const secret = process.env.SHOPIFY_API_SECRET;
    if (!secret) return { ok: false, reason: "Missing SHOPIFY_API_SECRET" };

    const shop = url.searchParams.get("shop");
    const signature = url.searchParams.get("signature");
    const hmac = url.searchParams.get("hmac");

    if (!shop) return { ok: false, reason: "Missing shop" };
    if (!signature && !hmac) return { ok: false, reason: "Missing signature/hmac" };

    const exclude = new Set(["signature", "hmac"]);

    const keys = Array.from(new Set(Array.from(url.searchParams.keys())))
      .filter((k) => !exclude.has(k))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    const pairs = keys.map((k) => {
      const all = url.searchParams.getAll(k).map((v) => String(v));
      return `${k}=${all.join(",")}`;
    });

    const message = signature ? pairs.join("") : pairs.join("&");
    const digest = createHmac("sha256", secret).update(message).digest("hex");

    const provided = (signature || hmac || "").toLowerCase();
    const computed = digest.toLowerCase();

    if (provided.length !== computed.length) {
      return { ok: false, reason: signature ? "Bad signature" : "Bad hmac" };
    }

    const ok = timingSafeEqual(Buffer.from(computed, "utf8"), Buffer.from(provided, "utf8"));
    return ok ? { ok: true, shop } : { ok: false, reason: signature ? "Bad signature" : "Bad hmac" };
  }
