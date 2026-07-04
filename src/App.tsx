import { useEffect } from "react";
import { Shell } from "@/components/shell/shell";
import { loadEnabledAddons } from "@/lib/addons/loader";
import { AppErrorBoundary } from "@/components/error-boundary";
import { AuthGate } from "@/components/auth-gate";
import { Toaster } from "@/components/ui/sonner";
import { UpdaterNudge } from "@/components/updater-nudge";
import { BackgroundChatProvider } from "@/lib/background-chat-context";
import { ChatListProvider } from "@/lib/chat-list-context";
import { CloudProvider } from "@/lib/cloud-context";
import { DisplayProvider } from "@/lib/display-context";
import { ProfileProvider } from "@/lib/profile-context";
import { ProviderConfigProvider } from "@/lib/provider-context";
import { SearchProvider } from "@/lib/search-context";
import { SessionProvider } from "@/lib/session-context";
import { TTSProvider } from "@/lib/tts-context";
import { WorkspaceProvider } from "@/lib/workspace-context";

export default function App() {
  // Load enabled addons once at startup so their importers (etc.) are
  // registered before any dialog that lists them opens. No-op under
  // HOSTED / non-Tauri (guarded inside loadEnabledAddons).
  useEffect(() => {
    void loadEnabledAddons();
  }, []);

  // The error boundary sits at the very top so a render-time crash
  // anywhere in the tree shows a recoverable banner instead of
  // blanking the whole webview. Toaster sits inside it so toasts
  // still work *after* a recovery; renders outside it would be
  // unmounted along with the rest.
  return (
    <AppErrorBoundary>
      <ProfileProvider>
        <DisplayProvider>
          <CloudProvider>
            {/* AuthGate is a no-op in the desktop build (HOSTED=false,
                fully tree-shaken). In the hosted build it blocks the
                rest of the tree from mounting until the user is
                signed in AND has an active Pro subscription —
                stops a non-paying user from ever instantiating the
                provider/session/chat contexts behind it. */}
            <AuthGate>
              <WorkspaceProvider>
                <ProviderConfigProvider>
                  <TTSProvider>
                    <SessionProvider>
                      <ChatListProvider>
                        <BackgroundChatProvider>
                          <SearchProvider>
                            <Shell />
                            <Toaster />
                            {/* Silent post-launch update check → toast.
                                No-ops off the packaged desktop build. */}
                            <UpdaterNudge />
                          </SearchProvider>
                        </BackgroundChatProvider>
                      </ChatListProvider>
                    </SessionProvider>
                  </TTSProvider>
                </ProviderConfigProvider>
              </WorkspaceProvider>
            </AuthGate>
          </CloudProvider>
        </DisplayProvider>
      </ProfileProvider>
    </AppErrorBoundary>
  );
}
