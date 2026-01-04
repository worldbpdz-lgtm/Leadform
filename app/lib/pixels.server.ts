// app/lib/pixels.server.ts
import crypto from "node:crypto";
import { prisma } from "~/db.server";
import { decryptString, encryptString } from "~/lib/google.server";
import type { PixelPlatform, TrackingPixel, Request } from "@prisma/client";

export const PIXEL_EVENTS = [
  "form_opened",
  "role_selected",
  "request_submitted",
  "request_confirmed",
] as const;

export type PixelEventName = (typeof PIXEL_EVENTS)[number];

type PixelEventsJson = Record<string, boolean> & {
  // optional override per platform event name mapping
  // e.g. { request_submitted: true, map: { request_submitted: "Lead" } }
  map?: Record<string, string>;
};

function asBool(v: unknown) {
  return v === true;
}

function getEnabledEvents(events: unknown): PixelEventsJson {
  if (!events || typeof events !== "object") return {};
  return events as PixelEventsJson;
}

function isEnabled(pixel: TrackingPixel, ev: PixelEventName) {
  const events = getEnabledEvents(pixel.events);
  return asBool(events[ev]);
}

function mapEventName(pixel: TrackingPixel, ev: PixelEventName) {
  const events = getEnabledEvents(pixel.events);
  return events.map?.[ev] ?? defaultPlatformEventName(pixel.platform, ev);
}

function defaultPlatformEventName(platform: PixelPlatform, ev: PixelEventName) {
  // keep sane defaults; can be overridden in events.map
  if (platform === "facebook") {
    if (ev === "request_submitted") return "Lead";
    if (ev === "form_opened") return "ViewContent";
    if (ev === "role_selected") return "InitiateCheckout";
    if (ev === "request_confirmed") return "Purchase";
    return "LeadFormEvent";
  }

  if (platform === "tiktok") {
    // TikTok standard-ish defaults (override in events.map if needed)
    if (ev === "form_opened") return "ViewContent";
    if (ev === "role_selected") return "InitiateCheckout";
    if (ev === "request_submitted") return "SubmitForm";
    if (ev === "request_confirmed") return "CompletePayment";
    return "CustomEvent";
  }

  // GA4 Measurement Protocol event names should be lowercase/underscore.
  if (platform === "google") {
    if (ev === "form_opened") return "page_view";
    if (ev === "role_selected") return "begin_checkout";
    if (ev === "request_submitted") return "generate_lead";
    if (ev === "request_confirmed") return "purchase";
    return "leadform_event";
  }

  return ev;
}

function sha256Hex(s: string) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function normEmail(email?: string | null) {
  if (!email) return null;
  const e = email.trim().toLowerCase();
  if (!e) return null;
  return sha256Hex(e);
}

function toE164OrDigits(phone?: string | null) {
  if (!phone) return null;
  const raw = phone.trim();
  if (!raw) return null;

  // If already looks like +E164, keep digits with leading +
  if (raw.startsWith("+")) {
    const digits = raw.replace(/[^\d+]/g, "");
    return digits.length > 1 ? digits : null;
  }

  // Digits-only fallback
  const digits = raw.replace(/\D+/g, "");
  if (!digits) return null;

  // Heuristic for Algeria local numbers like 0XXXXXXXXX (10 digits)
  if (digits.length === 10 && digits.startsWith("0")) {
    return `+213${digits.slice(1)}`;
  }

  return digits;
}

function normPhone(phone?: string | null) {
  const p = toE164OrDigits(phone);
  if (!p) return null;
  return sha256Hex(p);
}

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sanitizeGa4EventName(name: string) {
  const s = String(name || "").trim().toLowerCase();
  const cleaned = s
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return cleaned || "leadform_event";
}

