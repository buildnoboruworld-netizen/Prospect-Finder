"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  approveCompany,
  rejectCompany,
  unrejectCompany,
} from "@/app/actions/companies";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { CompanyStatus } from "@/lib/types";

export function CompanyActions({
  companyId,
  status,
  canEdit,
  isAdmin,
}: {
  companyId: string;
  status: CompanyStatus;
  canEdit: boolean;
  isAdmin: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");

  if (!canEdit) return null;

  function approve() {
    startTransition(async () => {
      const result = await approveCompany(companyId);
      if (result.ok) toast.success(result.message ?? "Approved.");
      else toast.error(result.error);
    });
  }

  function reject() {
    startTransition(async () => {
      const result = await rejectCompany({ id: companyId, reason });
      if (result.ok) {
        toast.success(result.message ?? "Rejected.");
        setRejectOpen(false);
        setReason("");
      } else {
        toast.error(result.error);
      }
    });
  }

  function unreject() {
    startTransition(async () => {
      const result = await unrejectCompany(companyId);
      if (result.ok) toast.success(result.message ?? "Back to draft.");
      else toast.error(result.error);
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {(status === "draft" || status === "approved") && (
        <Button onClick={approve} disabled={pending || status === "approved"}>
          {status === "approved" ? "Approved" : "Approve"}
        </Button>
      )}
      {status !== "rejected" && (
        <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
          <DialogTrigger asChild>
            <Button variant="destructive" disabled={pending}>
              Reject
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Reject this company</DialogTitle>
              <DialogDescription>
                Rejected companies are remembered with the reason and never
                resurface in runs or manual adds (only an admin can un-reject).
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="reason">Reason *</Label>
              <Textarea
                id="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Too big for the retainer / not D2C / no fit because…"
                rows={3}
              />
            </div>
            <DialogFooter>
              <Button
                variant="destructive"
                onClick={reject}
                disabled={pending || reason.trim().length < 3}
              >
                {pending ? "Rejecting…" : "Reject company"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {status === "rejected" && isAdmin && (
        <Button variant="outline" onClick={unreject} disabled={pending}>
          Un-reject (admin)
        </Button>
      )}
    </div>
  );
}
