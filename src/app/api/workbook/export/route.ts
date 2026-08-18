import { NextResponse } from "next/server";
import { z } from "zod";
import { getAppUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { buildBlankTemplate, buildEnrichmentWorkbook } from "@/lib/workbook/export";

// Download half of the manual enrichment loop (CLAUDE.md, 18 Aug 2026):
//   GET /api/workbook/export?industry=<uuid>  → that industry's companies with
//                                               the contact columns left blank
//   GET /api/workbook/export?template=blank   → header row only, for companies
//                                               the tool never found
//
// A route rather than a server action because this has to be a real browser
// navigation: server actions return values to JavaScript, and the browser only
// saves a file when it receives one with Content-Disposition on a plain <a>.

// Zipping a workbook for a large industry reads every company and contact in
// it; the platform default leaves no headroom for the biggest ones.
export const maxDuration = 60;

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const uuidSchema = z.uuid();

/**
 * Content-Disposition headers are ASCII-only, so an industry named with any
 * non-ASCII character needs both forms: a stripped `filename` every browser
 * understands, and `filename*` for the real one.
 */
function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7E]/g, "-").replace(/["\\]/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(
    fileName
  )}`;
}

function xlsxResponse(buffer: Buffer, fileName: string): NextResponse {
  // Hand over the bytes rather than the Buffer: BodyInit is typed against
  // ArrayBufferView, which node's Buffer generic does not always satisfy.
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": XLSX_MIME,
      "Content-Disposition": contentDisposition(fileName),
      "Content-Length": String(buffer.byteLength),
      // Per-user and always-fresh: a cached copy would send someone off to buy
      // RocketReach lookups for companies that already have contacts.
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(request: Request) {
  const user = await getAppUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const today = new Date().toISOString().slice(0, 10);

  try {
    if (params.get("template") === "blank") {
      // No industry to scope: the template carries the full code list so the
      // person picks the industry per row as they type companies in.
      return xlsxResponse(
        await buildBlankTemplate(),
        `Noboru new companies ${today}.xlsx`
      );
    }

    const industryId = params.get("industry");
    if (!industryId || !uuidSchema.safeParse(industryId).success) {
      return NextResponse.json(
        {
          error:
            "Add ?industry=<industry id>, or ?template=blank for an empty workbook.",
        },
        { status: 400 }
      );
    }

    const supabase = await createClient();
    const { data: industryRow } = await supabase
      .from("industries")
      .select("id, name")
      .eq("id", industryId)
      .maybeSingle();
    const industry = industryRow as { id: string; name: string } | null;
    if (!industry) {
      return NextResponse.json({ error: "Industry not found" }, { status: 404 });
    }

    // Uploads are scoped to your own allotted industries, so downloads are too.
    // Handing over a teammate's list would only produce a workbook whose every
    // row the importer refuses.
    if (user.role !== "admin") {
      const { data: assignment } = await supabase
        .from("assignments")
        .select("id")
        .eq("user_id", user.id)
        .eq("industry_id", industry.id)
        .eq("active", true)
        .maybeSingle();
      if (!assignment) {
        return NextResponse.json(
          { error: "You are not assigned to this industry." },
          { status: 403 }
        );
      }
    }

    return xlsxResponse(
      await buildEnrichmentWorkbook(industry.id),
      `Noboru ${industry.name} enrichment ${today}.xlsx`
    );
  } catch (e) {
    // buildWorkbook throws rather than shipping a workbook with a missing
    // industry-code list — a silent one would make every new-company row
    // unsaveable on the way back.
    return NextResponse.json(
      {
        error: `Could not build the workbook: ${
          e instanceof Error ? e.message : "unknown error"
        }`,
      },
      { status: 500 }
    );
  }
}
