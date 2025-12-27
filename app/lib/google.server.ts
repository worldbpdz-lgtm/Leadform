import { google } from "googleapis";
import crypto from "node:crypto";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
] as const;

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

/**
 * OAuth2 client for Google
 * Required env:
 * - GOOGLE_CLIENT_ID
 * - GOOGLE_CLIENT_SECRET
 * - SHOPIFY_APP_URL (used for redirect URL)
 */
export function getGoogleOAuthClient() {
  const clientId = mustEnv("GOOGLE_CLIENT_ID");
  const clientSecret = mustEnv("GOOGLE_CLIENT_SECRET");
  const appUrl = mustEnv("SHOPIFY_APP_URL");

  // Must match Google Console redirect URI
  const redirectUri = `${appUrl}/app/integrations/google/callback`;

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/**
 * State helpers (prevents CSRF).
 * We bind state to the shop domain + timestamp, and sign it using SHOPIFY_API_SECRET.
 */
function signState(payload: string) {
  const secret = process.env.SHOPIFY_API_SECRET || "";
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

export function makeState(shopDomain: string) {
  const ts = Date.now();
  const nonce = crypto.randomBytes(10).toString("base64url");
  const payload = `${shopDomain}:${ts}:${nonce}`;
  const sig = signState(payload);
  return `${payload}.${sig}`;
}

export function verifyState(state: string, expectedShopDomain: string) {
  if (!state || !state.includes(".")) return { ok: false as const, reason: "missing" };

  const lastDot = state.lastIndexOf(".");
  const payload = state.slice(0, lastDot);
  const sig = state.slice(lastDot + 1);

  const expectedSig = signState(payload);
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
    return { ok: false as const, reason: "bad_sig" };
  }

  const [shopDomain, tsStr] = payload.split(":");
  if (!shopDomain || shopDomain !== expectedShopDomain) {
    return { ok: false as const, reason: "shop_mismatch" };
  }

  const ts = Number(tsStr);
  if (!Number.isFinite(ts)) return { ok: false as const, reason: "bad_ts" };

  // 15 minutes validity
  if (Date.now() - ts > 15 * 60 * 1000) return { ok: false as const, reason: "expired" };

  return { ok: true as const };
}

/**
 * Simple encryption for storing OAuth tokens in DB.
 * Uses SHOPIFY_API_SECRET as key material (hashed to 32 bytes).
 */
function key32() {
  const secret = process.env.SHOPIFY_API_SECRET || "missing";
  return crypto.createHash("sha256").update(secret).digest(); // 32 bytes
}

export function encryptString(plaintext: string) {
  const iv = crypto.randomBytes(12);
  const key = key32();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${enc.toString("base64url")}`;
}

export function decryptString(packed: string) {
  const [ivB64, tagB64, dataB64] = packed.split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Bad encrypted payload");

  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const data = Buffer.from(dataB64, "base64url");

  const key = key32();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const out = Buffer.concat([decipher.update(data), decipher.final()]);
  return out.toString("utf8");
}
