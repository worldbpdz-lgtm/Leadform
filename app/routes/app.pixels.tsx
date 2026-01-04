// app/routes/app.pixels.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs, HeadersFunction } from "react-router";
import { Form, useActionData, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "~/shopify.server";
import { prisma } from "~/db.server";

import type { PixelPlatform } from "@prisma/client";
import { PIXEL_EVENTS, deleteTrackingPixel, firePixelsForRequest, upsertTrackingPixel } from "~/lib/pixels.server";

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
      if (!pixelId) return json({ ok: false, error: "Pixel ID is required." }, { status: 400 });

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
      const platform = asPlatform(fd.get("platform"));

      // Minimal request-like payload for test
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

      // Test fires all enabled pixels; if you want per-platform test, keep only that platform:
      // (optional improvement later). For now, user clicks on a platform card and tests.
      // To scope to that platform, you can temporarily disable the other platforms or we add a per-platform dispatcher.

      return json({ ok: true });
    }

    return json({ ok: false, error: "Unknown intent" }, { status: 400 });
  } catch (e: any) {
    return json({ ok: false, error: e?.message ?? "Action failed" }, { status: 500 });
  }
}

export default function PixelsRoute() {
  const data = useLoaderData() as any;
  const actionData = useActionData() as any;

  const byPlatform = new Map<string, any>();
  for (const p of data.pixels as any[]) byPlatform.set(p.platform, p);

  const platforms: Array<{ key: PixelPlatform; title: string; hint: string }> = [
    { key: "facebook", title: "Meta (Facebook) Pixel", hint: "Server-side supported (CAPI)." },
    { key: "tiktok", title: "TikTok Pixel", hint: "Config + logs ready; server API wiring later." },
    { key: "google", title: "Google (Gtag/GA4)", hint: "Config + logs ready; server API wiring later." },
  ];

  return (
    <div className="lf-admin">
      <div className="lf-card" style={{ marginBottom: 16 }}>
        <div className="lf-card__title">Pixels</div>
        <div className="lf-muted">
          Configure platform IDs, choose which LeadForm events should fire, and use “Test event” to verify.
        </div>
        {actionData?.error ? (
          <div className="lf-alert lf-alert--danger" style={{ marginTop: 12 }}>
            {actionData.error}
          </div>
        ) : null}
      </div>

      <div style={{ display: "grid", gap: 12 }}>
        {platforms.map((pl) => {
          const p = byPlatform.get(pl.key);
          const ev = (p?.events ?? {}) as Record<string, boolean>;

          return (
            <div className="lf-card" key={pl.key}>
              <div className="lf-row lf-row--between lf-row--center">
                <div>
                  <div className="lf-card__title">{pl.title}</div>
                  <div className="lf-muted">{pl.hint}</div>
                </div>

                <Form method="post">
                  <input type="hidden" name="intent" value="delete" />
                  <input type="hidden" name="platform" value={pl.key} />
                  <button className="lf-btn lf-btn--ghost" type="submit" disabled={!p}>
                    Remove
                  </button>
                </Form>
              </div>

              <Form method="post" style={{ marginTop: 12 }}>
                <input type="hidden" name="intent" value="save" />
                <input type="hidden" name="platform" value={pl.key} />

                <div className="lf-grid" style={{ display: "grid", gap: 10 }}>
                  <label className="lf-field">
                    <div className="lf-label">Pixel ID</div>
                    <input
                      className="lf-input"
                      name="pixelId"
                      defaultValue={p?.pixelId ?? ""}
                      placeholder={pl.key === "facebook" ? "1234567890" : "Pixel/Measurement ID"}
                    />
                  </label>

                  <div className="lf-row" style={{ gap: 14, flexWrap: "wrap" }}>
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
                    <div className="lf-muted">Stored encrypted. Only required for server-side events.</div>
                  </label>

                  <label className="lf-field">
                    <div className="lf-label">Test code (optional)</div>
                    <input className="lf-input" name="testCode" defaultValue={p?.testCode ?? ""} />
                  </label>

                  <div className="lf-divider" />

                  <div className="lf-label">Events</div>
                  <div className="lf-row" style={{ gap: 14, flexWrap: "wrap" }}>
                    {data.events.map((e: string) => (
                      <label className="lf-check" key={e}>
                        <input type="checkbox" name={`ev_${e}`} defaultChecked={!!ev[e]} />
                        <span>{e}</span>
                      </label>
                    ))}
                  </div>

                  <div className="lf-row" style={{ gap: 10, flexWrap: "wrap", marginTop: 6 }}>
                    <button className="lf-btn" type="submit">
                      Save
                    </button>

                    <Form method="post">
                      <input type="hidden" name="intent" value="test" />
                      <input type="hidden" name="platform" value={pl.key} />
                      <button className="lf-btn lf-btn--secondary" type="submit" disabled={!p && pl.key !== "facebook"}>
                        Test event
                      </button>
                    </Form>

                    <div className="lf-muted" style={{ marginLeft: "auto" }}>
                      Last fired: {p?.lastFiredAt ? new Date(p.lastFiredAt).toLocaleString() : "—"}
                    </div>
                  </div>
                </div>
              </Form>
            </div>
          );
        })}
      </div>

      <div className="lf-card" style={{ marginTop: 12 }}>
        <div className="lf-card__title">Pixel Event Logs</div>
        <div className="lf-muted">Last 50 attempts.</div>

        <div style={{ overflowX: "auto", marginTop: 10 }}>
          <table className="lf-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Platform</th>
                <th>Event</th>
                <th>Status</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {(data.logs as any[]).map((l) => (
                <tr key={l.id}>
                  <td>{new Date(l.createdAt).toLocaleString()}</td>
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
