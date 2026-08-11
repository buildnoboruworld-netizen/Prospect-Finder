"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";

// Temporary-primary sign-in method until the Google OAuth provider is
// configured (PRD specifies Google; both coexist fine). Anyone can create an
// account — the users-table allowlist still decides who gets past /denied.
export function PasswordSignInForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"in" | "up" | null>(null);

  async function signIn() {
    setBusy("in");
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (error) {
        toast.error(
          error.message === "Invalid login credentials"
            ? "Wrong email or password — or no account yet (use Create account)."
            : error.message
        );
        return;
      }
      router.push("/");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sign-in failed");
    } finally {
      setBusy(null);
    }
  }

  async function signUp() {
    setBusy("up");
    try {
      const supabase = createClient();
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
      });
      if (error) {
        toast.error(error.message);
        return;
      }
      if (data.session) {
        router.push("/");
        router.refresh();
        return;
      }
      // No session → email confirmation is enabled in Supabase.
      toast.info(
        "Account created — confirm via the email Supabase sent you, then sign in. (Or disable 'Confirm email' under Authentication → Sign In / Providers → Email for instant sign-ins.)",
        { duration: 12000 }
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sign-up failed");
    } finally {
      setBusy(null);
    }
  }

  const disabled = busy !== null || !email.includes("@") || password.length < 6;

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled) void signIn();
      }}
    >
      <div className="space-y-2 text-left">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@noboruworld.com"
        />
      </div>
      <div className="space-y-2 text-left">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="min 6 characters"
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" className="flex-1" disabled={disabled}>
          {busy === "in" ? "Signing in…" : "Sign in"}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="flex-1"
          disabled={disabled}
          onClick={() => void signUp()}
        >
          {busy === "up" ? "Creating…" : "Create account"}
        </Button>
      </div>
    </form>
  );
}
