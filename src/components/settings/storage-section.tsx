import { useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { AlertTriangle, Database, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { wipeWorkspaceVocab } from "@/lib/db";
import { useWorkspace } from "@/lib/workspace-context";

export function StorageSection() {
  const { active: workspace } = useWorkspace();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [wiping, setWiping] = useState(false);

  async function doWipe() {
    if (!workspace) return;
    setWiping(true);
    try {
      const removed = await wipeWorkspaceVocab(workspace.id);
      toast.success(
        `Removed ${removed.toLocaleString()} vocabulary entries`,
        {
          description:
            "Open Flashcards again — it should load instantly now.",
        },
      );
      setConfirmOpen(false);
    } catch (err) {
      toast.error("Couldn't reset vocabulary", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setWiping(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Storage</h2>
        <p className="text-[13px] text-muted-foreground">
          All data lives in a local SQLite database. Nothing leaves the machine
          unless a configured cloud provider is in use.
        </p>
      </div>

      <div className="flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3.5">
        <div className="mt-0.5 flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Database className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-medium">tokori.db</p>
          <p className="text-[12px] text-muted-foreground">
            {isTauri()
              ? "OS app-config directory (e.g. %APPDATA%\\ai.tokori.desktop on Windows)."
              : "Persistent storage requires the desktop app — `npm run tauri dev` to use SQLite."}
          </p>
        </div>
      </div>

      {/* Emergency reset for the case where a content-pack import
          dumped tens of thousands of rows that Flashcards can no
          longer load. Wipes vocab + collections for the *active*
          workspace only — chats, notes, reader docs, sessions, and
          other workspaces are untouched. */}
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3.5">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex size-8 items-center justify-center rounded-md bg-destructive/10 text-destructive">
            <AlertTriangle className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-medium">Reset vocabulary in this workspace</p>
            <p className="mt-1 text-[12.5px] text-muted-foreground">
              Deletes every saved word and collection in{" "}
              <span className="font-medium text-foreground">
                {workspace?.name ?? "the active workspace"}
              </span>
              . Use this if a content-pack import broke Flashcards. Chats,
              notes, reader documents, sessions, and other workspaces stay
              intact.
            </p>
            <div className="mt-3">
              <Button
                variant="outline"
                size="sm"
                disabled={!isTauri() || !workspace}
                onClick={() => setConfirmOpen(true)}
                className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
                Reset vocabulary…
              </Button>
            </div>
          </div>
        </div>
      </div>

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(v) => {
          if (!wiping) setConfirmOpen(v);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset vocabulary?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes every saved word, every collection, and
              every flashcard review history in{" "}
              <span className="font-medium text-foreground">
                {workspace?.name ?? "this workspace"}
              </span>
              . You can&apos;t undo this from inside the app. Chats, notes,
              reader documents, and other workspaces are unaffected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={wiping}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={wiping}
              variant="destructive"
              onClick={(e) => {
                e.preventDefault();
                void doWipe();
              }}
            >
              {wiping ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Wiping…
                </>
              ) : (
                <>
                  <Trash2 className="size-3.5" />
                  Reset vocabulary
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
