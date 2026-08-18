import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// Amber, never lime. Brand primary means "good / active"; sample data has to
// read as a warning — and white-on-lime already fails contrast (CLAUDE.md).
const AMBER_BADGE =
  "border-transparent bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200";

const AMBER_ALERT =
  "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-100";

const MEANING =
  "Replayed fixture data — no research was performed. Sample leads cannot be approved and never reach the Google Sheet.";

/**
 * Goes on the CARD, not only in page chrome. Cards get screenshotted and
 * pasted into chat, and a lead that leaves this app without the badge is
 * indistinguishable from real research.
 */
export function SampleDataBadge({ className }: { className?: string }) {
  return (
    <Badge className={cn(AMBER_BADGE, className)} title={MEANING}>
      SAMPLE
    </Badge>
  );
}

/**
 * Page-level statement of the same fact, so the wording lives in one place.
 *
 * The fixtures are a single industry's brands replayed for whatever industry
 * was run, so this has to say so: a Hair Care run on a misconfigured
 * deployment produced five millet brands, and only this notice explained why.
 */
export function SampleDataNotice({ className }: { className?: string }) {
  return (
    <Alert className={cn(AMBER_ALERT, className)}>
      <AlertTitle>Sample data — no research was performed</AlertTitle>
      <AlertDescription className="text-amber-900 dark:text-amber-200">
        Everything below is replayed from fixtures by the demo provider, and the
        fixtures are millet brands regardless of which industry was run — so the
        companies below are illustrative only, not findings about this industry.
        To run real research, set <code className="font-mono text-xs">RESEARCH_PROVIDER</code>{" "}
        and that provider&apos;s API key in the environment, then redeploy.
        Sample leads cannot be approved and are excluded from the team&apos;s
        Google Sheet.
      </AlertDescription>
    </Alert>
  );
}
