# Install

Pre-built binaries for every desktop OS land on the
[Releases page](https://github.com/tokoriai/tokori/releases).
Pick the one for your platform:

| Platform | File | Notes |
| --- | --- | --- |
| macOS (Intel + Apple Silicon) | `Tokori_x.y.z_universal.dmg` | Universal binary — runs natively on both architectures. |
| Windows 10 / 11 | `Tokori_x.y.z_x64-setup.exe` | One-click installer. |
| Linux (any modern distro) | `tokori_x.y.z_amd64.AppImage` | Portable; `chmod +x` and run. |
| Debian / Ubuntu | `tokori_x.y.z_amd64.deb` | `sudo apt install ./tokori_*.deb` |
| Fedora / RHEL / openSUSE | `tokori-x.y.z-1.x86_64.rpm` | `sudo dnf install ./tokori-*.rpm` |
| Arch / Manjaro | [`tokori-bin`](https://aur.archlinux.org/packages/tokori-bin) (AUR) | `yay -S tokori-bin` |

## macOS — first launch

The current binaries aren't yet signed, so macOS will refuse to
open the `.dmg` on first try.

::: details Right-click bypass
1. Mount the `.dmg`.
2. **Right-click** Tokori in /Applications → **Open**.
3. Click **Open** in the warning dialog.

Subsequent launches work normally.
:::

::: details Terminal bypass
```sh
sudo xattr -d com.apple.quarantine /Applications/Tokori.app
```

Removes the quarantine flag macOS sets on un-notarised downloads.
:::

Code-signing is on the roadmap — once it lands, this dance goes
away.

## Windows — SmartScreen warning

The unsigned installer triggers SmartScreen. Click **More info** →
**Run anyway**.

## Linux — AppImage

```sh
chmod +x tokori_*.AppImage
./tokori_*.AppImage
```

Fully portable — no install step. If you want it in your desktop
launcher, use [AppImageLauncher].

[AppImageLauncher]: https://github.com/TheAssassin/AppImageLauncher

## Linux — Debian / Ubuntu (`.deb`)

```sh
sudo apt install ./tokori_*.deb
```

Installs `tokori` into `/usr/bin` with a desktop entry. Update by
installing a newer `.deb`; remove with `sudo apt remove tokori`.

## Linux — Fedora / RHEL / openSUSE (`.rpm`)

```sh
sudo dnf install ./tokori-*.rpm     # Fedora / RHEL
sudo zypper install ./tokori-*.rpm  # openSUSE
```

Remove with `sudo dnf remove tokori`.

## Linux — Arch / Manjaro (AUR)

Tokori is on the AUR as [`tokori-bin`] — it unpacks the prebuilt binary
from the release `.deb`, so there's no Rust/Node build:

```sh
yay -S tokori-bin       # or: paru -S tokori-bin
```

Update with `yay -Syu` like the rest of your system. (The in-app
auto-updater only swaps the **AppImage** in place — system-package
installs like the AUR/`.deb`/`.rpm` builds are owned by your package
manager, which is the right thing to keep them current.)

[`tokori-bin`]: https://aur.archlinux.org/packages/tokori-bin

## Staying up to date

Tokori checks for a newer release on launch. When one is available a
toast appears — click **Restart & update** and the app downloads, swaps
itself in, and relaunches. You can also check on demand from
**Settings → About → Check for updates**.

Updates are verified against Tokori's signing key before they're
installed, so a tampered download is rejected. Prefer to update
manually? Ignore the toast and grab the new installer from the
[Releases page] whenever you like.

[Releases page]: https://github.com/tokoriai/tokori/releases

## Where data lives

Your workspaces, vocabulary, and chat history are stored in a
local SQLite file under your platform's app-data directory:

| OS | Path |
| --- | --- |
| Linux | `~/.config/ai.tokori.desktop/tokori.db` |
| macOS | `~/Library/Application Support/ai.tokori.desktop/tokori.db` |
| Windows | `%APPDATA%/ai.tokori.desktop/tokori.db` |

Back this file up if you care about your data — it's the entire
app state, portable across machines (same OS) by copy-paste.

## Uninstall

- **macOS:** drag Tokori.app to the Trash; optionally remove
  `~/Library/Application Support/ai.tokori.desktop/`.
- **Windows:** Settings → Apps → Tokori → Uninstall.
- **Linux (.deb):** `sudo apt remove tokori`.
- **Linux (AppImage):** delete the file.

The data dir isn't removed by uninstall — delete it manually if
you want a clean slate.
