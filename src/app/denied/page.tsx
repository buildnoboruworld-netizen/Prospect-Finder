import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function DeniedPage() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm text-center">
        <CardHeader>
          <CardTitle>Not on the team list (yet)</CardTitle>
          <CardDescription>
            This Google account isn&apos;t on the Noboru Prospector allowlist.
            Ask Pragaman to add your email, then sign in again.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline" className="w-full">
            <Link href="/login">Back to sign-in</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
