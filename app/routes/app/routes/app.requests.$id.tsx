import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, Link } from "react-router";
import { authenticate } from "~/shopify.server";
import { AdminPage } from "~/ui/AdminPage";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return { id: params.id || "" };
};

export default function RequestDetail() {
  const { id } = useLoaderData<typeof loader>();

  return (
    <AdminPage
      title={`Request ${id}`}
      primaryAction={<s-button href="/app/requests">Back to Requests</s-button>}
    >
      <div className="lf-grid">
        <div className="lf-col-8">
          <div className="lf-card">
            <div className="lf-card-heading">Request details</div>
            <div className="lf-muted lf-mt-2">
              Next step: load full request + items + attachments from Prisma.
            </div>

            <div className="lf-mt-4">
              <div className="lf-card-title">Status</div>
              <span className="lf-badge lf-badge--pending">
                <span className="lf-dot" />
                Pending
              </span>
            </div>

            <div className="lf-mt-4">
              <div className="lf-card-title">Customer</div>
              <div>—</div>
            </div>
          </div>
        </div>

        <div className="lf-col-4">
          <div className="lf-card">
            <div className="lf-card-heading">Actions</div>
            <div className="lf-muted lf-mt-2">Workflow actions will go here.</div>

            <div className="lf-mt-4 lf-btn-row">
              <button className="lf-pill lf-pill--success" type="button">
                Mark Approved
              </button>
              <button className="lf-pill" type="button">
                Mark Rejected
              </button>
            </div>

            <div className="lf-mt-4 lf-muted">
              <Link to="/app/requests">← Back</Link>
            </div>
          </div>
        </div>
      </div>
    </AdminPage>
  );
}
