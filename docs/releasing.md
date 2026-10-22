# Releasing a new version

Users get new versions automatically: once a day memdrive checks
**GitHub Releases** and installs the newest one. Pushing to `main` alone does
not reach users, so you can work on `main` freely. A version goes out only when
you publish a release.

## Steps

1. Make your changes and run the tests: `bun test`
2. Bump `"version"` in `package.json` (for example `0.3.0` → `0.4.0`).
3. Commit and push to `main`.
4. Publish the release (the tag must be `v` + the version):

   ```sh
   gh release create v0.4.0 --title "memdrive 0.4.0" --notes "What changed, in plain words."
   ```

That's it. Everyone's memdrive picks it up within a day, new installs get it
immediately, and `memdrive update` installs it right away. The release notes are
shown to people who run `memdrive update`.

## If a release is broken

Publish a fixed version with a higher number (for example `v0.4.1`). Don't
delete or reuse a release tag.
