import { desc, ilike } from "drizzle-orm";
import { headers } from "next/headers";
import { db, schema } from "@/db";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";

const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

export async function GET(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session || session.user.role !== "admin") return new Response("Forbidden", { status: 403 });
  const type = new URL(req.url).searchParams.get("type");
  const rows = await db
    .select()
    .from(schema.activityEvents)
    .where(type ? ilike(schema.activityEvents.type, `${type}%`) : undefined)
    .orderBy(desc(schema.activityEvents.id))
    .limit(50_000);
  const header = "id,created_at,type,actor_id,impersonator_id,organization_id,project_id,ip,payload\n";
  const body = rows
    .map((r) =>
      [r.id, r.createdAt.toISOString(), r.type, r.actorId, r.impersonatorId, r.organizationId, r.projectId, r.ip, JSON.stringify(r.payload)]
        .map(esc)
        .join(","),
    )
    .join("\n");
  return new Response(header + body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="activity-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
