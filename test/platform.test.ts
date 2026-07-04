import { describe, expect, it } from "vitest";
import { detectPlatform } from "@/lib/platform";

// Real UA strings from the webviews Tauri actually embeds — the
// title bar picks its chrome layout (traffic-light inset vs custom
// window controls) off this answer, so each family gets a case.

const WKWEBVIEW_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const WEBVIEW2_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0";
const WEBKITGTK_LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

describe("detectPlatform", () => {
  it("identifies macOS (WKWebView)", () => {
    expect(detectPlatform(WKWEBVIEW_MAC)).toBe("mac");
  });

  it("identifies Windows (WebView2)", () => {
    expect(detectPlatform(WEBVIEW2_WINDOWS)).toBe("windows");
  });

  it("identifies Linux (WebKitGTK)", () => {
    expect(detectPlatform(WEBKITGTK_LINUX)).toBe("linux");
  });

  it("classifies Android as mobile despite the Linux token", () => {
    expect(detectPlatform(ANDROID)).toBe("mobile");
  });

  it("classifies iOS as mobile despite the Mac OS X token", () => {
    expect(detectPlatform(IOS)).toBe("mobile");
  });

  it("falls back to linux for an empty / unknown UA", () => {
    expect(detectPlatform("")).toBe("linux");
  });
});
