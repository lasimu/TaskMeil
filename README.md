# Taskmeil

Mail, tasks and calendar in one view. A web app (PWA) that runs in the browser and
installs to the home screen of a phone or computer.

- **Left:** inbox. **Middle top:** reading pane. **Middle bottom:** tasks (Microsoft To Do).
  **Right:** the day's calendar; click an empty time to add an event, click an event to change it.
  On a phone one pane shows at a time, with tabs at the bottom.
- **Sign-in:** Microsoft work account (MSAL.js, Uus Maa Entra tenant).
- **Data:** straight from Microsoft Graph in the browser. Nothing is stored on our server.
- **Claude:** turns an email into a task suggestion and writes reply drafts. Claude never sends
  anything; a message goes out only when the user presses "Saada".
- **Hosting:** Azure Static Web Apps (Free) with one API function.

## Layout

| Path | What it is |
|---|---|
| `public/` | The app: plain HTML, CSS and JavaScript modules, no build step |
| `public/config.js` | Entra client ID and tenant ID (not secrets) |
| `public/auth/` | Page that receives the Microsoft sign-in answer (MSAL v5 redirect bridge) |
| `public/vendor/` | MSAL.js, copied from npm with `npm run vendor` |
| `public/staticwebapp.config.json` | Routing and security headers for Azure |
| `api/` | Azure Function `POST /api/claude`, the only place the Anthropic API key is used |
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
- In the Static Web App → Environment variables, add:

| Name | Value |
|---|---|
| `AWS_BEARER_TOKEN_BEDROCK` | Amazon Bedrock API key. With this set, Claude runs through Bedrock and email text stays inside AWS |
| `AWS_REGION` | Bedrock region, e.g. `eu-north-1`. Required with the Bedrock key |
| `ANTHROPIC_API_KEY` | Alternative to the two above: key from console.anthropic.com |
| `ENTRA_TENANT_ID` | Same as `tenantId` in `public/config.js` |
| `ENTRA_CLIENT_ID` | Same as `clientId` in `public/config.js` |
| `ALLOWED_USERS` | Optional. Comma-separated sign-in addresses allowed to use Claude |
| `CLAUDE_MODEL` | Optional. Defaults to `claude-opus-5-5` (`anthropic.claude-opus-5-5` on Bedrock) |

Every push to `main` then runs the smoke test and deploys. Until the secret exists the
workflow only runs the test.

### 3. Install on a device

Open the site, sign in, then use "Install app" (Chrome, Edge) or Share → "Add to Home Screen" (iPhone).

## How Claude is kept in its place

- The browser sends the email text to `/api/claude` with the user's Microsoft ID token. The
  function checks the token's signature, tenant and app before calling Anthropic.
- The function holds no Microsoft Graph token, so it cannot read or send mail.
- Claude's output only fills an editable form. Saving a task or sending a reply is a separate click.
- Email content is passed to Claude as data; instructions inside an email are not followed.
- "Claude: tee kirjadest ülesanded": on the user's click, the sender, subject and first lines of the
  inbox emails not yet looked at are sent to Claude, and a To Do task is added for each one worth
  doing. Nothing goes to Claude without that click. Verdicts are remembered in the browser, so an
  email is sent once and never gets a second task.

## Working on it

```bash
npm install          # test tools and MSAL
npm test             # headless smoke test
npm run vendor       # refresh public/vendor after updating MSAL
cd api && npm install
```

To run locally, install the Static Web Apps CLI (`npm i -g @azure/static-web-apps-cli`) and
Azure Functions Core Tools, copy `api/local.settings.example.json` to `api/local.settings.json`,
fill it in, and run `npm start`.

## Not built yet

- Opening attachments (use "Ava Outlookis"). Pictures inside an email are shown.
- Folders other than the inbox; rich-text composing.
- Editing a task after it is created (complete it here, edit in To Do).
