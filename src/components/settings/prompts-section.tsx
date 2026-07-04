import { useEffect, useState } from "react";
import { Plus, Sparkles, Star, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  deleteSystemPrompt,
  listSystemPrompts,
  saveSystemPrompt,
  type SystemPrompt,
} from "@/lib/db";
import { cn } from "@/lib/utils";

const STARTERS: { name: string; body: string }[] = [
  {
    name: "Friendly tutor (default)",
    body:
      "You are a friendly {target} tutor. The student's native language is {native}. Mirror the language the student writes in: reply in {target} when they write in {target} (immersion), but when they write in {native} or ask for an explanation, answer and explain in {native} so it's clear. Give grammar, usage, and meaning explanations in {native}; keep example sentences and the {target} you're teaching in {target}. Keep replies concise. Reference the student's known and learning vocabulary when chosen — and when introducing a new word, briefly explain it in {native}.",
  },
  {
    name: "Strict grammar coach",
    body:
      "You are a strict {target} grammar coach. After each student message, point out any grammatical errors with brief explanations in {native}, then reply naturally in {target}. Push them to practice constructions appropriate for their level.",
  },
  {
    name: "Conversation partner",
    body:
      "You are a casual native {target} speaker chatting with a friend. Keep things colloquial. Don't translate unless the student explicitly asks. Use idioms and modern slang where appropriate.",
  },
  {
    name: "Roleplay scenarios",
    body:
      "You are a roleplay director. Set up realistic scenes in {target} (cafés, train stations, doctor's office, job interviews) and play the NPC. Keep your replies short and natural. After each exchange, suggest one phrase the student could have used.",
  },
];

export function PromptsSection() {
  const [prompts, setPrompts] = useState<SystemPrompt[]>([]);
  const [editing, setEditing] = useState<{ id?: number; name: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setPrompts(await listSystemPrompts());
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function setDefault(id: number) {
    setBusy(true);
    try {
      const prompt = prompts.find((p) => p.id === id);
      if (!prompt) return;
      await saveSystemPrompt({ id, name: prompt.name, body: prompt.body, isDefault: true });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    await deleteSystemPrompt(id);
    await refresh();
  }

  async function save(name: string, body: string, id?: number) {
    if (!name.trim() || !body.trim()) return;
    setBusy(true);
    try {
      await saveSystemPrompt({ id, name: name.trim(), body: body.trim() });
      await refresh();
      setEditing(null);
    } finally {
      setBusy(false);
    }
  }

  async function addStarter(s: { name: string; body: string }) {
    await saveSystemPrompt({ name: s.name, body: s.body, isDefault: prompts.length === 0 });
    await refresh();
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Tutor prompts</h2>
        <p className="text-[13px] text-muted-foreground">
          The active prompt is sent as the system message on every chat. Use{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[12px]">{`{target}`}</code> and{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[12px]">{`{native}`}</code> as
          placeholders for the workspace's languages.
        </p>
      </div>

      {prompts.length === 0 ? (
        <div className="space-y-3">
          <p className="text-[13px] text-muted-foreground">
            No prompts yet. Start with a preset or write your own.
          </p>
          <ul className="space-y-2">
            {STARTERS.map((s) => (
              <li
                key={s.name}
                className="flex items-start gap-3 rounded-xl border border-border bg-card p-3"
              >
                <Sparkles className="mt-0.5 size-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{s.name}</div>
                  <p className="line-clamp-2 text-[12px] text-muted-foreground">{s.body}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => addStarter(s)}>
                  Add
                </Button>
              </li>
            ))}
          </ul>
          <Button variant="ghost" onClick={() => setEditing({ name: "", body: "" })}>
            <Plus className="size-4" />
            Or write a custom prompt
          </Button>
        </div>
      ) : (
        <>
          <ul className="space-y-2">
            {prompts.map((p) => (
              <li
                key={p.id}
                className={cn(
                  "rounded-xl border bg-card px-4 py-3 transition-colors",
                  p.isDefault ? "border-foreground/30 ring-1 ring-foreground/10" : "border-border",
                )}
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{p.name}</span>
                      {p.isDefault && (
                        <Badge variant="secondary" className="text-[10px]">
                          active
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 line-clamp-2 text-[12px] text-muted-foreground">{p.body}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {!p.isDefault && (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => setDefault(p.id)}
                        title="Use as default"
                        disabled={busy}
                      >
                        <Star className="size-4" />
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setEditing({ id: p.id, name: p.name, body: p.body })
                      }
                    >
                      Edit
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => remove(p.id)}
                      title="Remove"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <Button variant="outline" onClick={() => setEditing({ name: "", body: "" })}>
            <Plus className="size-4" />
            New prompt
          </Button>
        </>
      )}

      {editing && (
        <PromptEditor
          initial={editing}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={(n, b) => save(n, b, editing.id)}
        />
      )}
    </div>
  );
}

function PromptEditor({
  initial,
  busy,
  onCancel,
  onSave,
}: {
  initial: { id?: number; name: string; body: string };
  busy: boolean;
  onCancel: () => void;
  onSave: (name: string, body: string) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [body, setBody] = useState(initial.body);

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="grid gap-2">
        <Label htmlFor="prompt-name">Name</Label>
        <Input id="prompt-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="prompt-body">Prompt</Label>
        <textarea
          id="prompt-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
          className="resize-y rounded-md border border-input bg-background px-3 py-2 text-[13.5px] leading-relaxed shadow-xs focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={busy || !name.trim() || !body.trim()} onClick={() => onSave(name, body)}>
          Save
        </Button>
      </div>
    </div>
  );
}
