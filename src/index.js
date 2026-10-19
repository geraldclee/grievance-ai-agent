// grievance-ai-agent — Cloudflare Worker
// Employee chat (Cloudflare Workers AI) + structured grievance submission + HR console + admin prompt editor.

import { DEFAULT_SYSTEM_PROMPT, OUTPUT_CONTRACT, TRIAGE_PROMPT } from './prompt.js';
import { LADDER, INFORMAL_CONTACTS, startLevel, addBusinessHours, addBusinessDays, addDays } from './policy.js';

const DEFAULT_CONFIG = {
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  emergencyContact: '[emergency or designated workplace contact]',
  policyUrl: '',
};

const FORMAL_FIELDS = {
  nature:  { max: 500, required: true,  label: 'Nature of grievance' },
  when:    { max: 500, required: true,  label: 'When it occurred' },
  where:   { max: 500, required: true,  label: 'Where it happened' },
  who:     { max: 500, required: false, label: 'People involved / witnesses' },
  how:     { max: 500, required: true,  label: 'What happened' },
  impact:  { max: 500, required: true,  label: 'Impact' },
  outcome: { max: 500, required: true,  label: 'Resolution sought' },
  docs:    { max: 500, required: false, label: 'Supporting documents' },
};

const RX_URGENT = /\b(unsafe|danger\w*|threat\w*|hurt\w*|violen\w*|weapon\w*|kill\w*|suicid\w*|self[- ]?harm\w*|assault\w*|attack\w*)\b/i;
const RX_GRIEVANCE = /\b(grievance|complain\w*|report\w*|bull(y|ied|ying)|harass\w*|unfair\w*|discriminat\w*|mistreat\w*|toxic|abus\w*|hostile|retaliat\w*)\b/i;

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      console.error('Unhandled error', err && err.stack || err);
      return json({ error: 'Something went wrong on our side. Please try again.' }, 500);
    }
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);

  // ---- public ----
  if (path === '/api/config' && method === 'GET') {
    const cfg = await getConfig(env);
    return json({ emergencyContact: cfg.emergencyContact, policyUrl: cfg.policyUrl, company: env.COMPANY_NAME || '' });
  }
  if (path === '/api/chat' && method === 'POST') return chat(request, env);
  if (path === '/api/cases' && method === 'POST') return createCase(request, env, ctx);

  // ---- HR console ----
  if (path.startsWith('/api/hr/')) {
    const denied = checkAuth(request, env.HR_PASSWORD, 'HR_PASSWORD');
    if (denied) return denied;
    if (path === '/api/hr/login' && method === 'POST') return json({ ok: true });
    if (path === '/api/hr/cases' && method === 'GET') return listCases(env, url.origin);
    const m = path.match(/^\/api\/hr\/cases\/(GRV-\d{4}-\d{4,})(\/action)?$/);
    if (m && method === 'GET' && !m[2]) {
      const c = await getCase(env, m[1]);
      return c ? json(c) : json({ error: 'Case not found.' }, 404);
    }
    if (m && method === 'POST' && m[2]) return caseAction(request, env, m[1]);
  }

  // ---- admin ----
  if (path.startsWith('/api/admin/')) {
    const denied = checkAuth(request, env.ADMIN_PASSWORD, 'ADMIN_PASSWORD');
    if (denied) return denied;
    if (path === '/api/admin/config' && method === 'GET') {
      return json({ ...(await getConfig(env)), defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT, model: env.AI_MODEL || DEFAULT_MODEL });
    }
    if (path === '/api/admin/config' && method === 'PUT') return saveConfig(request, env);
    if (path === '/api/admin/config/reset' && method === 'POST') {
      await env.GRIEVANCE_KV.delete('config');
      return json(await getConfig(env));
    }
  }

  return json({ error: 'Not found.' }, 404);
}

/* ================= chat ================= */

