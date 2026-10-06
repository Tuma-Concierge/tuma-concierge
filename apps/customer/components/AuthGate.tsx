"use client";

import { isUserVerified } from "@tuma/shared";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "../lib/auth-context";

const PUBLIC_PATHS = ["/login", "/forgot-password"];
// Always reachable for a signed-in but not-yet-verified customer —
// otherwise they could never get to the screen that verifies them.
const ALWAYS_ALLOWED_PATHS = ["/verify"];
// Reachable no matter the auth state at all — this is where the emailed
// "Verify Email Address" link redirects to, and the person clicking it may
// be signed out here (different device/browser than where they signed up).
const UNGATED_PATHS = ["/verify/confirmed"];

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, ready } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const isUngated = UNGATED_PATHS.includes(pathname);
  const isPublic = PUBLIC_PATHS.includes(pathname);
  const needsVerification = !!user && !isUserVerified(user) && !ALWAYS_ALLOWED_PATHS.includes(pathname);
  const verifiedButOnVerifyPage = !!user && isUserVerified(user) && pathname === "/verify";

  useEffect(() => {
    if (isUngated || !ready) return;
    if (!user && !isPublic) router.replace("/login");
    if (user && isPublic) router.replace("/");
    if (user && needsVerification) router.replace("/verify");
    if (verifiedButOnVerifyPage) router.replace("/");
  }, [isUngated, ready, user, isPublic, needsVerification, verifiedButOnVerifyPage, router]);

  if (isUngated) return <>{children}</>;
  if (!ready) return null;
  if (!user && !isPublic) return null;
  if (user && isPublic) return null;
  if (user && needsVerification) return null;
  if (verifiedButOnVerifyPage) return null;

  return <>{children}</>;
}
