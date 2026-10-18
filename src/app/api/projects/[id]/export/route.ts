import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/features/auth/actions";
import { generateProjectZip } from "@/server/export/zip-export";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: projectId } = await params;
    const { searchParams } = new URL(request.url);
    const revisionId = searchParams.get("revisionId") || undefined;

    const { filename, buffer } = await generateProjectZip({
      projectId,
      revisionId,
      userId: user.id,
    });

    const body = new Uint8Array(buffer);

    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": buffer.length.toString(),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to export project";
    const status = message.includes("Unauthorized") ? 401 : message.includes("not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