async function chat(request, env) {
  const body = await readJson(request);
  if (!body || !Array.isArray(body.messages) || !body.messages.length) {
    return json({ error: 'Send a message to start.' }, 400);
  }
  const messages = body.messages.slice(-20).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.text || '').slice(0, 2000),
  })).filter(m => m.content);
  // The conversation must start with a user turn
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length) return json({ error: 'Send a message to start.' }, 400);

  const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const keywordUrgent = RX_URGENT.test(lastUser);
  const cfg = await getConfig(env);

  try {
    const out = await llm(env, `${cfg.systemPrompt}\n\nEmergency or designated workplace contact: ${cfg.emergencyContact}\n\n${OUTPUT_CONTRACT}`, messages, {
      type: 'object',
      properties: {
        reply: { type: 'string' },
        intent: { type: 'string', enum: ['grievance', 'informal', 'formal', 'exit', 'question', 'other'] },
        urgent: { type: 'boolean' },
      },
      required: ['reply', 'intent', 'urgent'],
    }, 0.3, 400);
    const intents = ['grievance', 'informal', 'formal', 'exit', 'question', 'other'];
    const reply = String(out.reply || '').trim();
    if (!reply) throw new Error('Model returned an empty reply');
    return json({
      reply: reply.slice(0, 1500),
      intent: intents.includes(out.intent) ? out.intent : 'other',
      urgent: out.urgent === true || out.urgent === 'true' || keywordUrgent,
      ai: true,
    });
  } catch (err) {
    console.error('AI chat failed', String(err));
    // Fallback keeps the employee moving if the AI is unavailable or the free daily allowance is used up.
    const grievance = RX_GRIEVANCE.test(lastUser) || keywordUrgent;
    return json({
      reply: grievance
        ? "I'm sorry to hear that. You can raise your concern informally by speaking with your Team Lead or People Ops, or formally by completing the Grievance Form. Which would you prefer?"
        : 'I can help you raise a concern about something at work, informally or formally. Would you like to do that?',
      intent: 'grievance',
      urgent: keywordUrgent,
      ai: false,
    });
  }
}

// Cloudflare Workers AI (free daily allowance, no API key).
// Default: OpenAI's open model GPT-OSS 120B, same as Concierge-hr-AI-Agent.
// Backup: Llama 3.3 70B with JSON Mode, used only if the primary model fails or returns unreadable output.
const DEFAULT_MODEL = '@cf/openai/gpt-oss-120b';
const BACKUP_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const JSON_MODE_MODELS = ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct', '@cf/meta/llama-3-8b-instruct'];

async function llm(env, system, messages, schema, temperature, maxTokens) {
  if (!env.AI) throw new Error('Workers AI binding "AI" is missing from wrangler.jsonc');
  const primary = env.AI_MODEL || DEFAULT_MODEL;
  const backup = env.AI_BACKUP_MODEL || BACKUP_MODEL;
  try {
    return await runModel(env, primary, system, messages, schema, temperature, maxTokens);
  } catch (err) {
    if (!backup || backup === primary) throw err;
    console.warn(`Primary model ${primary} failed (${String(err).slice(0, 200)}); trying ${backup}`);
    return runModel(env, backup, system, messages, schema, temperature, maxTokens);
  }
}

async function runModel(env, model, system, messages, schema, temperature, maxTokens) {
  const jsonMode = JSON_MODE_MODELS.includes(model);
  const instructions = jsonMode ? system
    : `${system}\n\nReturn only one JSON object that matches this JSON Schema, with no other text before or after it:\n${JSON.stringify(schema)}`;
  const input = {
    messages: [{ role: 'system', content: instructions }, ...messages],
    temperature,
    // reasoning models spend part of the budget thinking, so give them more room
    max_tokens: jsonMode ? maxTokens : maxTokens + 1500,
  };
  if (jsonMode) input.response_format = { type: 'json_schema', json_schema: schema };
  const result = await env.AI.run(model, input);
  const out = parseJson(extractText(result));
  if (!out) throw new Error(`${model} returned no readable JSON`);
  return out;
}

