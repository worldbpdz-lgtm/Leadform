// app/routes/app.forms.$id.tsx
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "~/shopify.server";
import { prisma } from "~/db.server";
import { useEffect, useMemo, useState } from "react";

type FieldType =
  | "text"
  | "email"
  | "tel"
  | "number"
  | "textarea"
  | "select"
  | "multiselect"
  | "checkbox"
  | "radio"
  | "file"
  | "date"
  | "hidden";

type RoleType = "individual" | "installer" | "company";

type FieldDTO = {
  id: string;
  type: FieldType;
  label: string;
  nameKey: string;
  placeholder: string | null;
  helpText: string | null;
  required: boolean;
  visible: boolean;
  orderIndex: number;
  options: any;
  validation: any;
  errorMessage: string | null;
};

type LoaderData = {
  form: {
    id: string;
    name: string;
    slug: string;
    status: string;
    placement: string;
    isActive: boolean;
    ui: any;
    fields: FieldDTO[];
  };
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function sanitizeNameKey(raw: string) {
  const s = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!s) return "field";
  if (!/^[a-z_]/.test(s)) return `f_${s}`;
  return s.slice(0, 48);
}

function ensureUniqueNameKeys(fields: Array<Pick<FieldDTO, "id" | "nameKey">>) {
  const used = new Map<string, number>();
  return fields.map((f) => {
    const base = sanitizeNameKey(f.nameKey);
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    if (n === 0) return { ...f, nameKey: base };
    return { ...f, nameKey: `${base}_${n + 1}` };
  });
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

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await ensureShopId(session.shop);

  const id = String(params.id || "");
  const form = await prisma.form.findFirst({
    where: { id, shopId },
    include: { fields: { orderBy: { orderIndex: "asc" } } },
  });
  if (!form) return json({ ok: false, error: "Form not found" }, 404);

  const data: LoaderData = {
    form: {
      id: form.id,
      name: form.name,
      slug: form.slug,
      status: form.status,
      placement: form.placement,
      isActive: form.isActive,
      ui: form.ui,
      fields: form.fields.map((f) => ({
        id: f.id,
        type: f.type as any,
        label: f.label,
        nameKey: f.nameKey,
        placeholder: f.placeholder,
        helpText: f.helpText,
        required: f.required,
        visible: f.visible,
        orderIndex: f.orderIndex,
        options: f.options,
        validation: f.validation,
        errorMessage: f.errorMessage,
      })),
    },
  };

  return data;
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await ensureShopId(session.shop);
  const id = String(params.id || "");

  const fd = await request.formData();
  const intent = String(fd.get("intent") || "");

  if (intent !== "saveAll") return { ok: false, error: "Unknown intent" };

  const raw = String(fd.get("payload") || "");
  let payload: any = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Invalid payload" };
  }

  const name = String(payload?.form?.name || "").trim();
  const slug = String(payload?.form?.slug || "").trim().toLowerCase();
  const placement = String(payload?.form?.placement || "popup");
  const ui = payload?.form?.ui ?? null;

  if (!name) return { ok: false, error: "Form name is required" };
  if (!slug || !/^[a-z0-9-]{2,60}$/.test(slug)) {
    return { ok: false, error: "Slug must be 2-60 chars (a-z, 0-9, -)" };
  }

  // slug unique per shop
  const conflict = await prisma.form.findFirst({
    where: { shopId, slug, NOT: { id } },
    select: { id: true },
  });
  if (conflict) return { ok: false, error: "Slug already used by another form" };

  const incomingFields: any[] = Array.isArray(payload?.fields) ? payload.fields : [];

  // Normalize + enforce unique nameKey + orderIndex
  const uniqueKeys = ensureUniqueNameKeys(
    incomingFields.map((f) => ({ id: String(f.id || ""), nameKey: String(f.nameKey || "field") }))
  );

  const normalizedFields = incomingFields.map((f, idx) => {
    const id = String(f.id || "");
    const nameKey = uniqueKeys[idx]?.nameKey ?? sanitizeNameKey(String(f.nameKey || "field"));
    const type = String(f.type || "text") as FieldType;

    const options = f.options && typeof f.options === "object" ? f.options : null;
    const validation = f.validation && typeof f.validation === "object" ? f.validation : null;

    return {
      id,
      type,
      label: String(f.label || "").trim() || "Untitled",
      nameKey,
      placeholder: f.placeholder ? String(f.placeholder) : null,
      helpText: f.helpText ? String(f.helpText) : null,
      required: Boolean(f.required),
      visible: Boolean(f.visible ?? true),
      orderIndex: idx,
      options,
      validation,
      errorMessage: f.errorMessage ? String(f.errorMessage) : null,
    };
  });

  await prisma.$transaction(async (tx) => {
    const form = await tx.form.findFirst({ where: { id, shopId }, select: { id: true } });
    if (!form) throw new Error("Form not found");

    await tx.form.update({
      where: { id },
      data: { name, slug, placement: placement as any, ui },
    });

    const existing = await tx.formField.findMany({
      where: { formId: id },
      select: { id: true },
    });
    const existingIds = new Set(existing.map((x) => x.id));
    const incomingIds = new Set(normalizedFields.map((x) => x.id).filter(Boolean));

    // delete removed
    const toDelete = [...existingIds].filter((fid) => !incomingIds.has(fid));
    if (toDelete.length) {
      await tx.formField.deleteMany({ where: { id: { in: toDelete } } });
    }

    // upsert (update existing, create new)
    for (const f of normalizedFields) {
      if (f.id && existingIds.has(f.id)) {
        await tx.formField.update({
          where: { id: f.id },
          data: {
            type: f.type as any,
            label: f.label,
            nameKey: f.nameKey,
            placeholder: f.placeholder,
            helpText: f.helpText,
            required: f.required,
            visible: f.visible,
            orderIndex: f.orderIndex,
            options: f.options,
            validation: f.validation,
            errorMessage: f.errorMessage,
          },
        });
      } else {
        await tx.formField.create({
          data: {
            formId: id,
            type: f.type as any,
            label: f.label,
            nameKey: f.nameKey,
            placeholder: f.placeholder,
            helpText: f.helpText,
            required: f.required,
            visible: f.visible,
            orderIndex: f.orderIndex,
            options: f.options,
            validation: f.validation,
            errorMessage: f.errorMessage,
          },
        });
      }
    }
  });

  return { ok: true };
};

