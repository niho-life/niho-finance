"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { shouldRefreshOnResume } from "@/lib/pwa/resume";

/**
 * The home-screen app's client side (10 §1.1): registers the Service Worker (`public/sw.js`, which
 * caches only 接続がない画面) and reads the page again when it comes back to the front with an old
 * view: after 60 seconds or more hidden (`visibilitychange`), or restored by 戻る from the
 * back/forward cache (`pageshow` with `persisted`). When IAP's session has expired, Next turns the
 * refresh into a page navigation, which goes through IAP's sign-in. Draws nothing.
 */
export function PwaLifecycle() {
  const router = useRouter();

  useEffect(() => {
    // Service Workers need https (or localhost).
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    // `updateViaCache: "none"`: a new sw.js is seen at once, not after the HTTP cache expires.
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch((error: unknown) => {
        console.error("[niho-finance] the Service Worker was not registered", error);
      });
  }, []);

  useEffect(() => {
    let hiddenAt: number | null = document.visibilityState === "hidden" ? Date.now() : null;

    function onVisibilityChange() {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      const refresh = shouldRefreshOnResume(hiddenAt, Date.now());
      hiddenAt = null;
      if (refresh) router.refresh();
    }

    function onPageShow(event: PageTransitionEvent) {
      if (event.persisted) router.refresh();
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [router]);

  return null;
}