// Workers AI models return different shapes; accept all of them.
function extractText(r) {
  if (r == null) return '';
  if (typeof r === 'string') return r;
  if (r.response !== undefined) return typeof r.response === 'string' ? r.response : JSON.stringify(r.response);
  if (typeof r.output_text === 'string') return r.output_text;
  const choice = r.choices?.[0];
  if (choice) return choice.message?.content ?? choice.text ?? '';
  if (Array.isArray(r.output)) { // Responses API style: take the final message, skip reasoning items
    const msg = [...r.output].reverse().find(o => o.type === 'message' || Array.isArray(o.content));
    const parts = msg?.content || [];
    return parts.map(c => (typeof c === 'string' ? c : c.text || '')).join('');
  }
  return '';
}

function parseJson(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(cleaned); } catch (_) {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) { return null; }
}

/* ================= case submission ================= */

async function createCase(request, env, ctx) {
  const b = await readJson(request);
  if (!b) return json({ error: 'The submission could not be read. Please try again.' }, 400);

  const name = clean(b.name, 100);
  const email = clean(b.email, 200);
  if (!name) return json({ error: 'Please enter your name.' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Please enter a valid work email.' }, 400);
  if (b.consent !== true) return json({ error: 'Please confirm you agree to share this information.' }, 400);

  const tz = Number(env.TZ_OFFSET_HOURS || 8);
  const now = new Date();
  const base = {
    id: await nextId(env, now),
    createdAt: now.toISOString(),
    ackDue: addBusinessHours(now, 2, tz).toISOString(),
    ackedAt: null,
    closedAt: null,
    status: 'New',
    employee: { name, email },
    history: [{ at: now.toISOString(), by: 'Grievance Agent', text: 'Submitted by employee' }],
  };

  let c;
  if (b.type === 'informal') {
    if (!INFORMAL_CONTACTS[b.contact]) return json({ error: 'Please choose who you would like to speak with.' }, 400);
    const when = clean(b.when, 200);
    if (!when) return json({ error: 'Please give a preferred date and time.' }, 400);
    c = { ...base, type: 'Informal', contact: b.contact, contactName: INFORMAL_CONTACTS[b.contact], when,
          summary: 'Request for an informal discussion', urgent: false };
  } else if (b.type === 'formal') {
    const fields = {};
    for (const [k, rule] of Object.entries(FORMAL_FIELDS)) {
      const v = String(b.fields?.[k] ?? '').trim();
      if (rule.required && !v) return json({ error: `Please complete: ${rule.label}.` }, 400);
      if (v.length > rule.max) return json({ error: `${rule.label} must be ${rule.max} characters or fewer.` }, 400);
      fields[k] = v;
    }
    if (!['none', 'team_lead', 'department_lead'].includes(b.about)) return json({ error: 'Please say whether the grievance concerns your Team Lead or Department Lead.' }, 400);
    if (!['yes', 'no'].includes(b.safety)) return json({ error: 'Please answer the safety question.' }, 400);
    const level = startLevel(b.about);
    c = { ...base, type: 'Formal', fields, about: b.about, safety: b.safety, urgent: b.safety === 'yes' || RX_URGENT.test(Object.values(fields).join(' ')),
          level, startLevel: level, stageStartedAt: now.toISOString(),
          stageDue: addDays(now, LADDER[level].days).toISOString(),
          summary: fields.nature.slice(0, 120), triage: await triage(env, fields) };
  } else {
    return json({ error: 'Unknown submission type.' }, 400);
  }

  await env.GRIEVANCE_KV.put(`case:${c.id}`, JSON.stringify(c));
  const index = (await env.GRIEVANCE_KV.get('cases:index', 'json')) || [];
  index.unshift(c.id);
  await env.GRIEVANCE_KV.put('cases:index', JSON.stringify(index.slice(0, 1000)));

  ctx.waitUntil(notifyHR(env, c, new URL(request.url).origin));

  return json({
    id: c.id,
    type: c.type,
    ackDue: c.ackDue,
    firstReviewer: c.type === 'Formal' ? LADDER[c.level].name : c.contactName,
    urgent: c.urgent,
  }, 201);
}

async function triage(env, fields) {
  try {
    const text = Object.entries(fields).filter(([, v]) => v).map(([k, v]) => `${FORMAL_FIELDS[k].label}: ${v}`).join('\n');
    const out = await llm(env, TRIAGE_PROMPT, [{ role: 'user', content: text }], {
      type: 'object',
      properties: {
        category: { type: 'string' },
        risk: { type: 'string', enum: ['low', 'medium', 'high'] },
        summary: { type: 'string' },
      },
      required: ['category', 'risk', 'summary'],
    }, 0.1, 300);
    const risk = ['low', 'medium', 'high'].includes(out.risk) ? out.risk : 'medium';
    return { category: String(out.category || 'Other').slice(0, 60), risk, summary: String(out.summary || '').slice(0, 500) };
  } catch (err) {
    console.error('Triage failed', String(err));
    return null;
  }
}

async function nextId(env, now) {
  const year = now.getUTCFullYear();
  const key = `cases:seq:${year}`;
  const n = Number(await env.GRIEVANCE_KV.get(key) || 0) + 1;
  await env.GRIEVANCE_KV.put(key, String(n));
  return `GRV-${year}-${String(n).padStart(4, '0')}`;
}

/* ================= HR ================= */

async function getCase(env, id) {
  return env.GRIEVANCE_KV.get(`case:${id}`, 'json');
}

async function listCases(env, origin) {
  const index = (await env.GRIEVANCE_KV.get('cases:index', 'json')) || [];
  const cases = (await Promise.all(index.slice(0, 200).map(id => getCase(env, id))))
    .filter(Boolean)
    .map(c => ({ ...c, notification: buildEmail(c, origin) }));
  return json({ cases });
}

async function caseAction(request, env, id) {
  const b = await readJson(request);
  const c = await getCase(env, id);
  if (!c) return json({ error: 'Case not found.' }, 404);
  const by = clean(b?.by, 80) || 'HR';
  const note = clean(b?.note, 1000);
  const now = new Date();
  const tz = Number(env.TZ_OFFSET_HOURS || 8);

  switch (b?.action) {
    case 'acknowledge':
      if (c.ackedAt) return json({ error: 'This case is already acknowledged.' }, 409);
      c.ackedAt = now.toISOString();
      c.status = 'Acknowledged';
      c.history.push({ at: c.ackedAt, by, text: 'Acknowledged; employee to be told the next steps' + (note ? ` — ${note}` : '') });
      break;
    case 'escalate':
      if (c.type !== 'Formal') return json({ error: 'Only formal grievances can be escalated.' }, 400);
      if (c.status === 'Closed') return json({ error: 'This case is closed.' }, 409);
      if (c.level >= LADDER.length - 1) return json({ error: 'People Ops is the final stage.' }, 409);
      c.level += 1;
      c.stageStartedAt = now.toISOString();
      c.stageDue = addDays(now, LADDER[c.level].days).toISOString();
      c.status = `With ${LADDER[c.level].name}`;
      c.history.push({ at: c.stageStartedAt, by, text: `Not resolved; referred to ${LADDER[c.level].name}` + (note ? ` — ${note}` : '') });
      break;
    case 'close':
      if (c.status === 'Closed') return json({ error: 'This case is already closed.' }, 409);
      if (c.type === 'Formal' && !note) return json({ error: 'Please record the decision before closing.' }, 400);
      c.status = 'Closed';
      c.closedAt = now.toISOString();
      if (c.type === 'Formal') c.appealDue = addBusinessDays(now, 5, tz).toISOString();
      c.history.push({ at: c.closedAt, by, text: (c.type === 'Formal'
        ? 'Decision recorded; employee, Team Lead and People Ops informed. Appeal window open for 5 business days'
        : 'Informal discussion arranged; request closed') + (note ? ` — ${note}` : '') });
      break;
    case 'note':
      if (!note) return json({ error: 'Write a note first.' }, 400);
      c.history.push({ at: now.toISOString(), by, text: note });
      break;
    default:
      return json({ error: 'Unknown action.' }, 400);
  }
  await env.GRIEVANCE_KV.put(`case:${c.id}`, JSON.stringify(c));
  return json(c);
}

/* ================= notifications ================= */

export function buildEmail(c, origin) {
  const link = `${origin}/hr#${c.id}`;
  if (c.type === 'Formal') {
    return {
      subject: `Confidential: formal grievance ${c.id} submitted${c.urgent ? ' [URGENT]' : ''}`,
      text: `Dear HR Team,

A formal grievance has been submitted through the Grievance Agent.

Reference: ${c.id}${c.urgent ? '\nPriority: URGENT - the employee reported an immediate safety or wellbeing concern.' : ''}
First reviewer under the Grievance Policy: ${LADDER[c.startLevel].name}

Please access the complete submission through the secure case link:
${link}

The employee has been informed that HR will acknowledge the submission within two business hours and provide information about the next steps.

This is an automatically generated confidential notification. Please do not forward it to anyone who is not authorised to manage the case.

Regards,
Grievance Agent`,
    };
  }
  return {
    subject: `Confidential: informal discussion request ${c.id}`,
    text: `Dear HR Team,

An employee has requested a confidential informal discussion through the Grievance Agent.

Reference: ${c.id}
Requested contact: ${c.contactName}
Preferred time: ${c.when}

No details of the concern were collected. Please acknowledge within two business hours and arrange a suitable time.
Case link: ${link}

This is an automatically generated confidential notification. Please do not forward it to anyone who is not authorised to handle the request.

Regards,
Grievance Agent`,
  };
}

async function notifyHR(env, c, origin) {
  if (!env.RESEND_API_KEY || !env.HR_NOTIFY_EMAIL || !env.MAIL_FROM) return;
  const mail = buildEmail(c, origin);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify({ from: env.MAIL_FROM, to: env.HR_NOTIFY_EMAIL.split(',').map(s => s.trim()), subject: mail.subject, text: mail.text }),
    });
    if (!res.ok) console.error('Email failed', res.status, await res.text());
  } catch (err) {
    console.error('Email error', String(err));
  }
}

