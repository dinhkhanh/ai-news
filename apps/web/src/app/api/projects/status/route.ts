import { NextResponse, type NextRequest } from "next/server";
import { isUuid, loadProjectStatuses } from "@/lib/project-status";
import { getWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * GET /api/projects/status?ids=<uuid>[,<uuid>...]
 * Polled by <PipelineStatus> and <ProjectsWatcher> while a pipeline step or a
 * publication runs. Org-scoped through RLS; ids outside the workspace are
 * simply absent from the answer.
 */
export async function GET(req: NextRequest) {
  const ws = await getWorkspace();
  if (!ws) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const ids = (req.nextUrl.searchParams.get("ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(isUuid)
    .slice(0, 100);
  if (!ids.length) return NextResponse.json({ error: "ids required" }, { status: 400 });
  const projects = await loadProjectStatuses(ws, ids);
  return NextResponse.json({ projects, now: new Date().toISOString() }, { headers: { "cache-control": "no-store" } });
}
