# AGENTS.md

You are an AI agent. Someone wants their own private copy of the ZWILLING FRESH & SAVE
backend running, with the app on their phone pointed at it. Do the work for them.
Follow these steps in order. Only stop to ask when a step needs their account, a
password, or a decision.

## How to run commands

Two kinds of steps. Respect the difference or the setup will hang or fail:

- **[USER]** Interactive or visual: a browser opens, it prompts for input, or it prints
  live colored output. You cannot answer prompts or see the browser. **Give the exact
  command to the user and ask them to run it in their own terminal, then paste the
  result back.** Never run these yourself in a captured/non-interactive shell.
- **[YOU]** Non-interactive: takes all input as arguments and just prints a result. Run
  these yourself.

## What you are delivering

A live Cloudflare Worker backend, a login account, and (optionally) the patched Android
app they can install. The backend deploy is one script; most of your job is driving it
and handling the phone side.

## 1. Prerequisites

- **[YOU]** Check `git`, `bun`, `python3`, `openssl` are installed; install any missing.
- **[USER]** A Cloudflare account (free): https://dash.cloudflare.com/sign-up.
- **[USER]** Enable R2 once: Cloudflare dashboard, click R2, click Enable (free tier, no
  card for this). Bucket creation fails otherwise. This is a dashboard click, only they
  can do it.

## 2. Get the code

- **[YOU]**
  ```bash
  git clone https://github.com/KazeTachinuu/zwilling-remake && cd zwilling-remake
  ```

## 3. Deploy the backend  (USER runs this)

- **[USER]** `./install.sh`, in their own terminal. It is interactive: it opens a
  browser to log into Cloudflare, prints live progress, and prompts. Brief them first on
  the answers:
  - **Custom domain?** Tell them to press Enter for a free `*.workers.dev` URL unless
    they own a short domain and want it.
  - **Open registration?** Tell them to answer `n` unless they want anyone to sign up.
  - **First account:** it asks for an email and password. Have them pick a strong one.
  - Ask them to paste the final output (it prints their backend URL).

## 4. Verify  (USER runs this)

- **[USER]** `./check.sh` in their terminal (live colored output). Every check must pass
  (TLS, health, D1 seeded, GraphQL, R2). Have them paste the result; if a line fails,
  fix per its message and have them re-run.

## 5. Add family accounts

- **[YOU]** Registration is closed, so create each account (non-interactive):
  ```bash
  cd cloudflare && bun run admin:create-user -- their@email 'a strong password' --remote
  ```
  Give each person their email and password privately.

## 6. The phone app

One person builds it once; everyone else just downloads it.

- **[USER]** Get the genuine ZWILLING app from
  [APKMirror](https://www.apkmirror.com/?s=com.zwilling.rapier) (it verifies the
  developer signature). Never a random "apk" site: that is how people get malware.
- **[USER]** Build the universal APK per `tools/README.md` (needs `java` 17+; runs on
  their machine). For push, they also need a Firebase `google-services.json`, see
  "Push (optional)" in `README.md`. Push is optional; everything works without it.
- **[YOU]** Publish their build so family can install by tapping (no adb):
  ```bash
  cd cloudflare
  bunx wrangler r2 object put zwilling-photos/_dist/zwilling.apk \
    --file /path/to/zwilling-universal.apk --remote
  ```
  Family opens `https://THEIR-BACKEND/app`, taps Download, allows "install unknown
  apps", and uninstalls the Play Store version first (different signature).

## 7. Options

- **French UI**: **[YOU]** set `"APP_LOCALE": "fr"` in `cloudflare/wrangler.jsonc`, then
  `cd cloudflare && bun run deploy`. Default is English.
- **Push reminders**: follow "Push (optional)" in `README.md`.

## Done when

`./check.sh` is green, they can log in from the app, and (if they built it) `/app`
serves the APK. Hand them three things: their backend URL, their login, and the
`admin:create-user` command to add more people.

---

If instead you are modifying the code, the dev commands live in `cloudflare/`
(`bun test`, `bun run typecheck`, `bun run dev`, `bun run format`). Tests must stay
green and `wrangler.jsonc` ships blank (no real ids or secrets).
