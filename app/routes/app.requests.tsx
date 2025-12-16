import type { LoaderFunctionArgs } from "react-router";
import { Link } from "react-router";
import { authenticate } from "~/shopify.server";
import { AdminPage } from "~/ui/AdminPage";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function Requests() {
  return (
    <AdminPage title="Requests">
      <div className="lf-grid">
        <div className="lf-col-12">
          <div className="lf-card">
            <div className="lf-card-heading">All requests</div>
            <div className="lf-muted lf-mt-2">
              Next step: load requests from Prisma and add filters + status.
            </div>

            <div className="lf-mt-4">
              <table className="lf-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Status</th>
                    <th>Customer</th>
                    <th>Wilaya</th>
                    <th>Created</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="lf-row-hover">
                    <td className="lf-muted">demo_001</td>
                    <td>
                      <span className="lf-badge lf-badge--pending">
                        <span className="lf-dot" />
                        Pending
                      </span>
                    </td>
                    <td>Demo Customer</td>
                    <td className="lf-muted">16</td>
                    <td className="lf-muted">—</td>
                    <td style={{ textAlign: "right" }}>
                      <Link to="/app/requests/demo_001">Open</Link>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="lf-mt-4 lf-muted">
              Tip: This is the UI shell. We will replace the demo row with real DB data.
            </div>
          </div>
        </div>
      </div>
    </AdminPage>
  );
}
