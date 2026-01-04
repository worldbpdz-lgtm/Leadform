// app/routes/app.pixels.tsx
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "~/shopify.server";
import { prisma } from "~/db.server";

import type { PixelPlatform } from "@prisma/client";
import {
  PIXEL_EVENTS,
  deleteTrackingPixel,
  firePixelsForRequest,
  upsertTrackingPixel,
} from "~/lib/pixels.server";

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(init.headers || {}),
    },
  });
}

export const headers: HeadersFunction = boundary.headers;

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const shop = await prisma.shop.upsert({
    where: { shopDomain },
    create: { shopDomain },
    update: {},
    select: { id: true },
  });

  const pixels = await prisma.trackingPixel.findMany({
    where: { shopId: shop.id },
    orderBy: { platform: "asc" },
  });

  const logs = await prisma.pixelEventLog.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return json({ shopId: shop.id, pixels, logs, events: PIXEL_EVENTS });
}

function asPlatform(v: FormDataEntryValue | null): PixelPlatform {
  const s = String(v || "");
  if (s === "facebook" || s === "tiktok" || s === "google") return s;
  throw new Error("Invalid platform");
}

function parseBool(v: FormDataEntryValue | null) {
  return v === "on" || v === "true" || v === "1";
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const shop = await prisma.shop.upsert({
    where: { shopDomain },
    create: { shopDomain },
    update: {},
    select: { id: true },
  });

  const fd = await request.formData();
  const intent = String(fd.get("intent") || "");

  try {
    if (intent === "save") {
      const platform = asPlatform(fd.get("platform"));
      const pixelId = String(fd.get("pixelId") || "").trim();
      if (!pixelId)
        return json({ ok: false, error: "Pixel ID is required." }, { status: 400 });

      const enabled = parseBool(fd.get("enabled"));
      const apiEnabled = parseBool(fd.get("apiEnabled"));
      const accessToken = String(fd.get("accessToken") || "").trim();
      const testCode = String(fd.get("testCode") || "").trim();

      const events: Record<string, boolean> = {};
      for (const ev of PIXEL_EVENTS) {
        events[ev] = parseBool(fd.get(`ev_${ev}`));
      }

      await upsertTrackingPixel({
        shopId: shop.id,
        platform,
        pixelId,
        enabled,
        apiEnabled,
        accessTokenPlain: accessToken || null,
        testCode: testCode || null,
        events,
      });

      return json({ ok: true });
    }

    if (intent === "delete") {
      const platform = asPlatform(fd.get("platform"));
      await deleteTrackingPixel({ shopId: shop.id, platform });
      return json({ ok: true });
    }

    if (intent === "test") {
      // This fires against all enabled pixels (based on your DB).
      await firePixelsForRequest({
        shopId: shop.id,
        event: "request_submitted",
        force: true,
        test: true,
        request: {
          id: `test_${Date.now()}`,
          email: "test@example.com",
          phone: "0550000000",
          ip: "127.0.0.1",
          userAgent: "LeadForm-Test",
          pageUrl: "https://example.com/products/test",
          referrer: "https://example.com/",
          productId: "test_product",
          qty: 1,
          createdAt: new Date(),
          items: [{ productId: "test_product", qty: 1 }],
          currency: "DZD",
          value: 0,
        },
      });

      return json({ ok: true });
    }

    return json({ ok: false, error: "Unknown intent" }, { status: 400 });
  } catch (e: any) {
    return json({ ok: false, error: e?.message ?? "Action failed" }, { status: 500 });
  }
}

function PlatformMeta(pl: PixelPlatform) {
  if (pl === "facebook") {
    return { title: "Meta (Facebook/Instagram)", hint: "Server-side supported (CAPI)." };
  }
  if (pl === "tiktok") {
    return { title: "TikTok Pixel", hint: "Config + logs ready; server API wiring later." };
  }
  return { title: "Google (Gtag/GA4)", hint: "Config + logs ready; server API wiring later." };
}

