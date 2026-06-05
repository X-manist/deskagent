# macOS Distribution

DeskAgent has two separate macOS distribution paths:

- Direct download from GitHub or the website: sign with a Developer ID Application certificate, notarize with Apple, then publish the DMG/ZIP.
- Mac App Store: build a separate MAS target with App Sandbox, App Store signing identities, provisioning profiles, and App Store Connect review.

The current public release path should use Developer ID first. The app bundles a local agent runtime, installs dynamic skills, and controls desktop apps, so a Mac App Store build needs separate product and security design.

## Developer ID And Notarization

Prerequisites:

- Active Apple Developer Program membership.
- `Developer ID Application` certificate for signing the `.app`.
- Apple notarization credentials. Prefer App Store Connect API key credentials for CI.
- Xcode command line tools on the macOS build machine.

Create the certificate:

1. Open Apple Developer `Certificates, Identifiers & Profiles`.
2. Add a certificate.
3. Select `Developer ID Application`.
4. Upload the certificate signing request, download the `.cer`, and install it into Keychain Access.
5. Export the certificate and private key from Keychain Access as a password-protected `.p12`.

For GitHub Actions, store the `.p12` as a base64 secret and keep all secrets out of the repository:

```bash
base64 -i DeveloperIDApplication.p12 | tr -d '\n' | pbcopy
```

Recommended GitHub Actions secrets:

```text
CSC_LINK=<base64 p12 content or a secure URL to the p12>
CSC_KEY_PASSWORD=<p12 password>
APPLE_API_KEY_B64=<base64 contents of the .p8 key>
APPLE_API_KEY_ID=<App Store Connect API key id>
APPLE_API_ISSUER=<App Store Connect issuer id>
```

In CI, decode `APPLE_API_KEY_B64` into a temporary `.p8` file and export `APPLE_API_KEY` as that absolute file path before running `electron-builder`.

Alternative Apple ID notarization secrets:

```text
APPLE_ID=<Apple ID email>
APPLE_APP_SPECIFIC_PASSWORD=<app-specific password>
APPLE_TEAM_ID=<10-character team id>
```

Build:

```bash
npm --prefix app run dist:mac
```

Verify the app and DMG:

```bash
codesign --verify --deep --strict --verbose=4 "app/release/mac-arm64/智界桌面助手.app"
spctl -a -vvv -t exec "app/release/mac-arm64/智界桌面助手.app"
hdiutil verify "app/release/智界桌面助手-0.1.0-arm64.dmg"
spctl -a -vvv -t open "app/release/智界桌面助手-0.1.0-arm64.dmg"
```

Expected production result after Developer ID signing and notarization:

- `codesign` passes.
- `spctl` accepts the app as notarized Developer ID software.
- The downloaded DMG opens without a "damaged" warning under default Gatekeeper settings.

When no Developer ID identity is available, `app/scripts/after-pack.js` ad-hoc signs the packaged `.app` to keep the bundle signature structurally valid. This is only for internal/testing builds. It does not replace Developer ID signing or notarization.

## Mac App Store

Mac App Store distribution is not the same artifact as the direct-download DMG.

High-level steps:

1. Join the Apple Developer Program and sign current agreements.
2. Create or select the bundle ID in Apple Developer.
3. Create a macOS app record in App Store Connect.
4. Add App Sandbox entitlements and remove or redesign behaviors that conflict with sandboxing and review.
5. Configure MAS signing certificates and provisioning profiles.
6. Build a separate `mas` target.
7. Upload the build through Xcode, Transporter, or App Store Connect API tooling.
8. Fill in privacy policy, app metadata, screenshots, encryption/export-compliance answers, and review notes.
9. Submit for App Review.

Do not try to reuse the Developer ID DMG for App Store submission. The App Store build should be a separate target with separate entitlements and a reduced capability surface.
