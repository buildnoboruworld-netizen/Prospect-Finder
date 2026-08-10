"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { addTeamUser, setUserActive, setUserRole } from "@/app/actions/users";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import type { AppUser, UserRole } from "@/lib/types";

export function UserManagement({
  users,
  selfId,
}: {
  users: AppUser[];
  selfId: string;
}) {
  const [pending, startTransition] = useTransition();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<UserRole>("member");

  function add() {
    startTransition(async () => {
      const result = await addTeamUser({ email, name: name || undefined, role });
      if (result.ok) {
        toast.success(`${email} can now sign in.`);
        setEmail("");
        setName("");
        setRole("member");
      } else {
        toast.error(result.error);
      }
    });
  }

  function toggleActive(user: AppUser) {
    startTransition(async () => {
      const result = await setUserActive({ id: user.id, active: !user.active });
      if (result.ok) {
        toast.success(user.active ? "Access revoked." : "Access restored.");
      } else {
        toast.error(result.error);
      }
    });
  }

  function changeRole(user: AppUser, newRole: UserRole) {
    startTransition(async () => {
      const result = await setUserRole({ id: user.id, role: newRole });
      if (result.ok) toast.success(`${user.email} is now ${newRole}.`);
      else toast.error(result.error);
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add teammate to allowlist</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-2">
              <Label htmlFor="new-email">Google email *</Label>
              <Input
                id="new-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="teammate@gmail.com"
                className="w-64"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-name">Name</Label>
              <Input
                id="new-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="(optional)"
                className="w-44"
              />
            </div>
            <div className="space-y-2">
              <Label>Role</Label>
              <Select value={role} onValueChange={(v) => setRole(v as UserRole)}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">member</SelectItem>
                  <SelectItem value="admin">admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={add} disabled={pending || !email.includes("@")}>
              {pending ? "Adding…" : "Add to allowlist"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Teammate</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Signed in</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <TableRow key={u.id} className={u.active ? "" : "opacity-60"}>
                <TableCell>
                  <span className="font-medium">{u.name ?? "—"}</span>
                  <p className="text-xs text-muted-foreground">{u.email}</p>
                </TableCell>
                <TableCell>
                  <Select
                    value={u.role}
                    onValueChange={(v) => changeRole(u, v as UserRole)}
                    disabled={pending || u.id === selfId}
                  >
                    <SelectTrigger className="h-8 w-28" size="sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="member">member</SelectItem>
                      <SelectItem value="admin">admin</SelectItem>
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell>
                  <Badge variant={u.active ? "secondary" : "outline"}>
                    {u.active ? "active" : "revoked"}
                  </Badge>
                </TableCell>
                <TableCell>
                  {u.auth_user_id ? (
                    <Badge variant="outline">linked</Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      never signed in
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant={u.active ? "outline" : "secondary"}
                    size="sm"
                    onClick={() => toggleActive(u)}
                    disabled={pending || u.id === selfId}
                  >
                    {u.active ? "Revoke access" : "Restore access"}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
