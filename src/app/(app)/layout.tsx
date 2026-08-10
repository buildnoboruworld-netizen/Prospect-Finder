import Link from "next/link";
import { requireAppUser } from "@/lib/auth";

// Auth-gated, per-user data on every screen — never prerender at build time.
export const dynamic = "force-dynamic";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireAppUser();
  const initials = (user.name ?? user.email)
    .split(/[\s.@]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join("");

  return (
    <div className="flex min-h-svh flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-6 px-4">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            Noboru <span className="text-primary">Prospector</span>
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            <Button asChild variant="ghost" size="sm">
              <Link href="/">Home</Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link href="/pipeline">Pipeline</Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link href="/companies/new">Add company</Link>
            </Button>
            {user.role === "admin" && (
              <Button asChild variant="ghost" size="sm">
                <Link href="/admin/users">Team</Link>
              </Button>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {user.role === "admin" && <Badge variant="secondary">admin</Badge>}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button aria-label="Account menu">
                  <Avatar className="size-8">
                    <AvatarFallback>{initials || "?"}</AvatarFallback>
                  </Avatar>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel className="max-w-56 truncate">
                  {user.name ?? user.email}
                  <p className="truncate text-xs font-normal text-muted-foreground">
                    {user.email}
                  </p>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <form action="/auth/signout" method="post" className="w-full">
                    <button type="submit" className="w-full text-left">
                      Sign out
                    </button>
                  </form>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        {children}
      </main>
    </div>
  );
}