function paletteDefaults(type: FieldType): FieldDTO {
  const base: FieldDTO = {
    id: `tmp_${Math.random().toString(36).slice(2)}`,
    type,
    label: "Untitled",
    nameKey: "field",
    placeholder: null,
    helpText: null,
    required: false,
    visible: true,
    orderIndex: 0,
    options: { visibleFor: ["individual", "installer", "company"] as RoleType[] },
    validation: null,
    errorMessage: null,
  };

  if (type === "email") return { ...base, label: "Email", nameKey: "email", placeholder: "email@example.com" };
  if (type === "tel") return { ...base, label: "Phone", nameKey: "phone", placeholder: "+213..." };
  if (type === "textarea") return { ...base, label: "Message", nameKey: "message", placeholder: "Write details..." };
  if (type === "number") return { ...base, label: "Quantity", nameKey: "qty", required: true, options: { ...base.options, min: 1, step: 1 } };
  if (type === "select") return { ...base, label: "Select", nameKey: "selectField", options: { ...base.options, items: [{ label: "Option 1", value: "option_1" }] } };
  if (type === "file") return { ...base, label: "Upload", nameKey: "upload", helpText: "Images or PDF", options: { ...base.options, accept: ["application/pdf", "image/*"], multiple: true } };
  return base;
}

function parseOptionsLines(raw: string) {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  return lines.map((line) => {
    // "Label|value" or "Label"
    const [labelPart, valuePart] = line.split("|").map((x) => x?.trim());
    const label = labelPart || "Option";
    const value =
      valuePart ||
      label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40) ||
      "option";
    return { label, value };
  });
}