export default function PixelsRoute() {
  const data = useLoaderData() as any;
  const actionData = useActionData() as any;

  const byPlatform = new Map<string, any>();
  for (const p of (data.pixels as any[])) byPlatform.set(p.platform, p);

  const platforms: PixelPlatform[] = ["facebook", "tiktok", "google"];

  return (
    <div className="lf-admin lf-pixels">
      <div className="lf-card lf-pixels__header">
        <div className="lf-card__title">Pixels</div>
        <div className="lf-muted">
          Configure platform IDs, select which events fire, and use “Test event” to verify.
        </div>
        {actionData?.error ? (
          <div className="lf-alert lf-alert--danger" style={{ marginTop: 10 }}>
            {actionData.error}
          </div>
        ) : null}
      </div>

      <div className="lf-pixels__grid">
        {platforms.map((pl) => {
          const meta = PlatformMeta(pl);
          const p = byPlatform.get(pl);
          const ev = (p?.events ?? {}) as Record<string, boolean>;

          return (
            <div className="lf-card lf-pixel-card" key={pl}>
              <div className="lf-pixel-card__top">
                <div>
                  <div className="lf-card__title">{meta.title}</div>
                  <div className="lf-muted">{meta.hint}</div>
                </div>

                <div className="lf-pixel-card__topActions">
                  <Form method="post">
                    <input type="hidden" name="intent" value="delete" />
                    <input type="hidden" name="platform" value={pl} />
                    <button className="lf-btn lf-btn--ghost" type="submit" disabled={!p}>
                      Remove
                    </button>
                  </Form>
                </div>
              </div>

              <Form method="post" className="lf-pixel-form">
                <input type="hidden" name="intent" value="save" />
                <input type="hidden" name="platform" value={pl} />

                <div className="lf-pixel-form__cols">
                  <div className="lf-pixel-form__left">
                    <label className="lf-field">
                      <div className="lf-label">Pixel ID</div>
                      <input
                        className="lf-input"
                        name="pixelId"
                        defaultValue={p?.pixelId ?? ""}
                        placeholder={pl === "facebook" ? "1234567890" : "Pixel / Measurement ID"}
                      />
                    </label>

                    <div className="lf-pixel-form__checks">
                      <label className="lf-check">
                        <input type="checkbox" name="enabled" defaultChecked={p?.enabled ?? true} />
                        <span>Enabled</span>
                      </label>

                      <label className="lf-check">
                        <input type="checkbox" name="apiEnabled" defaultChecked={p?.apiEnabled ?? false} />
                        <span>Server API enabled</span>
                      </label>
                    </div>

                    <label className="lf-field">
                      <div className="lf-label">Access token / API secret (optional)</div>
                      <input
                        className="lf-input"
                        name="accessToken"
                        placeholder="Leave empty to keep current token"
                        autoComplete="off"
                      />
                      <div className="lf-muted">
                        Stored encrypted. Only required for server-side events.
                      </div>
                    </label>

                    <label className="lf-field">
                      <div className="lf-label">Test code (optional)</div>
                      <input className="lf-input" name="testCode" defaultValue={p?.testCode ?? ""} />
                    </label>
                  </div>

                  <div className="lf-pixel-form__right">
                    <div className="lf-label">Events</div>
                    <div className="lf-pixel-events">
                      {data.events.map((e: string) => (
                        <label className="lf-check lf-pixel-events__item" key={e}>
                          <input type="checkbox" name={`ev_${e}`} defaultChecked={!!ev[e]} />
                          <span>{e}</span>
                        </label>
                      ))}
                    </div>

                    <div className="lf-pixel-actions">
                      <button className="lf-btn" type="submit">
                        Save
                      </button>

                      {/* NOT nested in the Save <Form> (fixes invalid HTML) */}
                      <Form method="post">
                        <input type="hidden" name="intent" value="test" />
                        <input type="hidden" name="platform" value={pl} />
                        <button className="lf-btn lf-btn--secondary" type="submit">
                          Test event
                        </button>
                      </Form>

                      <div className="lf-muted lf-pixel-actions__right">
                        Last fired:{" "}
                        {p?.lastFiredAt ? new Date(p.lastFiredAt).toLocaleString() : "—"}
                      </div>
                    </div>

                    <div className="lf-muted" style={{ marginTop: 8 }}>
                      Tip: enable “Server API enabled” and set the token for Meta CAPI to get
                      success logs. TikTok/Google server wiring can be added later.
                    </div>
                  </div>
                </div>
              </Form>
            </div>
          );
        })}
      </div>

      <div className="lf-card lf-pixels__logs">
        <div className="lf-card__title">Pixel Event Logs</div>
        <div className="lf-muted">Last 50 attempts.</div>

        <div style={{ overflowX: "auto", marginTop: 10 }}>
          <table className="lf-table">
            <thead>
              <tr>
                <th style={{ whiteSpace: "nowrap" }}>Time</th>
                <th>Platform</th>
                <th>Event</th>
                <th>Status</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {(data.logs as any[]).map((l) => (
                <tr key={l.id}>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {new Date(l.createdAt).toLocaleString()}
                  </td>
                  <td>{l.platform}</td>
                  <td>{l.event}</td>
                  <td>{l.status}</td>
                  <td className="lf-muted">{l.error ?? "—"}</td>
                </tr>
              ))}
              {!data.logs?.length ? (
                <tr>
                  <td colSpan={5} className="lf-muted">
                    No logs yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