function gaClientIdFromRequest(req?: FireContext["request"]) {
  // GA4 expects client_id. We don't have _ga cookie server-side here,
  // so we derive a stable-ish numeric client_id from request fields.
  const seed =
    (req?.ip ?? "") +
    "|" +
    (req?.userAgent ?? "") +
    "|" +
    (req?.email ?? "") +
    "|" +
    (req?.phone ?? "") +
    "|" +
    (req?.id ?? crypto.randomUUID());

  const h = sha256Hex(seed); // hex string
  // Create two numeric parts (<= 10 digits each)
  const a = BigInt("0x" + h.slice(0, 16)) % 10000000000n;
  const b = BigInt("0x" + h.slice(16, 32)) % 10000000000n;
  return `${a.toString()}.${b.toString()}`;
}

type FireContext = {
  shopId: string;
  platform: PixelPlatform;
  pixel: TrackingPixel;
  event: PixelEventName;
  request?: Pick<
    Request,
    | "id"
    | "email"
    | "phone"
    | "ip"
    | "userAgent"
    | "pageUrl"
    | "referrer"
    | "productId"
    | "qty"
    | "createdAt"
  > & {
    items?: Array<{ productId: string; qty: number }>;
    value?: number | null;
    currency?: string | null;
  };
  test?: boolean;
};

async function logPixelResult(args: {
  shopId: string;
  platform: PixelPlatform;
  event: string;
  status: "success" | "failed";
  payload?: any;
  error?: string | null;
  alsoUpdateLastFired?: boolean;
}) {
  await prisma.pixelEventLog.create({
    data: {
      shopId: args.shopId,
      platform: args.platform,
      event: args.event,
      status: args.status === "success" ? "success" : "failed",
      payload: args.payload ?? undefined,
      error: args.error ?? undefined,
    },
  });

  if (args.alsoUpdateLastFired) {
    await prisma.trackingPixel.update({
      where: { shopId_platform: { shopId: args.shopId, platform: args.platform } },
      data: { lastFiredAt: new Date() },
    });
  }
}

/**
 * Facebook Conversion API (Meta)
 * Requires:
 * - pixel.apiEnabled = true
 * - pixel.accessTokenEnc set (we decrypt)
 * Optional:
 * - pixel.testCode set (Meta test events)
 */