export default function FormBuilderRoute() {
  const { form } = useLoaderData() as LoaderData;
  const saveFetcher = useFetcher();

  const [meta, setMeta] = useState(() => ({
    name: form.name,
    slug: form.slug,
    placement: form.placement,
  }));

  const [fields, setFields] = useState<FieldDTO[]>(() => form.fields);
  const [selectedId, setSelectedId] = useState<string>(() => form.fields[0]?.id || "");

  useEffect(() => {
    setMeta({ name: form.name, slug: form.slug, placement: form.placement });
    setFields(form.fields);
    setSelectedId(form.fields[0]?.id || "");
  }, [form.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = useMemo(() => fields.find((f) => f.id === selectedId) || null, [fields, selectedId]);

  function updateSelected(patch: Partial<FieldDTO>) {
    setFields((prev) => prev.map((f) => (f.id === selectedId ? ({ ...f, ...patch } as FieldDTO) : f)));
  }

  function addField(type: FieldType) {
    const f = paletteDefaults(type);
    // improve defaults
    const index = fields.length;
    f.orderIndex = index;
    f.nameKey = sanitizeNameKey(f.nameKey);
    setFields((prev) => [...prev, f]);
    setSelectedId(f.id);
  }

  function removeSelected() {
    if (!selectedId) return;
    setFields((prev) => prev.filter((f) => f.id !== selectedId).map((f, i) => ({ ...f, orderIndex: i })));
    setSelectedId((prev) => {
      const remaining = fields.filter((f) => f.id !== prev);
      return remaining[0]?.id || "";
    });
  }

  function move(from: number, to: number) {
    if (to < 0 || to >= fields.length) return;
    setFields((prev) => {
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next.map((f, i) => ({ ...f, orderIndex: i }));
    });
  }

  function saveAll() {
    const payload = {
      form: { ...meta, ui: form.ui ?? null },
      fields: fields.map((f, idx) => ({
        ...f,
        orderIndex: idx,
      })),
    };

    const fd = new FormData();
    fd.set("intent", "saveAll");
    fd.set("payload", JSON.stringify(payload));

    saveFetcher.submit(fd, { method: "post" });
  }

  const saveOk = (saveFetcher.data as any)?.ok;
  const saveErr = (saveFetcher.data as any)?.error;

  const visibleFor: RoleType[] = (selected?.options?.visibleFor as RoleType[]) || ["individual", "installer", "company"];

  const selectItemsText =
    selected?.type === "select" || selected?.type === "radio" || selected?.type === "multiselect"
      ? (selected?.options?.items || []).map((x: any) => (x?.value ? `${x.label}|${x.value}` : `${x.label}`)).join("\n")
      : "";

  return (
    <div className="lf-enter">
      <div className="lf-card lf-mb-4">
        <div className="lf-builder-top">
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <Link to="/app/forms" className="lf-pill" style={{ textDecoration: "none" }}>← Forms</Link>

            <div className="lf-badge" title="Status">
              <span className="lf-dot" />
              {form.isActive ? "Published" : form.status}
            </div>

            {saveOk ? <span className="lf-badge lf-badge--approved"><span className="lf-dot" />Saved</span> : null}
            {saveErr ? <span className="lf-badge lf-badge--rejected"><span className="lf-dot" />{String(saveErr)}</span> : null}
          </div>

          <div className="lf-btn-row">
            <button className="lf-pill lf-pill--primary" type="button" onClick={saveAll}>
              Save changes
            </button>
          </div>
        </div>

        <div className="lf-form-meta">
          <div className="lf-field">
            <div className="lf-field-label">Form name</div>
            <input className="lf-input" value={meta.name} onChange={(e) => setMeta((p) => ({ ...p, name: e.target.value }))} />
          </div>
          <div className="lf-field">
            <div className="lf-field-label">Slug</div>
            <input className="lf-input" value={meta.slug} onChange={(e) => setMeta((p) => ({ ...p, slug: e.target.value }))} />
          </div>
          <div className="lf-field">
            <div className="lf-field-label">Placement</div>
            <select className="lf-input lf-input--select" value={meta.placement} onChange={(e) => setMeta((p) => ({ ...p, placement: e.target.value }))}>
              <option value="popup">Popup</option>
              <option value="inline">Inline</option>
              <option value="slidein">Slide-in</option>
              <option value="landing">Landing</option>
            </select>
          </div>
        </div>
      </div>

      <div className="lf-builder">
        {/* Palette */}
        <div className="lf-builder-col">
          <div className="lf-card">
            <div className="lf-card-title">Field palette</div>
            <div className="lf-palette">
              {(
                ["text", "email", "tel", "number", "textarea", "select", "checkbox", "radio", "file", "date", "hidden"] as FieldType[]
              ).map((t) => (
                <button key={t} type="button" className="lf-pill" onClick={() => addField(t)}>
                  + {t}
                </button>
              ))}
            </div>

            <div className="lf-muted lf-mt-4">
              Note: installer/company required documents are enforced by <b>Roles → Requirements</b> (RoleRequirement), not by form fields.
            </div>
          </div>
        </div>

        {/* Canvas */}
        <div className="lf-builder-col lf-builder-col--wide">
          <div className="lf-card">
            <div className="lf-card-title">Canvas</div>

            {fields.length ? (
              <div className="lf-canvas">
                {fields
                  .slice()
                  .sort((a, b) => a.orderIndex - b.orderIndex)
                  .map((f, idx) => {
                    const active = f.id === selectedId;
                    return (
                      <div
                        key={f.id}
                        className={`lf-canvas-row ${active ? "is-active" : ""}`}
                        onClick={() => setSelectedId(f.id)}
                      >
                        <div className="lf-canvas-grip" title="Move">
                          <button type="button" className="lf-pill" onClick={(e) => { e.stopPropagation(); move(idx, idx - 1); }}>
                            ↑
                          </button>
                          <button type="button" className="lf-pill" onClick={(e) => { e.stopPropagation(); move(idx, idx + 1); }}>
                            ↓
                          </button>
                        </div>

                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 800, letterSpacing: "-0.02em" }}>
                            {f.label || "Untitled"} <span className="lf-muted">({f.type})</span>
                          </div>
                          <div className="lf-muted" style={{ marginTop: 4 }}>
                            nameKey: <b>{f.nameKey}</b>
                            {f.required ? " • required" : ""}
                            {!f.visible ? " • hidden" : ""}
                          </div>
                        </div>

                        <div style={{ display: "flex", gap: 8 }}>
                          <button
                            type="button"
                            className="lf-pill"
                            onClick={(e) => {
                              e.stopPropagation();
                              // duplicate
                              const copy = { ...f, id: `tmp_${Math.random().toString(36).slice(2)}`, orderIndex: fields.length };
                              setFields((prev) => [...prev, copy].map((x, i) => ({ ...x, orderIndex: i })));
                              setSelectedId(copy.id);
                            }}
                          >
                            Duplicate
                          </button>
                        </div>
                      </div>
                    );
                  })}
              </div>
            ) : (
              <div className="lf-muted">No fields yet. Add from palette.</div>
            )}
          </div>
        </div>

        {/* Inspector */}
        <div className="lf-builder-col">
          <div className="lf-card">
            <div className="lf-card-title">Field settings</div>

            {!selected ? (
              <div className="lf-muted">Select a field.</div>
            ) : (
              <>
                <div className="lf-inspector">
                  <div className="lf-field">
                    <div className="lf-field-label">Label</div>
                    <input className="lf-input" value={selected.label} onChange={(e) => updateSelected({ label: e.target.value })} />
                  </div>

                  <div className="lf-field">
                    <div className="lf-field-label">nameKey</div>
                    <input
                      className="lf-input"
                      value={selected.nameKey}
                      onChange={(e) => updateSelected({ nameKey: sanitizeNameKey(e.target.value) })}
                    />
                    <div className="lf-muted lf-mt-1">Used as the request payload key.</div>
                  </div>

                  <div className="lf-field">
                    <div className="lf-field-label">Placeholder</div>
                    <input className="lf-input" value={selected.placeholder ?? ""} onChange={(e) => updateSelected({ placeholder: e.target.value || null })} />
                  </div>

                  <div className="lf-field">
                    <div className="lf-field-label">Help text</div>
                    <input className="lf-input" value={selected.helpText ?? ""} onChange={(e) => updateSelected({ helpText: e.target.value || null })} />
                  </div>

                  <div className="lf-field">
                    <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <input type="checkbox" checked={selected.required} onChange={(e) => updateSelected({ required: e.target.checked })} />
                      <span style={{ fontWeight: 750 }}>Required</span>
                    </label>
                  </div>

                  <div className="lf-field">
                    <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <input type="checkbox" checked={selected.visible} onChange={(e) => updateSelected({ visible: e.target.checked })} />
                      <span style={{ fontWeight: 750 }}>Visible</span>
                    </label>
                  </div>

                  <div className="lf-field">
                    <div className="lf-field-label">Visible for roles</div>
                    <div className="lf-role-pills">
                      {(["individual", "installer", "company"] as RoleType[]).map((r) => {
                        const on = visibleFor.includes(r);
                        return (
                          <button
                            key={r}
                            type="button"
                            className={`lf-pill ${on ? "lf-pill--primary" : ""}`}
                            onClick={() => {
                              const next = on ? visibleFor.filter((x) => x !== r) : [...visibleFor, r];
                              const nextOptions = { ...(selected.options || {}), visibleFor: next.length ? next : ["individual", "installer", "company"] };
                              updateSelected({ options: nextOptions });
                            }}
                          >
                            {r}
                          </button>
                        );
                      })}
                    </div>
                    <div className="lf-muted lf-mt-1">Stored in field.options.visibleFor.</div>
                  </div>

                  {(selected.type === "select" || selected.type === "radio" || selected.type === "multiselect") ? (
                    <div className="lf-field">
                      <div className="lf-field-label">Options (one per line)</div>
                      <textarea
                        className="lf-input"
                        style={{ borderRadius: 14, minHeight: 160 }}
                        value={selectItemsText}
                        onChange={(e) => {
                          const items = parseOptionsLines(e.target.value);
                          updateSelected({ options: { ...(selected.options || {}), items } });
                        }}
                        placeholder={"Option 1|option_1\nOption 2|option_2"}
                      />
                    </div>
                  ) : null}

                  {selected.type === "file" ? (
                    <div className="lf-field">
                      <div className="lf-field-label">File settings</div>
                      <div className="lf-muted">This is an extra upload field (not the installer/company required docs).</div>

                      <label style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10 }}>
                        <input
                          type="checkbox"
                          checked={Boolean(selected.options?.multiple)}
                          onChange={(e) => updateSelected({ options: { ...(selected.options || {}), multiple: e.target.checked } })}
                        />
                        <span style={{ fontWeight: 750 }}>Allow multiple</span>
                      </label>
                    </div>
                  ) : null}

                  <div className="lf-btn-row lf-mt-4" style={{ justifyContent: "space-between" }}>
                    <button className="lf-pill lf-pill--danger" type="button" onClick={removeSelected}>
                      Delete field
                    </button>
                    <button className="lf-pill lf-pill--primary" type="button" onClick={saveAll}>
                      Save
                    </button>
                  </div>

                  <details className="lf-details lf-mt-4">
                    <summary>Debug JSON</summary>
                    <pre style={{ margin: 0, marginTop: 10, overflow: "auto" }}>
                      <code>{JSON.stringify(selected, null, 2)}</code>
                    </pre>
                  </details>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
