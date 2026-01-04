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
        return json(
          { ok: false, error: "Pixel ID is required." },
          { status: 400 }
        );

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
    return json(
      { ok: false, error: e?.message ?? "Action failed" },
      { status: 500 }
    );
  }
}

/** Inline brand-ish logos (simple, clean, colored via currentColor) */
function PlatformIcon({ platform }: { platform: PixelPlatform }) {
  if (platform === "facebook") {
    // Meta loop (stylized)
    return (
      <svg viewBox="0 0 24 24" className="lf-px-logo" aria-hidden="true">
        <path
          fill="currentColor"
          d="M7.1 6.6c-1.9 0-3.4 1.8-3.4 4.3 0 4.2 2.7 9.6 5 9.6 1.2 0 2.4-2.1 3.5-4.1l.8-1.4.8 1.4c1.1 2 2.3 4.1 3.5 4.1 2.3 0 5-5.4 5-9.6 0-2.5-1.5-4.3-3.4-4.3-2.2 0-4 2.4-6 6-2-3.6-3.8-6-6-6zm0 2c1 0 2.5 1.6 4.5 5.4l-1.2 2.2c-.9 1.7-2 3.7-2.3 3.7-.9 0-3.2-3.6-3.2-7.6 0-1.5.7-2.3 1.7-2.3zm9.8 0c1 0 1.7.8 1.7 2.3 0 4-2.3 7.6-3.2 7.6-.3 0-1.4-2-2.3-3.7l-1.2-2.2c2-3.8 3.5-5.4 4.5-5.4z"
        />
      </svg>
    );
  }

  if (platform === "tiktok") {
    // TikTok note (simple)
    return (
      <svg viewBox="0 0 24 24" className="lf-px-logo" aria-hidden="true">
        <path
          fill="currentColor"
          d="M14 3v10.2a3.8 3.8 0 1 1-3.4-3.8v3a.8.8 0 0 0-.8.8 1.4 1.4 0 1 0 2.8 0V3h3.6c.4 2.6 2 4.3 4.8 4.6v3.1c-2.6-.1-4.6-1.2-6-2.8V19a5 5 0 1 1-5-5c.6 0 1.1.1 1.6.2V11a8 8 0 1 0 8 8V3h-3.6z"
        />
      </svg>
    );
  }

  // Google "G" (mono, premium)
  return (
    <svg viewBox="0 0 24 24" className="lf-px-logo" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 10.2v3.7h5.2c-.3 1.8-2 3.7-5.2 3.7-3.1 0-5.6-2.6-5.6-5.8S8.9 6 12 6c1.8 0 3 .8 3.7 1.5l2.5-2.4C16.7 3.7 14.6 2.6 12 2.6 7 2.6 3 6.7 3 11.8S7 21 12 21c5.2 0 8.6-3.7 8.6-8.9 0-.6-.1-1-.2-1.9H12z"
      />
    </svg>
  );
}

function PlatformMeta(pl: PixelPlatform) {
  if (pl === "facebook") {
    return {
      title: "Meta (Facebook / Instagram)",
      hint: "Server-side supported (CAPI).",
      cls: "lf-px-card--meta",
      color: "meta",
    };
  }
  if (pl === "tiktok") {
    return {
      title: "TikTok Pixel",
      hint: "Config + logs ready (server wiring later).",
      cls: "lf-px-card--tiktok",
      color: "tiktok",
    };
  }
  return {
    title: "Google (Gtag / GA4)",
    hint: "Config + logs ready (server wiring later).",
    cls: "lf-px-card--google",
    color: "google",
  };
}

