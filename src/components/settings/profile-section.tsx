import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LANGUAGES, type LanguageCode } from "@/lib/languages";
import { useProfile, type Theme } from "@/lib/profile-context";

export function ProfileSection() {
  const { profile, update } = useProfile();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Profile</h2>
        <p className="text-[13px] text-muted-foreground">
          Used to greet you and to default new workspaces.
        </p>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            value={profile.name}
            placeholder="What should I call you?"
            onChange={(e) => void update({ name: e.target.value })}
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="theme">Theme</Label>
          <Select
            value={profile.theme}
            onValueChange={(v) => void update({ theme: v as Theme })}
          >
            <SelectTrigger id="theme">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">System</SelectItem>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-2 md:col-span-2">
          <Label htmlFor="native">Default explanation language</Label>
          <Select
            value={profile.defaultNativeLang}
            onValueChange={(v) =>
              void update({ defaultNativeLang: v as LanguageCode })
            }
          >
            <SelectTrigger id="native">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGES.map((l) => (
                <SelectItem key={l.code} value={l.code}>
                  {l.name}{" "}
                  <span className="text-muted-foreground">· {l.nativeName}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Used as the default for new workspaces.
          </p>
        </div>
      </div>
    </div>
  );
}
