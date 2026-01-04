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
import { useMemo, useState } from "react";

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

function platformLabel(pl: PixelPlatform | string) {
  return pl === "facebook" ? "Meta" : pl === "tiktok" ? "TikTok" : "Google";
}

function platformTitle(pl: PixelPlatform) {
  if (pl === "facebook") return "Meta";
  if (pl === "tiktok") return "TikTok Pixel";
  return "Google (GA4)";
}

function platformHint(pl: PixelPlatform) {
  if (pl === "facebook") return "Server-side supported (Meta CAPI).";
  if (pl === "tiktok") return "Server-side supported (TikTok Events API).";
  return "Server-side supported (GA4 Measurement Protocol).";
}

function tokenLabel(pl: PixelPlatform) {
  if (pl === "facebook") return "Access token (CAPI)";
  if (pl === "tiktok") return "Access token (Events API)";
  return "API secret (GA4)";
}

function tokenHelp(pl: PixelPlatform) {
  if (pl === "facebook") return "Meta Conversions API access token. Stored encrypted.";
  if (pl === "tiktok") return "TikTok Events API access token. Stored encrypted.";
  return "GA4 Measurement Protocol API secret. Stored encrypted.";
}

function pixelIdLabel(pl: PixelPlatform) {
  if (pl === "facebook") return "Pixel ID";
  if (pl === "tiktok") return "Pixel Code";
  return "Measurement ID";
}

function pixelIdPlaceholder(pl: PixelPlatform) {
  if (pl === "facebook") return "1234567890";
  if (pl === "tiktok") return "TikTok Pixel Code";
  return "G-XXXXXXXXXX";
}

function platformClass(pl: PixelPlatform) {
  if (pl === "facebook") return "is-meta";
  if (pl === "tiktok") return "is-tiktok";
  return "is-google";
}

