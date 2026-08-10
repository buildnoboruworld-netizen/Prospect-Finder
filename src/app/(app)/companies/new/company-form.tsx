"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { checkDuplicates, createCompany } from "@/app/actions/companies";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/status-badge";
import type { DuplicateCheckResult, DuplicateMatch } from "@/lib/types";
import {
  confidenceValues,
  digitalPresenceValues,
} from "@/lib/schemas";

function DuplicateCard({ match, label }: { match: DuplicateMatch; label: string }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Already exists — {label}</AlertTitle>
      <AlertDescription>
        <div className="space-y-1">
          <p>
            <Link href={`/companies/${match.id}`} className="font-medium underline">
              {match.name}
            </Link>{" "}
            <StatusBadge status={match.status} /> · owned by{" "}
            <span className="font-medium">{match.owner_name ?? "unknown"}</span>
            {match.industry_name ? ` · ${match.industry_name}` : ""}
          </p>
          {match.status === "rejected" && match.rejected_reason && (
            <p className="text-xs">
              Rejected earlier: “{match.rejected_reason}” — rejected companies
              stay excluded unless an admin un-rejects.
            </p>
          )}
          <p className="text-xs">
            New contacts should be attached to the existing company — never a
            second row.
          </p>
        </div>
      </AlertDescription>
    </Alert>
  );
}