export default function PixelsRoute() {
  const data = useLoaderData() as any;
  const actionData = useActionData() as any;

  const byPlatform = new Map<string, any>();
  for (const p of data.pixels as any[]) byPlatform.set(p.platform, p);

  const platforms: PixelPlatform[] = ["facebook", "tiktok", "google"];

  return (
    <div className="lf-admin lf-px">
      <div className="lf-card lf-px__hero">
        <div className="lf-px__heroRow">
          <div>
            <div className="lf-card__title">Pixels</div>
            <div className="lf-muted">
              Configure IDs, select events, and test firing. Logs show the last 50
              attempts.
            </div>
          </div>
          <div className="lf-px__heroPill">Premium Tracking</div>
        </div>

        {actionData?.error ? (
          <div className="lf-alert lf-alert--danger" style={{ marginTop: 10 }}>
            {actionData.error}
          </div>
        ) : null}
      </div>

      <div className="lf-px__grid">
        {platforms.map((pl) => {
          const meta = PlatformMeta(pl);
          const p = byPlatform.get(pl);
          const ev = (p?.events ?? {}) as Record<string, boolean>;

          const enabled = p ? !!p.enabled : false;
          const apiEnabled = p ? !!p.apiEnabled : false;

          const saveFormId = `px-save-${pl}`;
          const testFormId = `px-test-${pl}`;

          return (
            <div className={`lf-card lf-px-card ${meta.cls}`} key={pl}>
              <div className="lf-px-card__header">
                <div className="lf-px-card__brand">
                  <span className={`lf-px-badge lf-px-badge--${meta.color}`}>
                    <PlatformIcon platform={pl} />
                  </span>
                  <div>
                    <div className="lf-px-card__title">{meta.title}</div>
                    <div className="lf-muted">{meta.hint}</div>
                  </div>
                </div>

                <div className="lf-px-card__right">
                  <div className="lf-px-chips">
                    <span className={`lf-px-chip ${enabled ? "is-on" : ""}`}>
                      {enabled ? "Enabled" : "Disabled"}
                    </span>
                    <span className={`lf-px-chip ${apiEnabled ? "is-on" : ""}`}>
                      {apiEnabled ? "Server API" : "Client only"}
                    </span>
                  </div>

                  <Form method="post">
                    <input type="hidden" name="intent" value="delete" />
                    <input type="hidden" name="platform" value={pl} />
                    <button
                      className="lf-btn lf-btn--ghost lf-px-remove"
                      type="submit"
                      disabled={!p}
                      title="Remove config"
                    >
                      Remove
                    </button>
                  </Form>
                </div>
              </div>

              {/* SAVE FORM (no nested forms) */}
              <Form method="post" id={saveFormId} className="lf-px-form">
                <input type="hidden" name="intent" value="save" />
                <input type="hidden" name="platform" value={pl} />

                <div className="lf-px-form__grid">
                  <label className="lf-field lf-px-field">
                    <div className="lf-label">Pixel ID</div>
                    <input
                      className="lf-input"
                      name="pixelId"
                      defaultValue={p?.pixelId ?? ""}
                      placeholder={
                        pl === "facebook"
                          ? "1234567890"
                          : "Pixel / Measurement ID"
                      }
                    />
                  </label>

                  <div className="lf-px-toggles">
                    <label className="lf-check lf-px-check">
                      <input
                        type="checkbox"
                        name="enabled"
                        defaultChecked={p?.enabled ?? true}
                      />
                      <span>Enabled</span>
                    </label>

                    <label className="lf-check lf-px-check">
                      <input
                        type="checkbox"
                        name="apiEnabled"
                        defaultChecked={p?.apiEnabled ?? false}
                      />
                      <span>Server API enabled</span>
                    </label>
                  </div>

                  <label className="lf-field lf-px-field">
                    <div className="lf-label">Access token / API secret</div>
                    <input
                      className="lf-input"
                      name="accessToken"
                      placeholder="Leave empty to keep current token"
                      autoComplete="off"
                    />
                    <div className="lf-muted">
                      Stored encrypted. Required only for Meta CAPI.
                    </div>
                  </label>

                  <label className="lf-field lf-px-field">
                    <div className="lf-label">Test code (optional)</div>
                    <input
                      className="lf-input"
                      name="testCode"
                      defaultValue={p?.testCode ?? ""}
                    />
                  </label>

                  <div className="lf-px-eventsWrap">
                    <div className="lf-label">Events</div>
                    <div className="lf-px-events">
                      {data.events.map((e: string) => (
                        <label className="lf-px-pill" key={e}>
                          <input
                            type="checkbox"
                            name={`ev_${e}`}
                            defaultChecked={!!ev[e]}
                          />
                          <span>{e}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              </Form>

              {/* TEST FORM (separate sibling form, NOT nested) */}
              <Form method="post" id={testFormId} className="lf-px-testForm">
                <input type="hidden" name="intent" value="test" />
                <input type="hidden" name="platform" value={pl} />
              </Form>

              <div className="lf-px-footer">
                <div className="lf-px-footer__left">
                  <button className="lf-btn lf-px-save" type="submit" form={saveFormId}>
                    Save
                  </button>
                  <button
                    className="lf-btn lf-btn--secondary lf-px-test"
                    type="submit"
                    form={testFormId}
                  >
                    Test event
                  </button>
                </div>

                <div className="lf-px-footer__right">
                  <span className="lf-muted">
                    Last fired:{" "}
                    {p?.lastFiredAt ? new Date(p.lastFiredAt).toLocaleString() : "—"}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="lf-card lf-px-logs">
        <div className="lf-card__title">Pixel Event Logs</div>
        <div className="lf-muted">Last 50 attempts.</div>

        <div style={{ overflowX: "auto", marginTop: 10 }}>
          <table className="lf-table lf-px-table">
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
                  <td>
                    <span className={`lf-px-dot lf-px-dot--${l.platform}`} />
                    {l.platform}
                  </td>
                  <td>{l.event}</td>
                  <td>
                    <span
                      className={`lf-px-status ${
                        l.status === "success" ? "ok" : "bad"
                      }`}
                    >
                      {l.status}
                    </span>
                  </td>
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