/* ================= config ================= */

async function getConfig(env) {
  const stored = (await env.GRIEVANCE_KV.get('config', 'json')) || {};
  return { ...DEFAULT_CONFIG, ...stored };
}

async function saveConfig(request, env) {
  const b = await readJson(request);
  if (!b) return json({ error: 'The settings could not be read.' }, 400);
  const systemPrompt = String(b.systemPrompt || '').trim();
  if (systemPrompt.length < 50) return json({ error: 'The system prompt looks too short. Use Reset to default if you want to start again.' }, 400);
  if (systemPrompt.length > 20000) return json({ error: 'The system prompt must be 20,000 characters or fewer.' }, 400);
  const cfg = {
    systemPrompt,
    emergencyContact: clean(b.emergencyContact, 300) || DEFAULT_CONFIG.emergencyContact,
    policyUrl: /^https?:\/\//.test(b.policyUrl || '') ? clean(b.policyUrl, 500) : '',
    updatedAt: new Date().toISOString(),
  };
  await env.GRIEVANCE_KV.put('config', JSON.stringify(cfg));
  return json(cfg);
}

/* ================= helpers ================= */

function checkAuth(request, secret, name) {
  if (!secret) return json({ error: `${name} is not set on the Worker. Add it under Settings > Variables and Secrets.` }, 503);
  const h = request.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  return safeEqual(token, secret) ? null : json({ error: 'Wrong password.' }, 401);
}

function safeEqual(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > 30000) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function clean(v, max) {
  return String(v ?? '').trim().slice(0, max);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}