export function CompanyForm({
  industries,
  defaultIndustryId,
}: {
  industries: { id: string; name: string }[];
  defaultIndustryId?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [industryId, setIndustryId] = useState(
    defaultIndustryId && industries.some((i) => i.id === defaultIndustryId)
      ? defaultIndustryId
      : industries[0]?.id ?? ""
  );
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [instagram, setInstagram] = useState("");
  const [city, setCity] = useState("");
  const [followersBand, setFollowersBand] = useState("");
  const [revenue, setRevenue] = useState("");
  const [funding, setFunding] = useState("");
  const [sharkTank, setSharkTank] = useState("");
  const [presence, setPresence] = useState<string>("");
  const [fit, setFit] = useState<string>("");
  const [confidence, setConfidence] = useState<string>("");
  const [hook, setHook] = useState("");
  const [sourcesText, setSourcesText] = useState("");

  const [dup, setDup] = useState<DuplicateCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirmNotDuplicate, setConfirmNotDuplicate] = useState(false);
  const checkSeq = useRef(0);

  // Live dedup — PRD §7 enforcement point 3 (check-as-you-type)
  useEffect(() => {
    const seq = ++checkSeq.current;
    const t = setTimeout(async () => {
      if (!name.trim() && !domain.trim() && !instagram.trim()) {
        setDup(null);
        setChecking(false);
        return;
      }
      setChecking(true);
      const result = await checkDuplicates({
        name: name.trim() || undefined,
        domain: domain.trim() || undefined,
        instagram: instagram.trim() || undefined,
        city: city.trim() || undefined,
      });
      if (seq !== checkSeq.current) return; // stale response
      setChecking(false);
      if (result.ok) {
        setDup(result.data);
        setConfirmNotDuplicate(false);
      }
    }, 450);
    return () => clearTimeout(t);
  }, [name, domain, instagram, city]);

  const exactMatch = dup?.domain_match ?? dup?.instagram_match ?? null;
  const fuzzyMatches = dup?.fuzzy_matches ?? [];
  const blocked = Boolean(exactMatch);
  const needsConfirm = fuzzyMatches.length > 0 && !confirmNotDuplicate;

  function buildValues() {
    const sources = sourcesText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((url) => ({ url }));
    return {
      industry_id: industryId,
      name,
      domain,
      instagram_handle: instagram,
      city,
      ig_followers_band: followersBand,
      revenue_estimate: revenue,
      funding_stage: funding,
      shark_tank_status: sharkTank,
      digital_presence: presence || undefined,
      fit_score: fit ? Number(fit) : undefined,
      confidence: confidence || undefined,
      hook,
      sources,
    };
  }

  function submit(approveNow: boolean) {
    startTransition(async () => {
      const result = await createCompany({
        values: buildValues(),
        confirmNotDuplicate,
        approveNow,
      });
      if (result.ok) {
        toast.success(
          result.message ?? (approveNow ? "Saved & approved." : "Saved as draft.")
        );
        router.push(`/companies/${result.data.id}`);
      } else {
        if (result.duplicate) setDup(result.duplicate);
        toast.error(result.error);
      }
    });
  }

  return (
    <Card>
      <CardContent className="space-y-5 pt-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="industry">Industry *</Label>
            <Select value={industryId} onValueChange={setIndustryId}>
              <SelectTrigger id="industry">
                <SelectValue placeholder="Pick an industry" />
              </SelectTrigger>
              <SelectContent>
                {industries.map((i) => (
                  <SelectItem key={i.id} value={i.id}>
                    {i.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {industries.length === 0 && (
              <p className="text-xs text-destructive">
                No industries allotted to you yet — ask Pragaman.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="name">Company name *</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Mille Millets"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="city">City</Label>
            <Input
              id="city"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder="Bengaluru"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="domain">Website domain</Label>
            <Input
              id="domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="brand.com"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="instagram">Instagram handle</Label>
            <Input
              id="instagram"
              value={instagram}
              onChange={(e) => setInstagram(e.target.value)}
              placeholder="@brand.in"
            />
          </div>
        </div>

        {checking && (
          <p className="text-xs text-muted-foreground">Checking duplicates…</p>
        )}
        {exactMatch && (
          <DuplicateCard
            match={exactMatch}
            label={dup?.domain_match ? "same domain" : "same Instagram handle"}
          />
        )}
        {!exactMatch && fuzzyMatches.length > 0 && (
          <Alert>
            <AlertTitle>Possible duplicate — please confirm</AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-1 pl-4">
                {fuzzyMatches.map((m) => (
                  <li key={m.id}>
                    <Link href={`/companies/${m.id}`} className="underline">
                      {m.name}
                    </Link>{" "}
                    ({Math.round((m.similarity ?? 0) * 100)}% similar
                    {m.city ? `, ${m.city}` : ""}) — owned by{" "}
                    {m.owner_name ?? "unknown"}, {m.status}
                  </li>
                ))}
              </ul>
              <label className="mt-2 flex items-center gap-2 text-sm font-medium">
                <Checkbox
                  checked={confirmNotDuplicate}
                  onCheckedChange={(v) => setConfirmNotDuplicate(v === true)}
                />
                This is a different company — save anyway
              </label>
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label>Digital presence</Label>
            <Select value={presence} onValueChange={setPresence}>
              <SelectTrigger>
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {digitalPresenceValues.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Fit score</Label>
            <Select value={fit} onValueChange={setFit}>
              <SelectTrigger>
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {[1, 2, 3, 4, 5].map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}/5
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Confidence</Label>
            <Select value={confidence} onValueChange={setConfidence}>
              <SelectTrigger>
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {confidenceValues.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="followers">IG followers band</Label>
            <Input
              id="followers"
              value={followersBand}
              onChange={(e) => setFollowersBand(e.target.value)}
              placeholder="10k–50k"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="revenue">Revenue estimate</Label>
            <Input
              id="revenue"
              value={revenue}
              onChange={(e) => setRevenue(e.target.value)}
              placeholder="₹2–5Cr"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="funding">Funding stage</Label>
            <Input
              id="funding"
              value={funding}
              onChange={(e) => setFunding(e.target.value)}
              placeholder="Bootstrapped"
            />
          </div>
          <div className="space-y-2 sm:col-span-3">
            <Label htmlFor="sharktank">Shark Tank status</Label>
            <Input
              id="sharktank"
              value={sharkTank}
              onChange={(e) => setSharkTank(e.target.value)}
              placeholder="S3 pitch, no deal (optional)"
            />
          </div>
          <div className="space-y-2 sm:col-span-3">
            <Label htmlFor="hook">Discovery-gap hook</Label>
            <Textarea
              id="hook"
              value={hook}
              onChange={(e) => setHook(e.target.value)}
              placeholder="One line on why they need organic discovery help"
              rows={2}
            />
          </div>
          <div className="space-y-2 sm:col-span-3">
            <Label htmlFor="sources">Source URLs (one per line)</Label>
            <Textarea
              id="sources"
              value={sourcesText}
              onChange={(e) => setSourcesText(e.target.value)}
              placeholder={"https://instagram.com/brand.in\nhttps://yourstory.com/…"}
              rows={3}
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            onClick={() => submit(false)}
            disabled={pending || blocked || needsConfirm || !industryId || !name.trim()}
          >
            {pending ? "Saving…" : "Save draft"}
          </Button>
          <Button
            variant="secondary"
            onClick={() => submit(true)}
            disabled={pending || blocked || needsConfirm || !industryId || !name.trim()}
          >
            Save & approve
          </Button>
          {blocked && (
            <p className="text-sm text-destructive">
              Blocked: this company already exists.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
