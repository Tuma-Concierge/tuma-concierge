import { ThemeToggle } from "./ThemeToggle";

export function BrandHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-navy/15 bg-cream/95 backdrop-blur-sm">
      <div className="mx-auto flex max-w-lg items-center gap-3 px-4 py-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/tuma-logo-navy.png"
          alt="Tuma"
          width={140}
          height={53}
          className="h-8 w-auto dark:hidden"
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/tuma-logo-white.png"
          alt="Tuma"
          width={140}
          height={53}
          className="hidden h-8 w-auto dark:block"
        />
        <span className="ml-auto rounded-full bg-ink/10 px-2.5 py-0.5 text-xs font-medium text-ink">
          Admin
        </span>
        <ThemeToggle />
      </div>
    </header>
  );
}
