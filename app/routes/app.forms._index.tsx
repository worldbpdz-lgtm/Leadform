// app/routes/app.forms._index.tsx
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "~/shopify.server";
import { prisma } from "~/db.server";

type LoaderData = {
  currentFormId: string | null;
  forms: Array<{
    id: string;
    name: string;
    slug: string;
    status: string;
    placement: string;
    isActive: boolean;
    updatedAt: string;
  }>;
};

function slugify(input: string) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 48);
}

async function ensureShopId(shopDomain: string) {
  const shop = await prisma.shop.upsert({
    where: { shopDomain },
    update: { uninstalledAt: null },
    create: { shopDomain, installedAt: new Date() },
    select: { id: true },
  });
  return shop.id;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shopId = await ensureShopId(session.shop);

  const [settings, forms] = await Promise.all([
    prisma.shopSettings.findUnique({
      where: { shopId },
      select: { currentFormId: true },
    }),
    prisma.form.findMany({
      where: { shopId, status: { not: "archived" } },
      orderBy: [{ updatedAt: "desc" }],
      select: { id: true, name: true, slug: true, status: true, placement: true, isActive: true, updatedAt: true },
    }),
  ]);

  const data: LoaderData = {
    currentFormId: settings?.currentFormId ?? null,
    forms: forms.map((f) => ({
      ...f,
      updatedAt: f.updatedAt.toISOString(),
    })),
  };

  return data;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await ensureShopId(session.shop);

  const fd = await request.formData();
  const intent = String(fd.get("intent") || "");

  if (intent === "create") {
    const name = String(fd.get("name") || "Default form").trim() || "Default form";
    const placement = String(fd.get("placement") || "popup");

    const baseSlug = slugify(String(fd.get("slug") || name));
    const slug = baseSlug || `form-${Date.now().toString(36)}`;

    // Guarantee unique slug per shop
    const conflict = await prisma.form.findFirst({ where: { shopId, slug }, select: { id: true } });
    const finalSlug = conflict ? `${slug}-${Date.now().toString(36).slice(-4)}` : slug;

    const created = await prisma.form.create({
      data: {
        shopId,
        name,
        slug: finalSlug,
        placement: placement as any,
        status: "draft",
        isActive: false,
        // Start with a sane default set; you can edit/remove in builder
        fields: {
          create: [
            { type: "text", label: "First name", nameKey: "firstName", required: true, visible: true, orderIndex: 0, placeholder: "First name" },
            { type: "text", label: "Last name", nameKey: "lastName", required: true, visible: true, orderIndex: 1, placeholder: "Last name" },
            { type: "tel", label: "Phone", nameKey: "phone", required: true, visible: true, orderIndex: 2, placeholder: "+213..." },
            { type: "email", label: "Email", nameKey: "email", required: false, visible: true, orderIndex: 3, placeholder: "email@example.com" },
            {
              type: "select",
              label: "Wilaya",
              nameKey: "wilayaCode",
              required: true,
              visible: true,
              orderIndex: 4,
              options: { datasource: "wilayas", valueType: "number", visibleFor: ["individual", "installer", "company"] },
            },
            {
              type: "select",
              label: "Commune",
              nameKey: "communeId",
              required: false,
              visible: true,
              orderIndex: 5,
              options: { datasource: "communes", dependsOn: "wilayaCode", optional: true, visibleFor: ["individual", "installer", "company"] },
            },
            { type: "textarea", label: "Address", nameKey: "address", required: false, visible: true, orderIndex: 6, placeholder: "Street / City" },
            { type: "number", label: "Quantity", nameKey: "qty", required: true, visible: true, orderIndex: 7, options: { min: 1, step: 1 }, placeholder: "1" },
          ],
        },
      },
      select: { id: true },
    });

    return { ok: true, id: created.id };
  }

  if (intent === "setCurrent") {
    const formId = String(fd.get("formId") || "").trim();
    if (!formId) return { ok: false, error: "Missing formId" };

    await prisma.shopSettings.upsert({
      where: { shopId },
      update: { currentFormId: formId },
      create: { shopId, currentFormId: formId },
    });

    return { ok: true };
  }

  if (intent === "activate") {
    const formId = String(fd.get("formId") || "").trim();
    if (!formId) return { ok: false, error: "Missing formId" };

    await prisma.$transaction([
      prisma.form.updateMany({
        where: { shopId, isActive: true },
        data: { isActive: false },
      }),
      prisma.form.update({
        where: { id: formId },
        data: { status: "active", isActive: true },
      }),
      prisma.shopSettings.upsert({
        where: { shopId },
        update: { currentFormId: formId },
        create: { shopId, currentFormId: formId },
      }),
    ]);

    return { ok: true };
  }

  if (intent === "archive") {
    const formId = String(fd.get("formId") || "").trim();
    if (!formId) return { ok: false, error: "Missing formId" };

    await prisma.$transaction(async (tx) => {
      await tx.form.update({ where: { id: formId }, data: { status: "archived", isActive: false } });

      const settings = await tx.shopSettings.findUnique({ where: { shopId }, select: { currentFormId: true } });
      if (settings?.currentFormId === formId) {
        await tx.shopSettings.update({ where: { shopId }, data: { currentFormId: null } });
      }
    });

    return { ok: true };
  }

  return { ok: false, error: "Unknown intent" };
};

