"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const STATUSES = ["draft", "approved", "rejected", "enriched", "synced"];

export function PipelineFilters({
  industries,
}: {
  industries: { id: string; name: string }[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [search, setSearch] = useState(params.get("q") ?? "");

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params.toString());
    if (!value || value === "all") next.delete(key);
    else next.set(key, value);
    router.replace(`/pipeline?${next.toString()}`);
  }

  // debounce the search box into the URL
  useEffect(() => {
    const t = setTimeout(() => {
      const current = params.get("q") ?? "";
      if (search !== current) setParam("q", search || null);
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        placeholder="Search companies…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="h-9 w-48"
      />
      <Select
        value={params.get("scope") ?? "mine"}
        onValueChange={(v) => setParam("scope", v === "mine" ? null : v)}
      >
        <SelectTrigger className="h-9 w-36" size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="mine">My leads</SelectItem>
          <SelectItem value="all">Whole team</SelectItem>
        </SelectContent>
      </Select>
      <Select
        value={params.get("industry") ?? "all"}
        onValueChange={(v) => setParam("industry", v)}
      >
        <SelectTrigger className="h-9 w-52" size="sm">
          <SelectValue placeholder="Industry" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All industries</SelectItem>
          {industries.map((i) => (
            <SelectItem key={i.id} value={i.id}>
              {i.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={params.get("status") ?? "all"}
        onValueChange={(v) => setParam("status", v)}
      >
        <SelectTrigger className="h-9 w-36" size="sm">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Any status</SelectItem>
          {STATUSES.map((s) => (
            <SelectItem key={s} value={s}>
              {s}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