function PlatformIcon({ platform }: { platform: PixelPlatform }) {
  const src =
    platform === "facebook"
      ? "/brands/meta.png"
      : platform === "tiktok"
      ? "/brands/tiktok.svg"
      : "/brands/google.svg";

  return <img src={src} alt="" className="lf-px-logo" loading="lazy" decoding="async" />;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span className={`lf-px-chev ${open ? "is-open" : ""}`} aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path
          d="M6 9l6 6 6-6"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

export default function PixelsRoute() {
  const data = useLoaderData() as any;
  const actionData = useActionData() as any;

  const byPlatform = useMemo(() => {
    const m = new Map<string, any>();
    for (const p of data.pixels as any[]) m.set(p.platform, p);
    return m;
  }, [data.pixels]);

  const platforms: PixelPlatform[] = ["facebook", "tiktok", "google"];

  // Always start closed (no localStorage restore)
  const [openPl, setOpenPl] = useState<PixelPlatform | null>(null);

  const hasAnyOpen = !!openPl;

  return (
    <div className="lf-admin lf-px">
      <style>{`
        /* =========================================================================
           Pixels – Premium UI (self-contained styles for this route)
           ========================================================================= */
        .lf-px {
          --px-bg1: rgba(99, 102, 241, 0.10);
          --px-bg2: rgba(56, 189, 248, 0.08);
          --px-card: rgba(255,255,255,0.85);
          --px-border: rgba(16, 24, 40, 0.10);
          --px-text: rgba(17, 24, 39, 0.96);
          --px-muted: rgba(55, 65, 81, 0.78);
          --px-shadow: 0 18px 45px rgba(15, 23, 42, 0.08);
          --px-shadow2: 0 10px 24px rgba(15, 23, 42, 0.10);
          --px-radius: 18px;
        }

        .lf-px .lf-muted { color: var(--px-muted); }
        .lf-px .lf-card { border: 1px solid var(--px-border); box-shadow: var(--px-shadow); }

        /* Hero */
        .lf-px__hero {
          background:
            radial-gradient(900px 250px at 10% 0%, var(--px-bg1), transparent 60%),
            radial-gradient(900px 250px at 85% 0%, var(--px-bg2), transparent 62%),
            linear-gradient(180deg, rgba(255,255,255,0.95), rgba(255,255,255,0.78));
          backdrop-filter: blur(8px);
        }
        .lf-px__heroRow {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 14px;
        }
        .lf-px__heroPill {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 8px 12px;
          border-radius: 999px;
          border: 1px solid rgba(99, 102, 241, 0.25);
          background: rgba(99, 102, 241, 0.08);
          color: rgba(17, 24, 39, 0.9);
          font-weight: 600;
          letter-spacing: 0.2px;
          white-space: nowrap;
        }

        /* Grid behavior */
        .lf-px__grid {
          margin-top: 14px;
          display: grid;
          gap: 14px;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          align-items: start;
        }
        .lf-px__grid.is-open {
          grid-template-columns: 1fr;
          gap: 12px;
        }

        /* Card shell */
        .lf-px-card {
          position: relative;
          overflow: hidden;
          border-radius: var(--px-radius);
          background: var(--px-card);
          backdrop-filter: blur(8px);
        }

        .lf-px-card::before {
          content: "";
          position: absolute;
          left: 0; right: 0; top: 0;
          height: 130px;
          opacity: 1;
          pointer-events: none;
          transform: translateY(0);
        }

        .lf-px-card.is-meta::before {
          background:
            radial-gradient(320px 120px at 18% 40%, rgba(0, 164, 255, 0.35), transparent 60%),
            radial-gradient(280px 140px at 72% 20%, rgba(143, 64, 255, 0.35), transparent 60%),
            linear-gradient(90deg, rgba(79, 70, 229, 0.20), rgba(0, 186, 255, 0.14));
        }
        .lf-px-card.is-tiktok::before {
          background:
            radial-gradient(320px 120px at 20% 40%, rgba(0, 242, 234, 0.26), transparent 60%),
            radial-gradient(280px 140px at 75% 25%, rgba(255, 0, 80, 0.20), transparent 60%),
            linear-gradient(90deg, rgba(2, 6, 23, 0.14), rgba(2, 6, 23, 0.06));
        }
        .lf-px-card.is-google::before {
          background:
            radial-gradient(320px 120px at 18% 35%, rgba(66, 133, 244, 0.22), transparent 60%),
            radial-gradient(280px 140px at 62% 15%, rgba(52, 168, 83, 0.18), transparent 60%),
            radial-gradient(260px 120px at 82% 55%, rgba(251, 188, 5, 0.16), transparent 60%),
            radial-gradient(260px 120px at 45% 70%, rgba(234, 67, 53, 0.12), transparent 60%),
            linear-gradient(90deg, rgba(66, 133, 244, 0.10), rgba(255,255,255,0.00));
        }

        .lf-px-headBtn {
          position: relative;
          z-index: 1;
          display: flex;
          width: 100%;
          border: 0;
          background: transparent;
          cursor: pointer;
          padding: 14px 14px 12px 14px;
          text-align: left;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .lf-px-headLeft {
          display: flex;
          align-items: center;
          gap: 12px;
          min-width: 0;
        }

        .lf-px-logoWrap {
          width: 40px;
          height: 40px;
          border-radius: 12px;
          display: grid;
          place-items: center;
          background: rgba(255,255,255,0.80);
          border: 1px solid rgba(15, 23, 42, 0.10);
          box-shadow: 0 10px 22px rgba(15, 23, 42, 0.06);
          flex: 0 0 auto;
        }
        .lf-px-logo {
          width: 22px;
          height: 22px;
          object-fit: contain;
          display: block;
        }

        .lf-px-titleWrap { min-width: 0; }
        .lf-px-title {
          margin: 0;
          font-size: 14px;
          line-height: 1.1;
          font-weight: 750;
          letter-spacing: 0.2px;
          color: rgba(17, 24, 39, 0.92);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .lf-px-hint {
          margin-top: 4px;
          font-size: 12px;
          line-height: 1.2;
          color: rgba(55, 65, 81, 0.72);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .lf-px-headRight {
          display: flex;
          align-items: center;
          gap: 10px;
          flex: 0 0 auto;
        }

        .lf-px-chips {
          display: flex;
          gap: 8px;
          align-items: center;
        }
        .lf-px-chip {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          padding: 6px 10px;
          border-radius: 999px;
          border: 1px solid rgba(15, 23, 42, 0.10);
          background: rgba(255,255,255,0.70);
          font-size: 12px;
          font-weight: 650;
          color: rgba(17, 24, 39, 0.80);
        }
        .lf-px-chip.is-on {
          border-color: rgba(16, 185, 129, 0.28);
          background: rgba(16, 185, 129, 0.10);
          color: rgba(17, 24, 39, 0.92);
        }

        .lf-px-chev {
          width: 34px;
          height: 34px;
          border-radius: 12px;
          display: grid;
          place-items: center;
          border: 1px solid rgba(15, 23, 42, 0.10);
          background: rgba(255,255,255,0.75);
          box-shadow: 0 10px 22px rgba(15, 23, 42, 0.05);
          transition: transform 240ms ease, background 240ms ease;
        }
        .lf-px-chev svg { opacity: 0.9; }
        .lf-px-chev.is-open {
          transform: rotate(180deg);
          background: rgba(255,255,255,0.90);
        }

        .lf-px-body {
          position: relative;
          z-index: 1;
          padding: 0 14px 14px 14px;
        }
        .lf-px-collapse {
          overflow: hidden;
          max-height: 0;
          opacity: 0;
          transform: translateY(-6px);
          transition:
            max-height 320ms cubic-bezier(.2,.8,.2,1),
            opacity 220ms ease,
            transform 220ms ease;
          will-change: max-height, opacity, transform;
        }
        .lf-px-card.is-open .lf-px-collapse {
          max-height: 1800px;
          opacity: 1;
          transform: translateY(0);
        }

        .lf-px-card.is-open {
          box-shadow: var(--px-shadow2);
        }

        .lf-px-topRow {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          margin: 2px 0 10px;
        }
        .lf-px-topRow .lf-btn--ghost {
          padding: 6px 10px;
          border-radius: 10px;
        }

        .lf-px-form__grid {
          display: grid;
          grid-template-columns: 1.2fr 1fr;
          gap: 12px;
          align-items: start;
          padding: 12px;
          border-radius: 16px;
          border: 1px solid rgba(15, 23, 42, 0.10);
          background: rgba(255,255,255,0.90);
        }

        .lf-px-toggles {
          display: flex;
          gap: 12px;
          flex-wrap: wrap;
          align-items: center;
          padding-top: 18px;
        }

        .lf-px-check {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 8px 10px;
          border-radius: 12px;
          border: 1px solid rgba(15, 23, 42, 0.10);
          background: rgba(255,255,255,0.75);
          font-weight: 650;
          font-size: 12px;
          color: rgba(17, 24, 39, 0.86);
        }
        .lf-px-check input { transform: translateY(0.5px); }

        .lf-px-eventsWrap {
          grid-column: 1 / -1;
        }
        .lf-px-events {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          margin-top: 8px;
        }
        .lf-px-pill {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 8px 12px;
          border-radius: 999px;
          border: 1px solid rgba(15, 23, 42, 0.12);
          background: rgba(255,255,255,0.78);
          font-size: 12px;
          font-weight: 650;
          color: rgba(17, 24, 39, 0.86);
          transition: transform 140ms ease, box-shadow 140ms ease;
        }
        .lf-px-pill:hover { transform: translateY(-1px); box-shadow: 0 10px 18px rgba(15, 23, 42, 0.06); }

        .lf-px-footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-top: 12px;
        }
        .lf-px-footer__left {
          display: flex;
          gap: 10px;
          align-items: center;
        }
        .lf-px-save {
          border-radius: 12px !important;
          padding: 10px 14px !important;
          font-weight: 750 !important;
        }
        .lf-px-test {
          border-radius: 12px !important;
          padding: 10px 14px !important;
          font-weight: 700 !important;
        }

        .lf-px-logs { margin-top: 14px; }
        .lf-px-table th, .lf-px-table td { font-size: 12px; }
        .lf-px-dot {
          display: inline-block;
          width: 8px;
          height: 8px;
          border-radius: 999px;
          margin-right: 8px;
          vertical-align: middle;
        }
        .lf-px-dot--facebook { background: rgba(99,102,241,0.85); }
        .lf-px-dot--tiktok { background: rgba(2,6,23,0.85); }
        .lf-px-dot--google { background: rgba(66,133,244,0.85); }

        @media (max-width: 1100px) {
          .lf-px__grid { grid-template-columns: 1fr; }
          .lf-px__grid.is-open { grid-template-columns: 1fr; }
          .lf-px-form__grid { grid-template-columns: 1fr; }
          .lf-px-toggles { padding-top: 0; }
        }
      `}</style>

      <div className="lf-card lf-px__hero">
        <div className="lf-px__heroRow">
          <div>
            <div className="lf-card__title">Pixels</div>
            <div className="lf-muted">Configure IDs, select events, and test firing.</div>
          </div>
          <div className="lf-px__heroPill">Premium Tracking</div>
        </div>

        {actionData?.error ? (
          <div className="lf-alert lf-alert--danger" style={{ marginTop: 10 }}>
            {actionData.error}
          </div>
        ) : null}
      </div>

      <div className={`lf-px__grid ${hasAnyOpen ? "is-open" : ""}`}>
        {platforms.map((pl) => {
          const p = byPlatform.get(pl);
          const ev = (p?.events ?? {}) as Record<string, boolean>;

          const enabled = p ? !!p.enabled : false;
          const apiEnabled = p ? !!p.apiEnabled : false;

          const saveFormId = `px-save-${pl}`;
          const testFormId = `px-test-${pl}`;

          const isOpen = openPl === pl;

          return (
            <div
              key={pl}
              className={`lf-px-card lf-card ${platformClass(pl)} ${isOpen ? "is-open" : ""}`}
            >
              <button
                type="button"
                className="lf-px-headBtn"
                onClick={() => setOpenPl((cur) => (cur === pl ? null : pl))}
                aria-expanded={isOpen}
              >
                <div className="lf-px-headLeft">
                  <span className="lf-px-logoWrap">
                    <PlatformIcon platform={pl} />
                  </span>
                  <div className="lf-px-titleWrap">
                    <div className="lf-px-title">{platformTitle(pl)}</div>
                    <div className="lf-px-hint">{platformHint(pl)}</div>
                  </div>
                </div>

                <div className="lf-px-headRight">
                  <div className="lf-px-chips">
                    <span className={`lf-px-chip ${enabled ? "is-on" : ""}`}>
                      {enabled ? "Enabled" : "Disabled"}
                    </span>
                    <span className={`lf-px-chip ${apiEnabled ? "is-on" : ""}`}>
                      {apiEnabled ? "Server API" : "Disabled"}
                    </span>
                  </div>
                  <Chevron open={isOpen} />
                </div>
              </button>

              <div className="lf-px-body">
                <div className="lf-px-collapse">
                  <div className="lf-px-topRow">
                    <span className="lf-muted">
                      Last fired:{" "}
                      {p?.lastFiredAt ? new Date(p.lastFiredAt).toLocaleString() : "—"}
                    </span>

                    <Form method="post">
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="platform" value={pl} />
                      <button
                        className="lf-btn lf-btn--ghost"
                        type="submit"
                        disabled={!p}
                        title="Remove config"
                      >
                        Remove
                      </button>
                    </Form>
                  </div>

                  <Form method="post" id={saveFormId} className="lf-px-form">
                    <input type="hidden" name="intent" value="save" />
                    <input type="hidden" name="platform" value={pl} />

                    <div className="lf-px-form__grid">
                      <label className="lf-field lf-px-field">
                        <div className="lf-label">{pixelIdLabel(pl)}</div>
                        <input
                          className="lf-input"
                          name="pixelId"
                          defaultValue={p?.pixelId ?? ""}
                          placeholder={pixelIdPlaceholder(pl)}
                        />
                        {pl === "google" ? (
                          <div className="lf-muted">Use GA4 Measurement ID (starts with G-).</div>
                        ) : null}
                      </label>

                      <div className="lf-px-toggles">
                        <label className="lf-px-check">
                          <input
                            type="checkbox"
                            name="enabled"
                            defaultChecked={p?.enabled ?? true}
                          />
                          <span>Enabled</span>
                        </label>

                        <label className="lf-px-check">
                          <input
                            type="checkbox"
                            name="apiEnabled"
                            defaultChecked={p?.apiEnabled ?? false}
                          />
                          <span>Server API enabled</span>
                        </label>
                      </div>

                      <label className="lf-field lf-px-field">
                        <div className="lf-label">{tokenLabel(pl)}</div>
                        <input
                          className="lf-input"
                          name="accessToken"
                          placeholder="Leave empty to keep current value"
                          autoComplete="off"
                        />
                        <div className="lf-muted">{tokenHelp(pl)}</div>
                      </label>

                      <label className="lf-field lf-px-field">
                        <div className="lf-label">Test code (optional)</div>
                        <input
                          className="lf-input"
                          name="testCode"
                          defaultValue={p?.testCode ?? ""}
                        />
                        {pl === "google" ? (
                          <div className="lf-muted">
                            Optional. Test code is not used by GA4 Measurement Protocol.
                          </div>
                        ) : null}
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

                {!isOpen ? (
                  <div className="lf-muted" style={{ padding: "8px 2px 10px" }}>
                    Click to configure {platformLabel(pl)} events and test firing.
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <div className="lf-card lf-px-logs">
        <div className="lf-card__title">Pixel Event Logs</div>

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
                    {platformLabel(String(l.platform))}
                  </td>
                  <td>{l.event}</td>
                  <td>
                    <span className={`lf-px-status ${l.status === "success" ? "ok" : "bad"}`}>
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
