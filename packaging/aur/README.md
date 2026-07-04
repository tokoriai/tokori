# AUR packaging (`tokori-bin`)

Tokori is published to the [Arch User Repository](https://aur.archlinux.org/packages/tokori-bin)
as **`tokori-bin`** — a binary package that unpacks the prebuilt
executable from the release `.deb`, so an Arch user gets a few-second
`yay -S tokori-bin` instead of a full Rust + Node build.

## How it ships

`PKGBUILD.template` here is the source of truth. The
[`aur` workflow](../../.github/workflows/aur.yml) renders it on every
**published** GitHub Release:

1. The maintainer publishes a drafted release (so the `.deb` is live at
   a stable `releases/download/<tag>/` URL).
2. The workflow downloads `tokori_<version>_amd64.deb`, computes its
   `sha256`, and substitutes `__VERSION__` / `__SHA256__` into the
   template.
3. It generates `.SRCINFO` and pushes the new `PKGBUILD` to the AUR.

It only runs when the `AUR_SSH_PRIVATE_KEY` secret is present, so forks
are unaffected.

## One-time maintainer setup

1. Make an [AUR account](https://aur.archlinux.org) and add an SSH
   **public** key to it (Account → My Account → SSH Public Key).
2. Add the matching **private** key + identity as repo secrets:
   ```sh
   gh secret set AUR_SSH_PRIVATE_KEY < ~/.ssh/aur
   gh secret set AUR_USERNAME --body 'your-aur-username'
   gh secret set AUR_EMAIL    --body 'you@example.com'
   ```
3. Publish a release. The first run creates the `tokori-bin` package on
   the AUR; later runs update it.

## Test the PKGBUILD locally

On an Arch box, render it by hand and build in a clean chroot:

```sh
sed -e "s/__VERSION__/0.1.0/g" \
    -e "s/__SHA256__/$(curl -fsSL https://github.com/tokoriai/tokori/releases/download/v0.1.0/tokori_0.1.0_amd64.deb | sha256sum | cut -d' ' -f1)/g" \
    PKGBUILD.template > PKGBUILD
makepkg --printsrcinfo > .SRCINFO
makepkg -si        # build + install
namcap PKGBUILD    # lint (optional)
```
