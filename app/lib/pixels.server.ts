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
  // For now, we treat TikTok/Google as future server implementations.
  // UI will still store config + events; firing will log "not implemented".
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

function normPhone(phone?: string | null) {
  if (!phone) return null;
  const p = phone.replace(/\D+/g, "");
  if (!p) return null;
  return sha256Hex(p);
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
          content_ids:
            contents.length ? contents.map((c) => c.id) : ctx.request?.productId ? [ctx.request.productId] : undefined,
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

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function fireNotImplemented(ctx: FireContext) {
  await logPixelResult({
    shopId: ctx.shopId,
    platform: ctx.platform,
    event: ctx.event,
    status: "failed",
    error: "Server API not implemented for this platform yet",
    payload: { platform: ctx.platform },
    alsoUpdateLastFired: false,
  });
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
    } else {
      await fireNotImplemented(ctx);
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
