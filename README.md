# Taskmeil

Mail, tasks and calendar in one view. A web app (PWA) that runs in the browser and
installs to the home screen of a phone or computer.

- **Left:** inbox. **Middle top:** reading pane. **Middle bottom:** tasks (Microsoft To Do).
  **Right:** the day's calendar; click an empty time to add an event, click an event to change it.
  On a phone one pane shows at a time, with tabs at the bottom.
- **Sign-in:** Microsoft work account (MSAL.js, Uus Maa Entra tenant).
- **Data:** straight from Microsoft Graph in the browser. Nothing is stored on our server.
- **Claude:** works through the user's own Claude subscription, in Claude's own app. It marks
  the emails that need action with an Outlook category, and Taskmeil shows the marks. For a reply,
  Taskmeil copies the email and opens Claude. Taskmeil itself never calls Claude and holds no API key.
- **Hosting:** Azure Static Web Apps (Free), static files only; there is no server code.

## Layout

| Path | What it is |
|---|---|
| `public/` | The app: plain HTML, CSS and JavaScript modules, no build step |
| `public/config.js` | Entra client ID and tenant ID (not secrets) |
| `public/auth/` | Page that receives the Microsoft sign-in answer (MSAL v5 redirect bridge) |
| `public/vendor/` | MSAL.js, copied from npm with `npm run vendor` |
| `public/js/claude.js` | The category names and the texts handed to Claude |
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

### 3. Claude (subscription)

In claude.ai, connect the Microsoft 365 connector. In Taskmeil, press "Claude" in the top bar and
copy the request shown there. Paste it into a Claude chat, or save it as a scheduled task in
claude.ai so it runs every working morning. Claude then puts the category `Claude: ülesanne` (and
`Claude: kiire` for urgent mail) on the emails that need action.

### 4. Install on a device

Open the site, sign in, then use "Install app" (Chrome, Edge) or Share → "Add to Home Screen" (iPhone).

## How Claude is kept in its place

- Taskmeil sends nothing to Claude. Claude reads the mailbox through its own Microsoft 365
  connector, under the user's Claude account.
- The request tells Claude to add categories only: no replies, moves or deletions.
- A mark adds nothing. The user confirms each task, and Taskmeil then takes Claude's categories
  off the message, leaving the user's own categories in place.
- A reply request is copied to the clipboard and pasted into Claude by the user. The answer comes
  back by hand, and a message goes out only when the user presses "Saada".

## Working on it

```bash
npm install          # test tools and MSAL
npm test             # headless smoke test
npm run vendor       # refresh public/vendor after updating MSAL
```

To run locally, install the Static Web Apps CLI (`npm i -g @azure/static-web-apps-cli`) and
run `npm start`.

## Not built yet

- Opening attachments (use "Ava Outlookis"). Pictures inside an email are shown.
- Folders other than the inbox; rich-text composing.
- Editing a task after it is created (complete it here, edit in To Do).
