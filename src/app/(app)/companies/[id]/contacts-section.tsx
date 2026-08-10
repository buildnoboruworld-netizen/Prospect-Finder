"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  addContact,
  deleteContact,
  setPrimaryContact,
  updateContact,
} from "@/app/actions/contacts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ChannelBadge } from "@/components/status-badge";
import type { Contact } from "@/lib/types";
import { contactRoleValues } from "@/lib/schemas";

interface ContactFormState {
  full_name: string;
  designation: string;
  role_type: string;
  email: string;
  email_status: string;
  phone: string;
  phone_status: string;
  is_primary: boolean;
}

const EMPTY: ContactFormState = {
  full_name: "",
  designation: "",
  role_type: "other",
  email: "",
  email_status: "public_generic",
  phone: "",
  phone_status: "public_generic",
  is_primary: false,
};

function toFormState(c: Contact): ContactFormState {
  return {
    full_name: c.full_name ?? "",
    designation: c.designation ?? "",
    role_type: c.role_type,
    email: c.email ?? "",
    email_status: c.email_status === "unknown" ? "public_generic" : c.email_status,
    phone: c.phone ?? "",
    phone_status: c.phone_status === "unknown" ? "public_generic" : c.phone_status,
    is_primary: c.is_primary,
  };
}

export function ContactsSection({
  companyId,
  contacts,
  canEdit,
}: {
  companyId: string;
  contacts: Contact[];
  canEdit: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [form, setForm] = useState<ContactFormState>(EMPTY);

  function openAdd() {
    setEditing(null);
    setForm({ ...EMPTY, is_primary: contacts.length === 0 });
    setDialogOpen(true);
  }

  function openEdit(contact: Contact) {
    setEditing(contact);
    setForm(toFormState(contact));
    setDialogOpen(true);
  }

  function set<K extends keyof ContactFormState>(key: K, value: ContactFormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function save() {
    startTransition(async () => {
      const values = {
        company_id: companyId,
        full_name: form.full_name,
        designation: form.designation,
        role_type: form.role_type,
        email: form.email,
        email_status: form.email_status,
        phone: form.phone,
        phone_status: form.phone_status,
        is_primary: form.is_primary,
      };
      const result = editing
        ? await updateContact({ id: editing.id, values })
        : await addContact({ values });
      if (result.ok) {
        toast.success(editing ? "Contact updated." : "Contact added.");
        setDialogOpen(false);
      } else {
        toast.error(result.error);
      }
    });
  }

  function remove(contact: Contact) {
    startTransition(async () => {
      const result = await deleteContact(contact.id);
      if (result.ok) toast.success("Contact removed.");
      else toast.error(result.error);
    });
  }

  function makePrimary(contact: Contact) {
    startTransition(async () => {
      const result = await setPrimaryContact(contact.id);
      if (result.ok) toast.success("Primary contact updated.");
      else toast.error(result.error);
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">
          Contacts{" "}
          <span className="text-sm font-normal text-muted-foreground">
            ({contacts.length})
          </span>
        </h2>
        {canEdit && (
          <Button size="sm" onClick={openAdd} disabled={pending}>
            Add contact
          </Button>
        )}
      </div>

      {contacts.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          No contacts yet — flagged as <strong>→ enrich</strong>. Add a founder
          or marketing contact manually, or enrich in Phase 3.
        </p>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Designation</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Primary</TableHead>
                {canEdit && <TableHead className="w-10" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {contacts.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">
                    {c.full_name ?? "—"}
                  </TableCell>
                  <TableCell>{c.role_type}</TableCell>
                  <TableCell>{c.designation ?? "—"}</TableCell>
                  <TableCell>
                    {c.email ?? <span className="text-xs text-muted-foreground">→ enrich</span>}
                    {c.email && <ChannelBadge status={c.email_status} />}
                  </TableCell>
                  <TableCell>
                    {c.phone ?? "—"}
                    {c.phone && <ChannelBadge status={c.phone_status} />}
                  </TableCell>
                  <TableCell>{c.is_primary ? "★" : ""}</TableCell>
                  {canEdit && (
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm" disabled={pending}>
                            ⋯
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openEdit(c)}>
                            Edit
                          </DropdownMenuItem>
                          {!c.is_primary && (
                            <DropdownMenuItem onClick={() => makePrimary(c)}>
                              Make primary
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => remove(c)}
                          >
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit contact" : "Add contact"}</DialogTitle>
            <DialogDescription>
              Manually entered channels are marked <em>public</em> — the
              &ldquo;verified&rdquo; badge is reserved for enrichment-API
              results.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Full name</Label>
              <Input
                value={form.full_name}
                onChange={(e) => set("full_name", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Role</Label>
              <Select
                value={form.role_type}
                onValueChange={(v) => set("role_type", v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {contactRoleValues.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label>Designation</Label>
              <Input
                value={form.designation}
                onChange={(e) => set("designation", e.target.value)}
                placeholder="Co-founder / Marketing Head"
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label>Email</Label>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => set("email", e.target.value)}
                placeholder="hello@brand.com"
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label>Phone</Label>
              <Input
                value={form.phone}
                onChange={(e) => set("phone", e.target.value)}
                placeholder="+91…"
              />
            </div>
            <label className="flex items-center gap-2 text-sm font-medium sm:col-span-2">
              <Checkbox
                checked={form.is_primary}
                onCheckedChange={(v) => set("is_primary", v === true)}
              />
              Primary contact for outreach
            </label>
          </div>
          <DialogFooter>
            <Button
              onClick={save}
              disabled={
                pending || (!form.full_name.trim() && !form.email.trim() && !form.phone.trim())
              }
            >
              {pending ? "Saving…" : editing ? "Save changes" : "Add contact"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
