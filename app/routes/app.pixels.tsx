// app/routes/app.pixels.tsx
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useActionData, useLoaderData, useRouteError } from "react-router";
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

function PlatformIcon({ platform }: { platform: PixelPlatform }) {
  const src =
    platform === "facebook"
      ? "/brands/meta.png"
      : platform === "tiktok"
      ? "/brands/tiktok.svg"
      : "/brands/google.svg";

  return (
    <img
      src={src}
      alt=""
      className="lf-px-logoImg"
      loading="lazy"
      decoding="async"
    />
  );
}

function PlatformMeta(pl: PixelPlatform) {
  if (pl === "facebook") {
    return {
      title: "Meta",
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

function displayPlatformName(pl: string) {
  return pl === "facebook" ? "Meta" : pl;
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
              <details className="lf-px-acc">
                <summary className="lf-px-acc__summary">
                  <div className="lf-px-acc__summaryLeft">
                    <span className={`lf-px-badge lf-px-badge--${meta.color}`}>
                      <PlatformIcon platform={pl} />
                    </span>

                    <div className="lf-px-acc__titleWrap">
                      <div className="lf-px-card__title">{meta.title}</div>
                      <div className="lf-px-sub">{meta.hint}</div>
                    </div>
                  </div>

                  <div className="lf-px-acc__summaryRight">
                    <div className="lf-px-chips">
                      <span className={`lf-px-chip ${enabled ? "is-on" : ""}`}>
                        {enabled ? "Enabled" : "Disabled"}
                      </span>
                      <span className={`lf-px-chip ${apiEnabled ? "is-on" : ""}`}>
                        {apiEnabled ? "Server API" : "Client only"}
                      </span>
                    </div>

                    <div className="lf-px-acc__caret" aria-hidden="true">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                        <path
                          d="M6 9l6 6 6-6"
                          stroke="currentColor"
                          strokeWidth="2.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </div>
                  </div>
                </summary>

                <div className="lf-px-acc__body">
                  <div className="lf-px-topRow">
                    <div className="lf-px-lastFired">
                      <span className="lf-muted">
                        Last fired:{" "}
                        {p?.lastFiredAt
                          ? new Date(p.lastFiredAt).toLocaleString()
                          : "—"}
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
                  </div>
                </div>
              </details>
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
                    {displayPlatformName(String(l.platform))}
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
