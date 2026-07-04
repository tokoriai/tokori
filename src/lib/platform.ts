/**
 * Which OS the app is running on, derived from the webview's user
 * agent. Synchronous on purpose: the custom title bar needs the
 * answer before its first paint (an async `platform()` call would
 * flash the wrong chrome for a frame), and the desktop webviews all
 * advertise their OS unambiguously — WKWebView says "Macintosh",
 * WebView2 says "Windows NT", WebKitGTK says "X11; Linux".
 */

export type AppPlatform = "mac" | "windows" | "linux" | "mobile";

export function detectPlatform(userAgent: string): AppPlatform {
  // Mobile first: Android UAs also contain "Linux", and the iOS
  // webview reports "iPhone"/"iPad" (it only masquerades as
  // "Macintosh" in desktop-mode Safari, which we never run in).
  if (/Android|iPhone|iPad/.test(userAgent)) return "mobile";
  if (/Macintosh|Mac OS X/.test(userAgent)) return "mac";
  if (/Windows/.test(userAgent)) return "windows";
  return "linux";
}

/** Resolved once at module load — the UA can't change mid-session. */
export const PLATFORM: AppPlatform = detectPlatform(
  typeof navigator === "undefined" ? "" : navigator.userAgent,
);
