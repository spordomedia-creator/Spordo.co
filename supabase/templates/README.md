# Supabase auth email templates

Source of truth for the branded auth emails (project `spordo` / `avwvtjsabmhqqeosqubw`).
Supabase doesn't read these files — paste each into **Authentication → Emails → Templates** and save.

| File | Dashboard template | Subject | Used by the site? |
|---|---|---|---|
| `confirmation.html` | Confirm signup | Confirm your SPORDO email | yes (signUp, resend-verification) |
| `recovery.html` | Reset Password | Reset your SPORDO password | yes (forgot-password) |
| `magic_link.html` | Magic Link | Your SPORDO sign-in link | no |
| `email_change.html` | Change Email Address | Confirm your new SPORDO email | no |
| `invite.html` | Invite user | You're invited to SPORDO | no |
| `reauthentication.html` | Reauthentication | Your SPORDO verification code | no |

Keep the `{{ .ConfirmationURL }}` / `{{ .Token }}` / `{{ .Email }}` / `{{ .NewEmail }}` variables exactly as written.
The logo is served from `public/images/logo-mark.png`; don't rename or remove it while these are live.