export default function FormsIndex() {
  const { forms, currentFormId } = useLoaderData() as LoaderData;

  const createFetcher = useFetcher();
  const currentFetcher = useFetcher();
  const activateFetcher = useFetcher();
  const archiveFetcher = useFetcher();

  return (
    <div className="lf-enter">
      <div className="lf-card">
        <div className="lf-toolbar">
          <div style={{ fontWeight: 800, letterSpacing: "-0.02em" }}>Forms</div>

          <createFetcher.Form method="post" className="lf-btn-row">
            <input type="hidden" name="intent" value="create" />
            <input className="lf-input" name="name" placeholder="New form name" style={{ maxWidth: 260 }} />
            <select className="lf-input lf-input--select" name="placement" defaultValue="popup">
              <option value="popup">Popup</option>
              <option value="inline">Inline</option>
              <option value="slidein">Slide-in</option>
              <option value="landing">Landing</option>
            </select>
            <button className="lf-pill lf-pill--primary" type="submit">Create</button>
          </createFetcher.Form>
        </div>

        <div className="lf-mt-4">
          {forms.length ? (
            <div className="lf-forms-grid">
              {forms.map((f) => {
                const isCurrent = currentFormId === f.id;
                return (
                  <div key={f.id} className="lf-card lf-card--interactive" style={{ padding: 16 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 850, letterSpacing: "-0.02em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {f.name}
                        </div>
                        <div className="lf-muted" style={{ marginTop: 6 }}>
                          <span className="lf-badge"><span className="lf-dot" />{f.status}</span>
                          <span style={{ marginLeft: 10 }}>• {f.placement}</span>
                          <span style={{ marginLeft: 10 }}>• Updated {new Date(f.updatedAt).toLocaleString()}</span>
                        </div>
                      </div>

                      <div className="lf-btn-row" style={{ justifyContent: "flex-end" }}>
                        {isCurrent ? (
                          <span className="lf-badge lf-badge--basket" title="Current form">Current</span>
                        ) : (
                          <currentFetcher.Form method="post">
                            <input type="hidden" name="intent" value="setCurrent" />
                            <input type="hidden" name="formId" value={f.id} />
                            <button className="lf-pill" type="submit">Set current</button>
                          </currentFetcher.Form>
                        )}

                        {!f.isActive ? (
                          <activateFetcher.Form method="post">
                            <input type="hidden" name="intent" value="activate" />
                            <input type="hidden" name="formId" value={f.id} />
                            <button className="lf-pill lf-pill--success" type="submit">Publish</button>
                          </activateFetcher.Form>
                        ) : (
                          <span className="lf-badge lf-badge--approved" title="Published">
                            <span className="lf-dot" />Published
                          </span>
                        )}

                        <Link to={`/app/forms/${f.id}`} className="lf-pill lf-pill--ghost" style={{ textDecoration: "none" }}>
                          Edit
                        </Link>

                        <archiveFetcher.Form method="post">
                          <input type="hidden" name="intent" value="archive" />
                          <input type="hidden" name="formId" value={f.id} />
                          <button className="lf-pill" type="submit">Archive</button>
                        </archiveFetcher.Form>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="lf-muted">No forms yet. Create one above.</div>
          )}
        </div>
      </div>
    </div>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
