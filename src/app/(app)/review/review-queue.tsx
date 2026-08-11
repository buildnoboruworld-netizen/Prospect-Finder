"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { approveCompany, rejectCompany } from "@/app/actions/companies";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { SampleDataBadge } from "@/components/sample-data-badge";
import { ChannelBadge, PresenceBadge } from "@/components/status-badge";
import type {
  CompanySource,
  ConfidenceLevel,
  Contact,
  DigitalPresence,
} from "@/lib/types";
import { cn } from "@/lib/utils";

export interface ReviewLead {
  id: string;
  name: string;
  domain: string | null;
  instagram_handle: string | null;
  ig_followers_band: string | null;
  city: string | null;
  revenue_estimate: string | null;
  funding_stage: string | null;
  shark_tank_status: string | null;
  digital_presence: DigitalPresence | null;
  fit_score: number | null;
  confidence: ConfidenceLevel | null;
  hook: string | null;
  sources: CompanySource[];
  is_sample: boolean;
  created_by_run: string | null;
  industry_name: string | null;
  contacts: Contact[];
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function ReviewQueue({ leads: initial }: { leads: ReviewLead[] }) {
  const [leads, setLeads] = useState(initial);
  const [index, setIndex] = useState(0);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();

  const cardRefs = useRef<Array<HTMLDivElement | null>>([]);
  const navigated = useRef(false);

  const count = leads.length;
  // Clamped at render rather than stored clamped, so removing a card slides the
  // next one under the cursor without a second state write.
  const activeIndex = count === 0 ? -1 : Math.min(index, count - 1);
  const active = activeIndex >= 0 ? leads[activeIndex] : null;

  const dismiss = useCallback((id: string) => {
    setLeads((prev) => prev.filter((lead) => lead.id !== id));
  }, []);

  const approve = useCallback(
    (lead: ReviewLead) => {
      if (lead.is_sample) {
        toast.error("Sample data can't be approved — it never leaves this app.");
        return;
      }
      if (lead.sources.length === 0) {
        toast.error("No source URL — a lead without a source can't be approved.");
        return;
      }
      startTransition(async () => {
        const result = await approveCompany(lead.id);
        if (result.ok) {
          toast.success(result.message ?? "Approved.");
          dismiss(lead.id);
        } else {
          toast.error(result.error);
        }
      });
    },
    [dismiss]
  );

  function submitReject() {
    const target = leads.find((lead) => lead.id === rejectId);
    if (!target) return;
    startTransition(async () => {
      const result = await rejectCompany({ id: target.id, reason });
      if (result.ok) {
        toast.success(result.message ?? "Rejected.");
        dismiss(target.id);
        setRejectId(null);
        setReason("");
      } else {
        toast.error(result.error);
      }
    });
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (rejectId !== null) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")
      ) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "j" || key === "arrowdown") {
        event.preventDefault();
        navigated.current = true;
        setIndex(Math.min(activeIndex + 1, count - 1));
      } else if (key === "k" || key === "arrowup") {
        event.preventDefault();
        navigated.current = true;
        setIndex(Math.max(activeIndex - 1, 0));
      } else if (key === "a" && active) {
        event.preventDefault();
        approve(active);
      } else if (key === "r" && active) {
        event.preventDefault();
        setRejectId(active.id);
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, activeIndex, approve, count, rejectId]);

  useEffect(() => {
    if (activeIndex < 0) return;
    const el = cardRefs.current[activeIndex];
    if (!el) return;
    el.scrollIntoView({ block: "nearest" });
    // Only steal focus once the reviewer has actually started navigating.
    if (navigated.current) el.focus({ preventScroll: true });
  }, [activeIndex]);

  if (count === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <p className="font-medium">Nothing waiting for review.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Drafted leads land here after a research run.{" "}
            <Link href="/pipeline" className="underline">
              Open the pipeline
            </Link>{" "}
            to see everything already decided.
          </p>
        </CardContent>
      </Card>
    );
  }

  const rejectTarget = leads.find((lead) => lead.id === rejectId) ?? null;

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        <kbd className="rounded border px-1 font-mono">j</kbd> /{" "}
        <kbd className="rounded border px-1 font-mono">k</kbd> move ·{" "}
        <kbd className="rounded border px-1 font-mono">a</kbd> approve ·{" "}
        <kbd className="rounded border px-1 font-mono">r</kbd> reject · card{" "}
        {activeIndex + 1} of {count}
      </p>

      {leads.map((lead, i) => {
        const isActive = i === activeIndex;
        const noSources = lead.sources.length === 0;
        return (
          <Card
            key={lead.id}
            ref={(el) => {
              cardRefs.current[i] = el;
            }}
            tabIndex={-1}
            aria-current={isActive ? "true" : undefined}
            onClick={() => setIndex(i)}
            className={cn(
              "outline-none transition-shadow",
              isActive && "ring-2 ring-primary"
            )}
          >
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/companies/${lead.id}`}
                  className="font-heading text-base font-medium hover:underline"
                >
                  {lead.name}
                </Link>
                {lead.is_sample && <SampleDataBadge />}
                <Badge variant="secondary">
                  fit {lead.fit_score ?? "—"}/5
                </Badge>
                <PresenceBadge presence={lead.digital_presence} />
                {lead.confidence && (
                  <Badge variant="outline">{lead.confidence} confidence</Badge>
                )}
                {lead.industry_name && (
                  <span className="text-xs text-muted-foreground">
                    {lead.industry_name}
                  </span>
                )}
              </div>
            </CardHeader>

            <CardContent className="space-y-4">
              <dl className="grid gap-4 sm:grid-cols-4">
                <Field label="Website">
                  {lead.domain ? (
                    <a
                      href={`https://${lead.domain}`}
                      target="_blank"
                      rel="noreferrer"
                      className="break-all underline"
                    >
                      {lead.domain}
                    </a>
                  ) : (
                    "—"
                  )}
                </Field>
                <Field label="Instagram">
                  {lead.instagram_handle ? (
                    <a
                      href={`https://instagram.com/${lead.instagram_handle.replace(/^@/, "")}`}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      @{lead.instagram_handle.replace(/^@/, "")}
                    </a>
                  ) : (
                    "—"
                  )}
                </Field>
                <Field label="City">{lead.city ?? "—"}</Field>
                <Field label="IG followers">{lead.ig_followers_band ?? "—"}</Field>
                <Field label="Revenue estimate">
                  {lead.revenue_estimate ?? "—"}
                </Field>
                <Field label="Funding stage">{lead.funding_stage ?? "—"}</Field>
                <Field label="Shark Tank">{lead.shark_tank_status ?? "—"}</Field>
                <Field label="From run">
                  {lead.created_by_run ? (
                    <Link
                      href={`/runs/${lead.created_by_run}`}
                      className="underline"
                    >
                      view run
                    </Link>
                  ) : (
                    "manual"
                  )}
                </Field>
              </dl>

              {lead.hook && (
                <>
                  <Separator />
                  <Field label="Discovery-gap hook">{lead.hook}</Field>
                </>
              )}

              <Separator />
              <Field label={`Sources (${lead.sources.length})`}>
                {noSources ? (
                  <span className="text-destructive">
                    None — this lead cannot be approved.
                  </span>
                ) : (
                  <ul className="space-y-1">
                    {lead.sources.map((source, si) => (
                      <li key={si}>
                        <a
                          href={source.url}
                          target="_blank"
                          rel="noreferrer"
                          className="break-all text-sm underline"
                          title={source.url}
                        >
                          {hostOf(source.url)}
                        </a>
                        {source.note && (
                          <span className="text-xs text-muted-foreground">
                            {" "}
                            — {source.note}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Field>

              <Separator />
              <Field label="Contacts">
                {lead.contacts.length === 0 ? (
                  <span className="text-muted-foreground">
                    → enrich (nothing was published on the brand&apos;s own
                    pages — research never guesses an address)
                  </span>
                ) : (
                  <ul className="space-y-1">
                    {lead.contacts.map((contact) => (
                      <li key={contact.id} className="text-sm">
                        <span className="font-medium">
                          {contact.full_name ?? "—"}
                        </span>
                        {contact.designation && (
                          <span className="text-muted-foreground">
                            {" "}
                            · {contact.designation}
                          </span>
                        )}
                        {contact.email && (
                          <span>
                            {" "}
                            · {contact.email}
                            <ChannelBadge status={contact.email_status} />
                          </span>
                        )}
                        {contact.phone && (
                          <span>
                            {" "}
                            · {contact.phone}
                            <ChannelBadge status={contact.phone_status} />
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Field>
            </CardContent>

            <CardFooter className="flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => approve(lead)}
                disabled={pending || lead.is_sample || noSources}
                title={
                  lead.is_sample
                    ? "Sample data can't be approved."
                    : noSources
                      ? "A lead needs at least one source URL."
                      : undefined
                }
              >
                Approve
                <span className="ml-1 text-[10px] opacity-70">a</span>
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => setRejectId(lead.id)}
                disabled={pending}
              >
                Reject
                <span className="ml-1 text-[10px] opacity-70">r</span>
              </Button>
              <Button asChild size="sm" variant="ghost">
                <Link href={`/companies/${lead.id}`}>Open full record →</Link>
              </Button>
            </CardFooter>
          </Card>
        );
      })}

      <Dialog
        open={rejectTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRejectId(null);
            setReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject {rejectTarget?.name ?? "this lead"}</DialogTitle>
            <DialogDescription>
              The reason is remembered — rejected companies never resurface in a
              run or a manual add (only an admin can un-reject).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reject-reason">Reason *</Label>
            <Textarea
              id="reject-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Too big for the retainer / not D2C / already has an agency…"
              rows={3}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="destructive"
              onClick={submitReject}
              disabled={pending || reason.trim().length < 3}
            >
              {pending ? "Rejecting…" : "Reject lead"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {leads.some((lead) => lead.is_sample) && (
        <Alert className="border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-100">
          <AlertTitle>Some cards above are sample data</AlertTitle>
          <AlertDescription className="text-amber-900 dark:text-amber-200">
            Anything carrying the amber SAMPLE badge came from the demo
            provider. It cannot be approved or synced — reject it once you are
            done looking.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
