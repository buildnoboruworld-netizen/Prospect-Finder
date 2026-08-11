"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { startRun } from "@/app/actions/runs";
import { Button } from "@/components/ui/button";

/**
 * Starts a research run and hands off to the run view, which drives the
 * stage loop. Disabled when the engine has no provider/search configured —
 * the tooltip carries the reason so nobody has to read the server log.
 */
export function RunResearchButton({
  industryId,
  disabledReason,
}: {
  industryId: string;
  disabledReason: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function run() {
    startTransition(async () => {
      const result = await startRun({ industryId });
      if (result.ok) {
        router.push(`/runs/${result.data.id}`);
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Button
      size="sm"
      onClick={run}
      disabled={pending || disabledReason !== null}
      title={disabledReason ?? undefined}
    >
      {pending ? "Starting…" : "Run research"}
    </Button>
  );
}
