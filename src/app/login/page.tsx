import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { LogoMark } from "@/components/logo";
import { GoogleSignInButton } from "./google-button";

const ERROR_MESSAGES: Record<string, string> = {
  auth_failed: "Google sign-in didn't complete. Please try again.",
  missing_code: "Sign-in was interrupted. Please try again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <LogoMark className="mx-auto mb-2 size-14 text-neutral-950" />
          <CardTitle className="font-heading text-2xl">
            Noboru Prospector
          </CardTitle>
          <CardDescription>
            Internal lead-gen for Noboru World. Sign in with your team Google
            account.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>
                {ERROR_MESSAGES[error] ?? "Something went wrong. Try again."}
              </AlertDescription>
            </Alert>
          )}
          <GoogleSignInButton />
          <p className="text-center text-xs text-muted-foreground">
            Access is limited to allowlisted team accounts.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
