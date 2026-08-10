"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

export function GoogleSignInButton() {
  const [loading, setLoading] = useState(false);

  async function signIn() {
    setLoading(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) {
        toast.error(`Google sign-in failed: ${error.message}`);
        setLoading(false);
      }
      // on success the browser navigates away
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sign-in failed");
      setLoading(false);
    }
  }

  return (
    <Button onClick={signIn} disabled={loading} className="w-full" size="lg">
      <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
        <path
          fill="currentColor"
          d="M21.35 11.1H12v2.9h5.35c-.5 2.5-2.6 4.3-5.35 4.3a5.8 5.8 0 1 1 0-11.6c1.45 0 2.75.55 3.75 1.45l2.15-2.15A8.8 8.8 0 1 0 12 20.8c4.4 0 8.5-3.2 8.5-8.8 0-.3-.05-.6-.15-.9Z"
        />
      </svg>
      {loading ? "Redirecting to Google…" : "Continue with Google"}
    </Button>
  );
}
