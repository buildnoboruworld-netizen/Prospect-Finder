"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  confirmUpload,
  previewUpload,
  pullSheetContacts,
  type UploadPreview,
  type UploadSummary,
} from "@/app/actions/workbook";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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

/**
 * Twin of MAX_UPLOAD_BYTES in src/app/actions/workbook.ts. Checked here as well
 * because the framework rejects an oversized server-action body before the
 * action ever runs, and that rejection reaches the user as nothing at all.
 */
const MAX_UPLOAD_BYTES = 1_000_000;

export interface EnrichIndustry {
  id: string;
  name: string;
  code: string | null;
  /** Companies the workbook will contain (non-rejected, non-sample). */
  companies: number;
  /** Of those, how many still have nobody attached. */
  waiting: number;
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border px-3 py-2">
      <p className="text-xl font-semibold tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

export function EnrichWorkbook({
  industries,
  isAdmin,
  sheetPullAvailable,
}: {
  industries: EnrichIndustry[];
  isAdmin: boolean;
  /** Admin + Google credentials present; false hides the pull button's promise. */
  sheetPullAvailable: boolean;
}) {
  const router = useRouter();

  const [industryId, setIndustryId] = useState(industries[0]?.id ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<UploadPreview | null>(null);
  const [summary, setSummary] = useState<UploadSummary | null>(null);

  const [previewing, startPreview] = useTransition();
  const [importing, startImport] = useTransition();
  const [pulling, startPull] = useTransition();

  const fileInput = useRef<HTMLInputElement>(null);

  const industry = industries.find((i) => i.id === industryId) ?? null;
  const busy = previewing || importing;

  // Picking a different file invalidates the preview — showing last file's
  // numbers next to this file's name is how someone imports the wrong thing.
  function chooseFile(next: File | null) {
    setPreview(null);
    setSummary(null);
    if (next && next.size > MAX_UPLOAD_BYTES) {
      forgetFile();
      toast.error(
        `${next.name} is ${Math.round(next.size / 1000)} KB, over the ${Math.round(
          MAX_UPLOAD_BYTES / 1000
        )} KB limit. Split it into two files and upload them one after the other.`
      );
      return;
    }
    setFile(next);
  }

  function forgetFile() {
    setFile(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  function clearFile() {
    forgetFile();
    setPreview(null);
    setSummary(null);
  }

  // A server action that never returns (dropped connection, body-size refusal,
  // a redirect to /login on an expired session) rejects rather than answering,
  // and an uncaught rejection here would leave the button spinning forever.
  function reportCrash(e: unknown) {
    toast.error(
      e instanceof Error
        ? `Upload failed: ${e.message}`
        : "Upload failed — check your connection and try again."
    );
  }

  function runPreview() {
    if (!file) return;
    const data = new FormData();
    data.append("file", file);
    startPreview(async () => {
      try {
        const result = await previewUpload(data);
        if (result.ok) {
          setPreview(result.data);
          setSummary(null);
        } else {
          setPreview(null);
          toast.error(result.error);
        }
      } catch (e) {
        setPreview(null);
        reportCrash(e);
      }
    });
  }

  function runImport() {
    if (!file || !preview) return;
    const data = new FormData();
    data.append("file", file);
    // Proves to the server that these are the bytes the preview described.
    data.append("fingerprint", preview.fingerprint);
    startImport(async () => {
      try {
        const result = await confirmUpload(data);
        if (result.ok) {
          // forgetFile, not clearFile — the latter would wipe the summary we
          // are about to show.
          setPreview(null);
          forgetFile();
          setSummary(result.data);
          toast.success(result.message ?? "Imported.");
          router.refresh();
        } else {
          toast.error(result.error);
        }
      } catch (e) {
        reportCrash(e);
      }
    });
  }

  function runPull() {
    startPull(async () => {
      try {
        const result = await pullSheetContacts();
        if (result.ok) {
          toast.success(result.message ?? "Sheet read.");
          router.refresh();
        } else {
          toast.error(result.error);
        }
      } catch (e) {
        reportCrash(e);
      }
    });
  }

  const counts = preview?.counts;
  const changes = counts
    ? counts.companiesToCreate + counts.contactsToCreate + counts.contactsToUpdate
    : 0;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>1 · Download a workbook</CardTitle>
          <CardDescription>
            Fill in the green columns only — Contact Person, Designation, Role,
            Email, Phone. Leave Company ID exactly as it is; that is what tells
            us which company a row belongs to. Full instructions are on the
            “How to use” tab inside the file.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {industries.length === 0 ? (
            <Alert>
              <AlertTitle>No industries allotted to you yet</AlertTitle>
              <AlertDescription>
                Enrichment workbooks are scoped to an allotted industry. Ask
                Pragaman to assign you one — it appears here automatically. The
                blank template below works in the meantime, but an upload is
                only accepted for industries you are assigned to.
              </AlertDescription>
            </Alert>
          ) : (
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <div className="space-y-2">
                <Label htmlFor="industry">Industry</Label>
                <Select value={industryId} onValueChange={setIndustryId}>
                  <SelectTrigger id="industry">
                    <SelectValue placeholder="Pick an industry" />
                  </SelectTrigger>
                  <SelectContent>
                    {industries.map((i) => (
                      <SelectItem key={i.id} value={i.id}>
                        {i.name}
                        {i.code ? ` (${i.code})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {industry && (
                  <p className="text-xs text-muted-foreground">
                    {industry.companies === 0
                      ? "No companies in this industry yet — the workbook will only have the header row."
                      : `${industry.companies} compan${industry.companies === 1 ? "y" : "ies"} in the workbook, ${industry.waiting} still with nobody attached.`}
                  </p>
                )}
              </div>
              {/* A real navigation, not next/link: the browser only saves a
                  file when it receives one with Content-Disposition. */}
              <Button asChild>
                <a href={`/api/workbook/export?industry=${industryId}`}>
                  Download workbook
                </a>
              </Button>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 border-t pt-4">
            <Button asChild variant="outline" size="sm">
              <a href="/api/workbook/export?template=blank">
                Download blank template
              </a>
            </Button>
            <p className="text-xs text-muted-foreground">
              For companies the tool never found. Leave Company ID empty and put
              the Industry Code (ML, PF, HS…) in — the code list is on the “How
              to use” tab.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2 · Upload it back</CardTitle>
          <CardDescription>
            Nothing is saved until you have seen the summary and pressed Import.
            Uploading a corrected copy of the same file again is safe: people are
            matched by email inside each company, so a fixed typo updates rather
            than duplicates.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <div className="space-y-2">
              <Label htmlFor="workbook">Filled-in workbook (.xlsx)</Label>
              <Input
                id="workbook"
                ref={fileInput}
                type="file"
                accept=".xlsx"
                disabled={busy}
                onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
              />
            </div>
            <Button onClick={runPreview} disabled={!file || busy}>
              {previewing ? "Checking…" : "Check the file"}
            </Button>
          </div>

          {file && !preview && !previewing && (
            <p className="text-xs text-muted-foreground">
              {file.name} — press <strong>Check the file</strong> to see what it
              would change. Nothing is written yet.
            </p>
          )}

          {preview && (
            <div className="space-y-4 rounded-md border p-4">
              <div>
                <h3 className="font-medium">
                  {preview.fileName} — here is what will happen
                </h3>
                <p className="text-xs text-muted-foreground">
                  {preview.counts.rows} row
                  {preview.counts.rows === 1 ? "" : "s"} read. Nothing has been
                  saved yet.
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
                <Stat label="New companies" value={preview.counts.companiesToCreate} />
                <Stat
                  label="Matched to existing"
                  value={preview.counts.companiesLinked}
                />
                <Stat label="People added" value={preview.counts.contactsToCreate} />
                <Stat
                  label="People updated"
                  value={preview.counts.contactsToUpdate}
                />
                <Stat label="Rows skipped" value={preview.counts.rowsWithErrors} />
              </div>

              {preview.warnings.map((warning) => (
                <Alert key={warning}>
                  <AlertTitle>Worth checking first</AlertTitle>
                  <AlertDescription>{warning}</AlertDescription>
                </Alert>
              ))}

              {preview.newCompanies.length > 0 && (
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    Companies that will be created
                  </p>
                  <ul className="space-y-1 text-sm text-muted-foreground">
                    {preview.newCompanies.slice(0, 12).map((company) => (
                      <li key={company.name + company.rows[0]}>
                        <span className="font-medium text-foreground">
                          {company.name}
                        </span>{" "}
                        · {company.industryName} · row
                        {company.rows.length === 1 ? " " : "s "}
                        {company.rows.join(", ")}
                      </li>
                    ))}
                  </ul>
                  {preview.newCompanies.length > 12 && (
                    <p className="text-xs text-muted-foreground">
                      + {preview.newCompanies.length - 12} more.
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    New companies are saved as drafts for review — they do not go
                    to the Google Sheet until someone approves them.
                  </p>
                </div>
              )}

              {preview.issues.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-medium">Rows to look at</p>
                  <div className="rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-16">Row</TableHead>
                          <TableHead className="w-56">Company</TableHead>
                          <TableHead>What to do</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {preview.issues.map((issue) => (
                          <TableRow key={issue.rowNumber}>
                            <TableCell className="tabular-nums">
                              {issue.rowNumber}
                            </TableCell>
                            <TableCell>{issue.company}</TableCell>
                            <TableCell className="space-y-1">
                              {issue.error && (
                                <p className="text-destructive">
                                  <Badge
                                    variant="outline"
                                    className="mr-2 border-destructive/40 text-destructive"
                                  >
                                    skipped
                                  </Badge>
                                  {issue.error}
                                </p>
                              )}
                              {issue.warnings.map((warning) => (
                                <p
                                  key={warning}
                                  className="text-muted-foreground"
                                >
                                  {warning}
                                </p>
                              ))}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    {preview.moreIssues > 0 && (
                      <p className="border-t px-4 py-2 text-xs text-muted-foreground">
                        + {preview.moreIssues} more row
                        {preview.moreIssues === 1 ? "" : "s"} with a note —
                        fix these first, upload again, and the rest will show.
                      </p>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Rows marked <strong>skipped</strong> are not imported;
                    everything else still goes in. Fix them in the file and
                    upload it again — re-uploading never duplicates anyone.
                  </p>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2 border-t pt-4">
                <Button onClick={runImport} disabled={importing || changes === 0}>
                  {importing
                    ? "Importing…"
                    : changes === 0
                      ? "Nothing to import"
                      : `Import ${changes} change${changes === 1 ? "" : "s"}`}
                </Button>
                <Button
                  variant="ghost"
                  onClick={clearFile}
                  disabled={importing}
                >
                  Choose a different file
                </Button>
                {changes === 0 && (
                  <p className="text-xs text-muted-foreground">
                    Every row is either blank or already saved exactly as it is
                    in the file.
                  </p>
                )}
              </div>
            </div>
          )}

          {summary && (
            <Alert>
              <AlertTitle>Import finished</AlertTitle>
              <AlertDescription>
                <ul className="list-disc space-y-1 pl-4">
                  <li>{summary.companiesCreated} new companies created</li>
                  <li>
                    {summary.companiesLinked} rows attached to companies that
                    already existed
                  </li>
                  <li>{summary.contactsCreated} people added</li>
                  <li>{summary.contactsUpdated} people updated</li>
                  {summary.rowsSkipped > 0 && (
                    <li>{summary.rowsSkipped} rows skipped</li>
                  )}
                </ul>
                {summary.sheetSyncWarning && (
                  <p className="mt-2 text-destructive">
                    {summary.sheetSyncWarning}
                  </p>
                )}
                {summary.errors.map((error) => (
                  <p key={error} className="mt-2 text-destructive">
                    {error}
                  </p>
                ))}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle>Google Sheet</CardTitle>
            <CardDescription>
              Contact columns typed straight into an industry tab are read back
              into the app. That happens on every sync, so this button is only
              for pulling them in right now. Edits made on the Master tab are
              not read — it is rewritten on every sync.
            </CardDescription>
          </CardHeader>
          <CardFooter className="gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={runPull}
              disabled={pulling || !sheetPullAvailable}
              title={
                sheetPullAvailable
                  ? undefined
                  : "Sheets sync is not configured on this deployment."
              }
            >
              {pulling ? "Reading the sheet…" : "Read contacts from the sheet"}
            </Button>
            {!sheetPullAvailable && (
              <p className="text-xs text-muted-foreground">
                Add GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 and GOOGLE_SHEET_ID to
                enable this.
              </p>
            )}
          </CardFooter>
        </Card>
      )}
    </div>
  );
}
