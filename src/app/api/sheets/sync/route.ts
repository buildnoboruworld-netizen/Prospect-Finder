import { NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { isSheetsConfigured, syncAllTabs } from "@/lib/sheets";

// POST — admin-triggered "Sync now" (also usable from scripts with a session).
export async function POST() {
  const user = await getAppUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (user.role !== "admin") {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }
  if (!isSheetsConfigured()) {
    return NextResponse.json(
      { error: "Sheets sync not configured" },
      { status: 503 }
    );
  }

  const result = await syncAllTabs();
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}

// GET — Vercel nightly cron (PRD §9: nightly full re-sync).
// vercel.json schedules this; Vercel sends Authorization: Bearer $CRON_SECRET.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isSheetsConfigured()) {
    return NextResponse.json(
      { error: "Sheets sync not configured" },
      { status: 503 }
    );
  }

  const result = await syncAllTabs();
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
