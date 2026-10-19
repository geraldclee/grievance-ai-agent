# grievance-ai-agent

A standalone AI agent that helps employees raise a workplace grievance, informally or formally, following the company Grievance Policy. It runs on its own, separate from the Concierge HR agent: its own Cloudflare Worker, its own storage, its own secrets.

| Page | Who uses it | What it does |
|---|---|---|
| `/` | Employees | Chat with the AI (GPT-OSS 120B on Cloudflare Workers AI, same model as Concierge-hr-AI-Agent). Choose the informal route (request a confidential talk) or the formal route (Grievance Form). |
| `/hr` | HR / People Ops | See cases, acknowledge, escalate Team Lead → Department Lead → People Ops, record decisions, read the AI triage. |
| `/admin` | Admin | Edit the AI system prompt (guardrails), emergency contact and policy link. |

## How it works

- **AI conversation.** Free-text messages go to the AI model on Cloudflare Workers AI with the admin-editable system prompt. The model replies and classifies the intent (grievance, informal, formal, exit, question) and whether there is a safety risk.
- **Structured submission.** Once the employee picks a route, the app shows fixed, consented steps. The AI never collects or submits the grievance itself.
- **Policy routing.** Formal grievances go to the Team Lead first. If the grievance concerns the Team Lead it starts with the Department Lead; if it concerns the Department Lead it starts with People Ops. Stage deadlines are 1, 2 and 3 weeks. Acknowledgement is due within two business hours (09:00–18:00, Mon–Fri, company time zone).
- **AI triage for HR.** Each formal grievance gets an advisory category, risk level and neutral summary from the AI model. HR always decides.
- **Safety.** If the employee mentions a safety risk (detected by the AI model and by a keyword backstop) or answers "yes" to the safety question, the emergency contact is shown and the case is flagged urgent.
- **Fallback.** If GPT-OSS fails, the agent retries with Llama 3.3 70B. If the AI is unavailable, or the free daily allowance is used up, the chat still offers the two routes so no employee is stuck.
- **Email to HR (optional).** If Resend is configured, HR gets a confidential notification with a case link only, no grievance details.

## Project structure

```
grievance-ai-agent/
├── src/
│   ├── index.js      # Worker: API routes, Workers AI calls, case storage, HR + admin APIs
│   ├── prompt.js     # Default system prompt, fixed output format, triage prompt
│   └── policy.js     # Grievance Policy routing ladder and business-hours maths
├── public/
│   ├── index.html    # Employee chat
│   ├── app.js
│   ├── hr.html       # HR console
│   ├── hr.js
│   ├── admin.html    # Admin settings
│   ├── admin.js
│   └── styles.css
├── wrangler.jsonc    # Cloudflare Worker config
├── package.json
└── .dev.vars.example # Template for local secrets
```

## Deploy (GitHub → Cloudflare)

### 1. Put the code on GitHub
Create a new repository named `grievance-ai-agent` and upload all files from this folder (keep the folder structure).

### 2. Create the storage (KV namespace)
Cloudflare dashboard → **Storage & Databases → KV → Create** → name it `GRIEVANCE_KV`.
Copy its **ID** and paste it into `wrangler.jsonc`, replacing `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`. Commit the change.

### 3. Connect the repo to Cloudflare
Cloudflare dashboard → **Workers & Pages → Create → Import a repository** → choose `grievance-ai-agent`.
- Build command: leave empty
- Deploy command: `npx wrangler deploy`

Every push to `main` now redeploys automatically.

### 4. Add secrets
Worker → **Settings → Variables and Secrets → Add** (type **Secret**):

| Name | Required | Value |
|---|---|---|
| `HR_PASSWORD` | Yes | Password for the HR console |
| `ADMIN_PASSWORD` | Yes | Password for the admin page (use a different one) |
| `RESEND_API_KEY` | Optional | For email notifications to HR |
| `HR_NOTIFY_EMAIL` | Optional | HR mailbox, comma-separated for several |
| `MAIL_FROM` | Optional | Sender, e.g. `Grievance Agent <grievance@yourdomain.com>` (domain verified in Resend) |

No AI key is needed: the `ai` binding in `wrangler.jsonc` gives the Worker access to Cloudflare Workers AI on your account.

Plain settings live in `wrangler.jsonc` under `vars`: `AI_MODEL` (default `@cf/openai/gpt-oss-120b`, OpenAI's open model), `AI_BACKUP_MODEL` (default `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, used only if the main model fails or returns unreadable output), `TZ_OFFSET_HOURS` (8 for Singapore) and `COMPANY_NAME`. Change them in the file, not the dashboard, because each deploy applies the file's values.

### 5. Try it
Open `https://grievance-ai-agent.<your-subdomain>.workers.dev`:
1. Type "I want to raise a grievance" and go through the formal form.
2. Open `/hr`, sign in with `HR_PASSWORD`, and see the case with its routing, deadlines and AI triage.
3. Open `/admin` to change the guardrails in the system prompt.

## Run locally

```bash
npm install
cp .dev.vars.example .dev.vars   # then set the HR and admin passwords
npx wrangler login                # Workers AI runs on your Cloudflare account, even locally
npx wrangler dev                  # http://localhost:8787
```

## Notes for the prototype

- This is a feasibility prototype. Passwords protect the HR and admin pages; a production version would use company single sign-on (for example Cloudflare Access) and verified employee identity.
- Supporting documents are listed by name; HR requests copies through a secure channel. File upload (Cloudflare R2) is future work.
- Calendar booking for informal discussions is future work; employees give a preferred time instead.
- Grievance text is processed by Workers AI on Cloudflare's network for the chat and triage; it is not sent to a third-party AI provider. Confirm this fits the client's data policy before using real data.

## AI cost

Workers AI includes 10,000 Neurons per day free on both the Workers Free and Paid plans. That is roughly 100 chat messages a day, enough for development and a demo. Past the allowance, the free plan stops AI calls until the next day (the chat falls back to the fixed options); the paid plan charges $0.011 per 1,000 Neurons. For more free messages, set `AI_MODEL` to `@cf/openai/gpt-oss-20b` or `@cf/meta/llama-3.1-8b-instruct`: smaller, cheaper and less fluent. Usage is visible under **AI → Workers AI** in the Cloudflare dashboard.
