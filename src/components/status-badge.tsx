import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { CompanyStatus, ContactChannelStatus, DigitalPresence } from "@/lib/types";

const STATUS_STYLES: Record<CompanyStatus, string> = {
  draft: "bg-muted text-muted-foreground border-transparent",
  approved: "bg-emerald-100 text-emerald-900 border-transparent dark:bg-emerald-900/40 dark:text-emerald-200",
  rejected: "bg-red-100 text-red-900 border-transparent dark:bg-red-900/40 dark:text-red-200",
  enriched: "bg-violet-100 text-violet-900 border-transparent dark:bg-violet-900/40 dark:text-violet-200",
  synced: "bg-sky-100 text-sky-900 border-transparent dark:bg-sky-900/40 dark:text-sky-200",
};

export function StatusBadge({ status }: { status: CompanyStatus }) {
  return <Badge className={cn(STATUS_STYLES[status])}>{status}</Badge>;
}

const PRESENCE_LABELS: Record<DigitalPresence, string> = {
  WEB_ACTIVE: "Web active",
  WEB_THIN: "Web thin",
  AMAZON_ONLY: "Amazon only",
  IG_ONLY: "IG only",
  NONE: "No presence",
};

export function PresenceBadge({ presence }: { presence: DigitalPresence | null }) {
  if (!presence) return <span className="text-muted-foreground">—</span>;
  return <Badge variant="outline">{PRESENCE_LABELS[presence]}</Badge>;
}

const CHANNEL_STYLES: Record<ContactChannelStatus, string> = {
  verified: "bg-emerald-100 text-emerald-900 border-transparent dark:bg-emerald-900/40 dark:text-emerald-200",
  public_generic: "bg-amber-100 text-amber-900 border-transparent dark:bg-amber-900/40 dark:text-amber-200",
  unknown: "bg-muted text-muted-foreground border-transparent",
};

export function ChannelBadge({ status }: { status: ContactChannelStatus }) {
  if (status === "unknown") return null;
  return (
    <Badge className={cn("ml-1", CHANNEL_STYLES[status])}>
      {status === "public_generic" ? "public" : status}
    </Badge>
  );
}
