"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { updateCompany } from "@/app/actions/companies";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
import { confidenceValues, digitalPresenceValues } from "@/lib/schemas";
import type { Company } from "@/lib/types";

export function EditCompanyDialog({ company }: { company: Company }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const [name, setName] = useState(company.name);
  const [domain, setDomain] = useState(company.domain ?? "");
  const [instagram, setInstagram] = useState(company.instagram_handle ?? "");
  const [city, setCity] = useState(company.city ?? "");
  const [followersBand, setFollowersBand] = useState(company.ig_followers_band ?? "");
  const [revenue, setRevenue] = useState(company.revenue_estimate ?? "");
  const [funding, setFunding] = useState(company.funding_stage ?? "");
  const [sharkTank, setSharkTank] = useState(company.shark_tank_status ?? "");
  const [presence, setPresence] = useState<string>(company.digital_presence ?? "");
  const [fit, setFit] = useState<string>(company.fit_score?.toString() ?? "");
  const [confidence, setConfidence] = useState<string>(company.confidence ?? "");
  const [hook, setHook] = useState(company.hook ?? "");
  const [sourcesText, setSourcesText] = useState(
    (company.sources ?? []).map((s) => s.url).join("\n")
  );
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [confirmNotDuplicate, setConfirmNotDuplicate] = useState(false);

  function save() {
    startTransition(async () => {
      const result = await updateCompany({
        id: company.id,
        values: {
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
          sources: sourcesText
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .map((url) => ({ url })),
        },
        confirmNotDuplicate,
      });
      if (result.ok) {
        if (result.message) toast.info(result.message);
        else toast.success("Saved.");
        setOpen(false);
      } else {
        if (result.duplicate && result.duplicate.fuzzy_matches.length > 0) {
          setNeedsConfirm(true);
        }
        toast.error(result.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">Edit</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit company</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Name *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>City</Label>
            <Input value={city} onChange={(e) => setCity(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Website domain</Label>
            <Input value={domain} onChange={(e) => setDomain(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Instagram handle</Label>
            <Input value={instagram} onChange={(e) => setInstagram(e.target.value)} />
          </div>
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
            <Label>IG followers band</Label>
            <Input
              value={followersBand}
              onChange={(e) => setFollowersBand(e.target.value)}
              placeholder="10k–50k"
            />
          </div>
          <div className="space-y-2">
            <Label>Revenue estimate</Label>
            <Input value={revenue} onChange={(e) => setRevenue(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Funding stage</Label>
            <Input value={funding} onChange={(e) => setFunding(e.target.value)} />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label>Shark Tank status</Label>
            <Input value={sharkTank} onChange={(e) => setSharkTank(e.target.value)} />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label>Discovery-gap hook</Label>
            <Textarea value={hook} onChange={(e) => setHook(e.target.value)} rows={2} />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label>Source URLs (one per line)</Label>
            <Textarea
              value={sourcesText}
              onChange={(e) => setSourcesText(e.target.value)}
              rows={3}
            />
          </div>
        </div>
        {needsConfirm && (
          <label className="flex items-center gap-2 text-sm font-medium">
            <Checkbox
              checked={confirmNotDuplicate}
              onCheckedChange={(v) => setConfirmNotDuplicate(v === true)}
            />
            A similar company exists — I confirm this is a different company
          </label>
        )}
        <DialogFooter>
          <Button onClick={save} disabled={pending || !name.trim()}>
            {pending ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
