"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { syncSheetsNow } from "@/app/actions/companies";

export function SyncNowButton() {
  const [pending, startTransition] = useTransition();

  function run() {
    startTransition(async () => {
      const result = await syncSheetsNow();
      if (result.ok) toast.success(result.message ?? "Synced.");
      else toast.error(result.error);
    });
  }

  return (
    <Button onClick={run} disabled={pending} variant="outline" size="sm">
      {pending ? "Syncing…" : "Sync sheet now"}
    </Button>
  );
}
