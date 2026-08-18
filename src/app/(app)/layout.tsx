import Link from "next/link";
import { requireAppUser } from "@/lib/auth";
import { LogoMark } from "@/components/logo";

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

  const navLink =
    "text-white/75 hover:text-white hover:bg-white/10 focus-visible:ring-primary";

  return (
    <div className="flex min-h-svh flex-col">
      <header className="sticky top-0 z-40 bg-neutral-950 text-white">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-6 px-4">
          <Link href="/" className="flex items-center gap-2.5">
            <LogoMark className="size-7 text-white" />
            <span className="font-heading text-[15px] font-semibold tracking-tight">
              Noboru <span className="text-primary">Prospector</span>
            </span>
          </Link>
          {/* min-w-0 + scroll: seven links no longer fit a phone, and the
              alternative is the account menu being pushed off the screen. */}
          <nav className="flex min-w-0 items-center gap-1 overflow-x-auto text-sm">
            <Button asChild variant="ghost" size="sm" className={navLink}>
              <Link href="/">Home</Link>
            </Button>
            <Button asChild variant="ghost" size="sm" className={navLink}>
              <Link href="/today">Today</Link>
            </Button>
            <Button asChild variant="ghost" size="sm" className={navLink}>
              <Link href="/pipeline">Pipeline</Link>
            </Button>
            <Button asChild variant="ghost" size="sm" className={navLink}>
              <Link href="/enrich">Enrich</Link>
            </Button>
            <Button asChild variant="ghost" size="sm" className={navLink}>
              <Link href="/companies/new">Add company</Link>
            </Button>
            {user.role === "admin" && (
              <>
                <Button asChild variant="ghost" size="sm" className={navLink}>
                  <Link href="/dashboard">Dashboard</Link>
                </Button>
                <Button asChild variant="ghost" size="sm" className={navLink}>
                  <Link href="/admin/users">Team</Link>
                </Button>
              </>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {user.role === "admin" && (
              <Badge className="border-primary/40 bg-primary/15 text-primary">
                admin
              </Badge>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button aria-label="Account menu">
                  <Avatar className="size-8">
                    <AvatarFallback className="bg-primary font-medium text-primary-foreground">
                      {initials || "?"}
                    </AvatarFallback>
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
