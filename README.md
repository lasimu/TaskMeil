# Taskmeil

Mail, tasks and calendar in one view. A web app (PWA) that runs in the browser and
installs to the home screen of a phone or computer.

- **Left:** inbox. **Middle top:** reading pane. **Middle bottom:** tasks (Microsoft To Do).
  **Right:** the day's calendar; click an empty time to add an event, click an event to change it.
  On a phone one pane shows at a time, with tabs at the bottom.
- **Sign-in:** Microsoft work account (MSAL.js, Uus Maa Entra tenant).
- **Data:** straight from Microsoft Graph in the browser. Nothing is stored on our server.
- **Claude:** turns an email into a task suggestion and writes reply drafts. Claude never sends
  anything; a message goes out only when the user presses "Saada". The browser calls the
  Anthropic API directly with the user's own API key.
- **Hosting:** Azure Static Web Apps (Free), static files only; there is no server code.

## Layout

| Path | What it is |
|---|---|
| `public/` | The app: plain HTML, CSS and JavaScript modules, no build step |
| `public/config.js` | Entra client ID and tenant ID (not secrets) |
| `public/auth/` | Page that receives the Microsoft sign-in answer (MSAL v5 redirect bridge) |
| `public/vendor/` | MSAL.js and the Anthropic SDK, copied and bundled from npm with `npm run vendor` |
| `public/js/claude.js` | Prompts and the call to the Anthropic API |
| `public/staticwebapp.config.json` | Routing and security headers for Azure |
| `tools/smoke-test.mjs` | Headless test against a fake Graph (`npm test`) |

## Setting it up

### 1. Entra app registration (Uus Maa tenant)

Entra admin center → App registrations → New registration.

- Name: `Taskmeil`. Supported accounts: this organisation only.
- Redirect URI, platform **Single-page application**: `https://<your-site>/auth/`
  (the trailing slash matters). For local testing also add `http://localhost:4280/auth/`.
- API permissions → Microsoft Graph → Delegated: `User.Read`, `Mail.ReadWrite`, `Mail.Send`,
  `Calendars.ReadWrite`, `Tasks.ReadWrite`, `People.Read`. Then "Grant admin consent".
- Copy the Application (client) ID and Directory (tenant) ID into `public/config.js`.

### 2. Azure Static Web App

Azure portal → Create → Static Web App, plan **Free**, deployment source **Other**.

- Copy the deployment token (Overview → Manage deployment token) into this repository as the
  secret `AZURE_STATIC_WEB_APPS_API_TOKEN_ICY_SKY_0C0D9F10F` (GitHub → Settings → Secrets and variables → Actions).

Every push to `main` then runs the smoke test and deploys. Until the secret exists the
workflow only runs the test.

### 3. Claude API key

Create an API key at platform.claude.com. On a Max, Ultra or Team plan, first link the plan's
monthly API credits to that Console organization (claude.ai → Settings → Billing → API credits),
so usage is paid from the subscription. In Taskmeil, open "Kulu ja limiit" and paste the key.
It is stored in that browser only, so enter it once on each device.

### 4. Install on a device

Open the site, sign in, then use "Install app" (Chrome, Edge) or Share → "Add to Home Screen" (iPhone).

## How Claude is kept in its place

- The browser sends the email text straight to the Anthropic API with the key saved in that
  browser. Nothing passes through a server of ours. Anyone with access to the browser profile can
  read the key, so use it on your own devices only.
- Claude gets text and returns text. It holds no Microsoft Graph token, so it cannot read or send mail.
- Claude's output only fills an editable form. Saving a task or sending a reply is a separate click.
- Email content is passed to Claude as data; instructions inside an email are not followed.
- Inbox suggestions: the sender, subject and first lines of each new inbox email are sent to Claude
  once, automatically, so it can mark the ones worth a task. A mark adds nothing; the user confirms
  each task. Verdicts are remembered in the browser, so an email is not sent twice.

## Working on it

```bash
npm install          # test tools and MSAL
npm test             # headless smoke test
npm run vendor       # refresh public/vendor after updating MSAL or the Anthropic SDK
```

To run locally, install the Static Web Apps CLI (`npm i -g @azure/static-web-apps-cli`) and
run `npm start`.

## Not built yet

- Opening attachments (use "Ava Outlookis"). Pictures inside an email are shown.
- Folders other than the inbox; rich-text composing.
- Editing a task after it is created (complete it here, edit in To Do).
