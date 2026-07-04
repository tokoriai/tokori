/**
 * Settings → Chinese.
 *
 * Per-workspace section that only renders for workspaces whose
 * targetLang is `zh`. Surfaces two knobs:
 *
 *   1. Script preference — simplified vs traditional. Drives which
 *      form of a dictionary headword the UI prefers when an entry
 *      carries both. Stored in the standard per-workspace settings
 *      table; downstream surfaces read via `loadChineseScript()` or
 *      the `useChineseConfig` hook.
 *
 *   2. Pinyin tone colours — five hex pickers with the Pleco
 *      palette pre-loaded. Saving updates the `[data-tone="N"]`
 *      CSS vars at runtime, so every Pinyin syllable in the app
 *      (dictionary detail, reader, flashcards, vocab list) re-
 *      colours instantly without a route change.
 *
 * Reset button restores the Pleco defaults in one click — handy
 * after experimenting with the picker.
 */

import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useWorkspace } from "@/lib/workspace-context";
import {
  PLECO_TONE_COLORS,
  useChineseConfig,
  type ChineseScript,
  type ToneColors,
} from "@/lib/chinese-config";
import { Pinyin } from "@/components/pinyin";

const PREVIEW_WORD = "你好世界";
const PREVIEW_PINYIN = "nǐ hǎo shì jiè";

export function ChineseSection() {
  const { active: workspace } = useWorkspace();
  const { config, saveField, loading } = useChineseConfig(workspace?.id ?? null);

  if (!workspace) {
    return (
      <div className="text-sm text-muted-foreground">
        Open a workspace to configure Chinese settings.
      </div>
    );
  }

  if (workspace.targetLang !== "zh") {
    return (
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Chinese</h2>
        <p className="mt-2 text-[13.5px] text-muted-foreground">
          Chinese-specific settings only apply to Mandarin workspaces. This
          workspace is set to {workspace.targetLang.toUpperCase()} — switch
          to a Chinese workspace to configure script and tone colours.
        </p>
      </div>
    );
  }

  function pickColor(tone: 1 | 2 | 3 | 4 | 5, value: string) {
    const next: ToneColors = { ...config.toneColors, [tone]: value };
    void saveField("toneColors", next);
  }

  function resetColors() {
    void saveField("toneColors", PLECO_TONE_COLORS);
  }

  function pickScript(value: ChineseScript) {
    void saveField("script", value);
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Chinese</h2>
        <p className="text-[13px] text-muted-foreground">
          Settings that only apply to your Mandarin workspace. Each one is
          saved per-workspace, so a second Chinese workspace can run a
          different script or palette.
        </p>
      </div>

      {/* ── Script ─────────────────────────────────────────── */}
      <section className="space-y-3">
        <div>
          <Label className="text-[13.5px] font-medium">Script</Label>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            Which form of a dictionary headword to show when the entry
            carries both. Doesn&apos;t rewrite your saved vocab — only what
            renders on read paths (dictionary detail, hover popovers, etc.).
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:max-w-md">
          <ScriptCard
            active={config.script === "simplified"}
            disabled={loading}
            onClick={() => pickScript("simplified")}
            label="Simplified"
            sample="你好"
            sub="HSK / mainland (default)"
          />
          <ScriptCard
            active={config.script === "traditional"}
            disabled={loading}
            onClick={() => pickScript("traditional")}
            label="Traditional"
            sample="你好"
            sub="Taiwan / Hong Kong"
          />
        </div>
      </section>

      {/* ── Pinyin tone colours ────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <Label className="text-[13.5px] font-medium">Pinyin tone colours</Label>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              Defaults match Pleco. Click a swatch to customise; reset
              restores the palette.
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={resetColors}
            disabled={loading || isPlecoDefault(config.toneColors)}
          >
            <RotateCcw className="size-3.5" />
            Reset
          </Button>
        </div>

        {/* Live preview using the workspace's current palette. Reads
            the same data-tone attributes the Pinyin component uses,
            so what you see is what dictionary pages will render. */}
        <div className="rounded-lg border border-border bg-card px-4 py-3">
          <p className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
            Preview
          </p>
          <p className="mt-2 font-serif text-3xl tracking-tight">
            {PREVIEW_WORD}
          </p>
          <Pinyin raw={PREVIEW_PINYIN} className="mt-1 text-[15px]" />
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {([1, 2, 3, 4, 5] as const).map((tone) => (
            <ToneRow
              key={tone}
              tone={tone}
              value={config.toneColors[tone]}
              onChange={(v) => pickColor(tone, v)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function ScriptCard({
  active,
  disabled,
  onClick,
  label,
  sample,
  sub,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  label: string;
  sample: string;
  sub: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        "flex flex-col items-start gap-1 rounded-lg border px-4 py-3 text-left transition-colors disabled:opacity-50 " +
        (active
          ? "border-foreground bg-accent"
          : "border-border bg-card hover:border-foreground/30")
      }
    >
      <span className="font-serif text-2xl">{sample}</span>
      <span className="text-[13px] font-medium">{label}</span>
      <span className="text-[11.5px] text-muted-foreground">{sub}</span>
    </button>
  );
}

function ToneRow({
  tone,
  value,
  onChange,
}: {
  tone: 1 | 2 | 3 | 4 | 5;
  value: string;
  onChange: (v: string) => void;
}) {
  // `<input type="color">` is the only native cross-platform colour
  // picker; no extra dep needed. We render a small swatch on top so
  // the click target is visually obvious; the real input sits
  // behind it via `appearance: none` so its native chrome doesn't
  // leak through.
  const label = TONE_LABELS[tone];
  return (
    <label className="flex flex-col items-center gap-1.5 rounded-md border border-border bg-card p-2">
      <span className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
        Tone {tone}
      </span>
      <span className="relative inline-block size-9">
        <span
          className="absolute inset-0 rounded-md border border-border"
          style={{ background: value }}
        />
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 size-9 cursor-pointer opacity-0"
          aria-label={`Tone ${tone} colour`}
        />
      </span>
      <span className="font-mono text-[10px] text-muted-foreground">
        {value.toUpperCase()}
      </span>
      <span
        className="font-serif text-[15px] leading-none"
        style={{ color: value }}
      >
        {label}
      </span>
    </label>
  );
}

const TONE_LABELS: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: "mā",
  2: "má",
  3: "mǎ",
  4: "mà",
  5: "ma",
};

function isPlecoDefault(c: ToneColors): boolean {
  return (
    c[1].toLowerCase() === PLECO_TONE_COLORS[1] &&
    c[2].toLowerCase() === PLECO_TONE_COLORS[2] &&
    c[3].toLowerCase() === PLECO_TONE_COLORS[3] &&
    c[4].toLowerCase() === PLECO_TONE_COLORS[4] &&
    c[5].toLowerCase() === PLECO_TONE_COLORS[5]
  );
}