async function fireFacebookCapi(ctx: FireContext) {
  const accessToken =
    ctx.pixel.accessTokenEnc ? decryptString(ctx.pixel.accessTokenEnc) : null;

  if (!ctx.pixel.apiEnabled) {
    await logPixelResult({
      shopId: ctx.shopId,
      platform: ctx.platform,
      event: ctx.event,
      status: "failed",
      error: "API disabled",
      payload: { reason: "apiEnabled=false" },
      alsoUpdateLastFired: false,
    });
    return;
  }

  if (!accessToken) {
    await logPixelResult({
      shopId: ctx.shopId,
      platform: ctx.platform,
      event: ctx.event,
      status: "failed",
      error: "Missing access token",
      payload: { reason: "accessTokenEnc missing" },
      alsoUpdateLastFired: false,
    });
    return;
  }

  const event_name = mapEventName(ctx.pixel, ctx.event);
  const nowSec = Math.floor(Date.now() / 1000);

  const em = normEmail(ctx.request?.email);
  const ph = normPhone(ctx.request?.phone);

  const contents =
    ctx.request?.items?.map((it) => ({
      id: it.productId,
      quantity: it.qty,
    })) ?? [];

  const payload = {
    data: [
      {
        event_name,
        event_time: nowSec,
        action_source: "website",
        event_source_url: ctx.request?.pageUrl ?? undefined,
        event_id: ctx.request?.id ?? crypto.randomUUID(),
        user_data: {
          client_ip_address: ctx.request?.ip ?? undefined,
          client_user_agent: ctx.request?.userAgent ?? undefined,
          em: em ? [em] : undefined,
          ph: ph ? [ph] : undefined,
        },
        custom_data: {
          currency: ctx.request?.currency ?? "DZD",
          value: ctx.request?.value ?? 0,
          contents: contents.length ? contents : undefined,
          content_ids: contents.length
            ? contents.map((c) => c.id)
            : ctx.request?.productId
            ? [ctx.request.productId]
            : undefined,
          content_type: "product",
        },
        test_event_code: ctx.test ? (ctx.pixel.testCode ?? undefined) : undefined,
      },
    ],
  };

  const url = `https://graph.facebook.com/v19.0/${ctx.pixel.pixelId}/events?access_token=${encodeURIComponent(
    accessToken
  )}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    const ok = res.ok;

    await logPixelResult({
      shopId: ctx.shopId,
      platform: ctx.platform,
      event: ctx.event,
      status: ok ? "success" : "failed",
      payload: { request: payload, response: safeJson(text) },
      error: ok ? null : `Meta API error: ${res.status}`,
      alsoUpdateLastFired: ok,
    });
  } catch (e: any) {
    await logPixelResult({
      shopId: ctx.shopId,
      platform: ctx.platform,
      event: ctx.event,
      status: "failed",
      payload,
      error: e?.message ?? "Meta API exception",
      alsoUpdateLastFired: false,
    });
  }
}

/**
 * TikTok Events API (server-side)
 * Uses TikTok Business API v1.3 pixel tracking endpoint.
 * Requires:
 * - pixel.apiEnabled = true
 * - accessTokenEnc (Events API Access Token) set
 * Optional:
 * - testCode set (TikTok test events code)
 */
async function fireTikTokEventsApi(ctx: FireContext) {
  const accessToken =
    ctx.pixel.accessTokenEnc ? decryptString(ctx.pixel.accessTokenEnc) : null;

  if (!ctx.pixel.apiEnabled) {
    await logPixelResult({
      shopId: ctx.shopId,
      platform: ctx.platform,
      event: ctx.event,
      status: "failed",
      error: "API disabled",
      payload: { reason: "apiEnabled=false" },
      alsoUpdateLastFired: false,
    });
    return;
  }

  if (!accessToken) {
    await logPixelResult({
      shopId: ctx.shopId,
      platform: ctx.platform,
      event: ctx.event,
      status: "failed",
      error: "Missing access token",
      payload: { reason: "accessTokenEnc missing" },
      alsoUpdateLastFired: false,
    });
    return;
  }

  const event = mapEventName(ctx.pixel, ctx.event);

  const event_time = Math.floor(
    (ctx.request?.createdAt ? new Date(ctx.request.createdAt).getTime() : Date.now()) /
      1000
  );

  const emailHashed = normEmail(ctx.request?.email);
  const phoneHashed = normPhone(ctx.request?.phone);

  const items = ctx.request?.items?.length
    ? ctx.request.items
    : ctx.request?.productId
    ? [{ productId: ctx.request.productId, qty: ctx.request.qty ?? 1 }]
    : [];

  const contents = items.map((it) => ({
    content_id: it.productId,
    quantity: it.qty,
  }));

  const payload: any = {
    pixel_code: ctx.pixel.pixelId,
    event,
    event_id: ctx.request?.id ?? crypto.randomUUID(),
    timestamp: event_time,
    context: {
      ip: ctx.request?.ip ?? undefined,
      user_agent: ctx.request?.userAgent ?? undefined,
      page: {
        url: ctx.request?.pageUrl ?? undefined,
        referrer: ctx.request?.referrer ?? undefined,
      },
      user: {
        email: emailHashed ?? undefined,
        phone_number: phoneHashed ?? undefined,
      },
    },
    properties: {
      currency: ctx.request?.currency ?? "DZD",
      value: ctx.request?.value ?? 0,
      contents: contents.length ? contents : undefined,
      content_type: "product",
    },
  };

  if (ctx.test && ctx.pixel.testCode) {
    // Many integrations use `test_event_code` at top-level for TikTok test events.
    payload.test_event_code = ctx.pixel.testCode;
  }

  // Endpoint used widely for server-side pixel events
  const url = "https://business-api.tiktok.com/open_api/v1.3/pixel/track/";

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Access-Token": accessToken,
      },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    const ok = res.ok;

    await logPixelResult({
      shopId: ctx.shopId,
      platform: ctx.platform,
      event: ctx.event,
      status: ok ? "success" : "failed",
      payload: { request: payload, response: safeJson(text) },
      error: ok ? null : `TikTok API error: ${res.status}`,
      alsoUpdateLastFired: ok,
    });
  } catch (e: any) {
    await logPixelResult({
      shopId: ctx.shopId,
      platform: ctx.platform,
      event: ctx.event,
      status: "failed",
      payload,
      error: e?.message ?? "TikTok API exception",
      alsoUpdateLastFired: false,
    });
  }
}

/**
 * Google Analytics 4 Measurement Protocol (server-side)
 * Uses:
 * - pixel.pixelId as measurement_id (e.g., G-XXXXXXX)
 * - accessTokenEnc as GA4 api_secret
 * Requires:
 * - pixel.apiEnabled = true
 * - api_secret set
 */
async function fireGoogleGa4MeasurementProtocol(ctx: FireContext) {
  const apiSecret =
    ctx.pixel.accessTokenEnc ? decryptString(ctx.pixel.accessTokenEnc) : null;

  if (!ctx.pixel.apiEnabled) {
    await logPixelResult({
      shopId: ctx.shopId,
      platform: ctx.platform,
      event: ctx.event,
      status: "failed",
      error: "API disabled",
      payload: { reason: "apiEnabled=false" },
      alsoUpdateLastFired: false,
    });
    return;
  }

  const measurementId = String(ctx.pixel.pixelId || "").trim();
  if (!measurementId) {
    await logPixelResult({
      shopId: ctx.shopId,
      platform: ctx.platform,
      event: ctx.event,
      status: "failed",
      error: "Missing measurement ID",
      payload: { reason: "pixelId missing" },
      alsoUpdateLastFired: false,
    });
    return;
  }

  if (!apiSecret) {
    await logPixelResult({
      shopId: ctx.shopId,
      platform: ctx.platform,
      event: ctx.event,
      status: "failed",
      error: "Missing API secret",
      payload: { reason: "accessTokenEnc missing (api_secret)" },
      alsoUpdateLastFired: false,
    });
    return;
  }

  // Basic validation: GA4 measurement IDs are typically "G-XXXX"
  // If user pastes Google Ads AW-... this will not work here.
  if (!measurementId.startsWith("G-")) {
    await logPixelResult({
      shopId: ctx.shopId,
      platform: ctx.platform,
      event: ctx.event,
      status: "failed",
      error: "Unsupported Google ID (expected GA4 Measurement ID starting with G-)",
      payload: { measurementId },
      alsoUpdateLastFired: false,
    });
    return;
  }

  const name = sanitizeGa4EventName(mapEventName(ctx.pixel, ctx.event));
  const currency = ctx.request?.currency ?? "DZD";
  const value = ctx.request?.value ?? 0;

  const items = ctx.request?.items?.length
    ? ctx.request.items
    : ctx.request?.productId
    ? [{ productId: ctx.request.productId, qty: ctx.request.qty ?? 1 }]
    : [];

  const gaItems = items.map((it) => ({
    item_id: it.productId,
    quantity: it.qty,
  }));

  const params: Record<string, any> = {
    currency,
    value,
    engagement_time_msec: 1,
  };

  if (gaItems.length) params.items = gaItems;

  // For purchase-like events, add transaction_id when we have it.
  if (name === "purchase" && ctx.request?.id) {
    params.transaction_id = ctx.request.id;
  }

  // Optional debug mode for tests
  if (ctx.test) params.debug_mode = 1;

  const payload = {
    client_id: gaClientIdFromRequest(ctx.request),
    timestamp_micros: String(
      BigInt(
        ctx.request?.createdAt
          ? new Date(ctx.request.createdAt).getTime()
          : Date.now()
      ) * 1000n
    ),
    events: [{ name, params }],
  };

  const url = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(
    measurementId
  )}&api_secret=${encodeURIComponent(apiSecret)}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    const ok = res.ok;

    await logPixelResult({
      shopId: ctx.shopId,
      platform: ctx.platform,
      event: ctx.event,
      status: ok ? "success" : "failed",
      payload: { request: payload, response: safeJson(text) },
      error: ok ? null : `GA4 MP error: ${res.status}`,
      alsoUpdateLastFired: ok,
    });
  } catch (e: any) {
    await logPixelResult({
      shopId: ctx.shopId,
      platform: ctx.platform,
      event: ctx.event,
      status: "failed",
      payload,
      error: e?.message ?? "GA4 MP exception",
      alsoUpdateLastFired: false,
    });
  }
}

export async function firePixelsForRequest(args: {
  shopId: string;
  event: PixelEventName;
  request: FireContext["request"];
  force?: boolean; // for tests: bypass events toggles
  test?: boolean;
}) {
  const pixels = await prisma.trackingPixel.findMany({
    where: { shopId: args.shopId, enabled: true },
  });

  for (const pixel of pixels) {
    const shouldFire = args.force ? true : isEnabled(pixel, args.event);
    if (!shouldFire) continue;

    const ctx: FireContext = {
      shopId: args.shopId,
      platform: pixel.platform,
      pixel,
      event: args.event,
      request: args.request,
      test: args.test,
    };

    if (pixel.platform === "facebook") {
      await fireFacebookCapi(ctx);
    } else if (pixel.platform === "tiktok") {
      await fireTikTokEventsApi(ctx);
    } else if (pixel.platform === "google") {
      await fireGoogleGa4MeasurementProtocol(ctx);
    } else {
      await logPixelResult({
        shopId: ctx.shopId,
        platform: ctx.platform,
        event: ctx.event,
        status: "failed",
        error: "Unsupported platform",
        payload: { platform: ctx.platform },
        alsoUpdateLastFired: false,
      });
    }
  }
}

export async function upsertTrackingPixel(args: {
  shopId: string;
  platform: PixelPlatform;
  pixelId: string;
  enabled: boolean;
  apiEnabled: boolean;
  accessTokenPlain?: string | null; // will be encrypted
  testCode?: string | null;
  events: Record<string, boolean>;
}) {
  const existing = await prisma.trackingPixel.findUnique({
    where: { shopId_platform: { shopId: args.shopId, platform: args.platform } },
  });

  const accessTokenEnc =
    args.accessTokenPlain && args.accessTokenPlain.trim()
      ? encryptString(args.accessTokenPlain.trim())
      : existing?.accessTokenEnc ?? null;

  return prisma.trackingPixel.upsert({
    where: { shopId_platform: { shopId: args.shopId, platform: args.platform } },
    create: {
      shopId: args.shopId,
      platform: args.platform,
      pixelId: args.pixelId.trim(),
      enabled: args.enabled,
      apiEnabled: args.apiEnabled,
      accessTokenEnc,
      testCode: args.testCode?.trim() || null,
      events: args.events,
    },
    update: {
      pixelId: args.pixelId.trim(),
      enabled: args.enabled,
      apiEnabled: args.apiEnabled,
      accessTokenEnc,
      testCode: args.testCode?.trim() || null,
      events: args.events,
    },
  });
}

export async function deleteTrackingPixel(args: {
  shopId: string;
  platform: PixelPlatform;
}) {
  await prisma.trackingPixel.delete({
    where: { shopId_platform: { shopId: args.shopId, platform: args.platform } },
  });
}
