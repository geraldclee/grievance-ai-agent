// Employee chat for the Grievance Agent.
// Free text goes to the AI model on Cloudflare Workers AI (/api/chat). The informal and formal routes run as fixed, consented steps.
(function () {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const log = $('#log');
  const POLICY = '<button type="button" class="link" data-policy>Grievance Policy</button>';
  const CONTACTS = {
    team_lead: 'My Team Lead',
    people_ops: 'People Ops (HR)',
    designated: 'Another designated contact, because my concern involves my Team Lead or HR',
  };
  const S = { state: 'idle', history: [], informal: {}, formN: 0, busy: false, cfg: { emergencyContact: '[emergency or designated workplace contact]', policyUrl: '' } };

  const fmt = d => new Date(d).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const strip = html => { const d = document.createElement('div'); d.innerHTML = html; return d.textContent.replace(/\s+/g, ' ').trim(); };

  /* ---------- chat primitives ---------- */
  function addMsg(cls, html) {
    const el = document.createElement('div');
    el.className = 'msg ' + cls;
    el.innerHTML = html;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }
  function user(text, record = true) {
    addMsg('user', esc(text));
    if (record) S.history.push({ role: 'user', text });
  }
  function bot(html, opts, cls, record = true) {
    const el = addMsg('bot' + (cls ? ' ' + cls : ''), '<span class="who">Grievance Agent</span>' + html);
    if (record) S.history.push({ role: 'assistant', text: strip(html) });
    if (opts && opts.length) {
      const row = document.createElement('div');
      row.className = 'chips';
      opts.forEach(o => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip';
        b.textContent = o.label;
        b.addEventListener('click', () => {
          if (S.busy) return;
          row.querySelectorAll('button').forEach(x => (x.disabled = true));
          b.classList.add('picked');
          user(o.label);
          o.go();
        });
        row.appendChild(b);
      });
      el.appendChild(row);
    }
    log.scrollTop = log.scrollHeight;
    return el;
  }
  function typing() {
    const t = document.createElement('div');
    t.className = 'typing';
    t.textContent = 'Grievance Agent is typing…';
    log.appendChild(t);
    log.scrollTop = log.scrollHeight;
    return () => t.remove();
  }
  function urgentNotice() {
    bot(`<p><b>If you or someone else is at risk right now, please contact ${esc(S.cfg.emergencyContact)} immediately.</b></p>`, null, 'urgent');
  }
  async function api(path, body) {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }

  /* ---------- AI turn ---------- */
  async function askAI(text) {
    S.busy = true;
    $('#sendBtn').disabled = true;
    const done = typing();
    try {
      const r = await api('/api/chat', { messages: S.history });
      done();
      if (r.urgent) urgentNotice();
      bot(`<p>${esc(r.reply).replace(/\n+/g, '</p><p>')}</p>`);
      if (r.intent === 'informal') informal();
      else if (r.intent === 'formal') formal();
      else if (r.intent === 'exit') exitFlow();
      else if (r.intent === 'grievance') routeChoice();
    } catch (e) {
      done();
      bot(`<p>${esc(e.message)}</p>`, [{ label: 'Show me the options', go: routeChoice }], null, false);
    } finally {
      S.busy = false;
      $('#sendBtn').disabled = false;
    }
  }

  /* ---------- conversation steps (from the grievance use case) ---------- */
  function start() {
    S.state = 'idle';
    S.history = [];
    bot('<p>Hi, I\'m the Grievance Agent. I can help you raise a concern about something that happened at work, informally or formally. Everything here is confidential. How can I help?</p>', [
      { label: 'I would like to raise a grievance about something that happened at work', go: () => askAI() },
      { label: 'How does the grievance process work?', go: () => askAI() },
    ]);
  }
  function routeChoice() {
    S.state = 'choose';
    bot(`<p>Would you like to:</p><p>You can review the ${POLICY} here.</p>`, [
      { label: 'Speak with HR informally', go: informal },
      { label: 'Submit a formal grievance', go: formal },
    ], null, false);
  }
  function informal() {
    S.state = 'choose_contact';
    bot('<p>You have selected the informal option. An informal discussion lets you speak confidentially about your concern and explore possible next steps.</p><p>Who would you prefer to speak with?</p>',
      Object.keys(CONTACTS).map(k => ({ label: CONTACTS[k], go: () => pickContact(k) })));
  }
  function slots() {
    const out = [];
    const d = new Date();
    while (out.length < 3) {
      d.setDate(d.getDate() + 1);
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      for (const h of [10, 15]) {
        if (out.length < 3) { const t = new Date(d); t.setHours(h, 0, 0, 0); out.push(t); }
      }
    }
    return out;
  }
  function pickContact(k) {
    S.informal = { contact: k };
    S.state = 'await_time';
    bot('<p>When would suit you? Pick a time below, or type your preferred date and time.</p>',
      slots().map(t => ({ label: fmt(t), go: () => setWhen(fmt(t)) })));
  }
  function setWhen(when) {
    S.informal.when = when;
    S.state = 'informal_confirm';
    const n = ++S.formN, p = 'i' + n + '_';
    const el = addMsg('wide', `<form class="gform" novalidate>
      <div><h3>Confirm your request</h3><p class="lead">Speak with: <b>${esc(CONTACTS[S.informal.contact])}</b> · Preferred time: <b>${esc(when)}</b></p></div>
      <div class="row2">
        <div class="fld"><label for="${p}name">Your name</label><input id="${p}name" type="text" maxlength="100" autocomplete="name"></div>
        <div class="fld"><label for="${p}email">Work email</label><input id="${p}email" type="email" maxlength="200" autocomplete="email"></div>
      </div>
      <label class="check"><input type="checkbox" id="${p}consent"> <span>I agree to share this request with the contact I selected. Only my name, email, chosen contact and preferred time are shared. No details of my concern are sent.</span></label>
      <div class="err" hidden></div>
      <div class="form-actions"><button class="btn" type="submit">Submit request</button><button class="btn sec" type="button" data-back>Return to options</button></div>
    </form>`);
    const form = el.querySelector('form'), err = form.querySelector('.err');
    form.querySelector('[data-back]').addEventListener('click', () => { lock(form); user('Return to options'); returnOpts(); });
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const body = {
        type: 'informal', contact: S.informal.contact, when,
        name: form.querySelector('#' + p + 'name').value, email: form.querySelector('#' + p + 'email').value,
        consent: form.querySelector('#' + p + 'consent').checked,
      };
      await submit(form, err, body, r => {
        bot(`<p>Your request for an informal discussion has been submitted securely to ${esc(r.firstReviewer)}.</p>
          <p>They will acknowledge your request within two business hours (by ${fmt(r.ackDue)}) and arrange a suitable time to speak with you.</p>
          <p>Your reference is <span class="ref">${esc(r.id)}</span>.</p>`, [{ label: 'Done', go: done }]);
      }, 'Submitted my informal request');
    });
  }
  function formal() {
    S.state = 'formal_intro';
    bot(`<p>You have selected the formal grievance option. You will be asked to provide:</p>
      <ul><li>A description of your concern</li><li>When and where it occurred</li><li>The people involved</li><li>What happened and how it affected you</li><li>Your suggested outcome or support required</li><li>Any relevant supporting documents</li><li>Whether there is an immediate safety or wellbeing concern</li></ul>
      <p>The information will be shared only with authorised individuals responsible for reviewing and managing the grievance, in line with the ${POLICY}.</p>
      <p>Would you like to continue to the formal grievance form?</p>`, [
      { label: 'Continue', go: showForm },
      { label: 'Return to options', go: returnOpts },
    ]);
  }
  const FIELDS = [
    { k: 'nature', label: '1. Explain the nature of your grievance', hint: 'A brief title or summary.', area: true, req: true },
    { k: 'when', label: '2. When did the issue occur?', hint: 'Specific date and time if available.', req: true },
    { k: 'where', label: '3. Where did it happen?', hint: 'Location or context, e.g. office, remote work.', req: true },
    { k: 'who', label: '4. People involved or witnesses', hint: 'Names, if any.', req: false },
    { k: 'how', label: '5. What happened?', hint: 'Events leading up to it and how it unfolded.', area: true, req: true },
    { k: 'impact', label: '6. How did it affect you or the work environment?', area: true, req: true },
    { k: 'outcome', label: '7. What action or resolution are you seeking?', hint: 'For example mediation, or a change in policy.', area: true, req: true },
    { k: 'docs', label: 'Supporting documents', hint: 'List any documents you have (e.g. emails, screenshots). HR will ask for copies through a secure channel.', req: false },
  ];
  function showForm() {
    S.state = 'form';
    const n = ++S.formN, p = 'g' + n + '_';
    const fieldsHtml = FIELDS.map(f => {
      const id = p + f.k;
      const ctl = f.area ? `<textarea id="${id}" maxlength="500"></textarea>` : `<input type="text" id="${id}" maxlength="500">`;
      return `<div class="fld"><label for="${id}">${f.label}${f.req ? '' : ' <span class="hint">(optional)</span>'}</label>${f.hint ? `<span class="hint">${f.hint}</span>` : ''}${ctl}<span class="count" data-for="${id}">0/500</span></div>`;
    }).join('');
    const el = addMsg('wide', `<form class="gform" novalidate>
      <div><h3>Grievance Form</h3><p class="lead">Your submission will be received by the People Ops team and directed to the appropriate person for review and follow-up.</p></div>
      <div class="row2">
        <div class="fld"><label for="${p}name">Your name</label><input id="${p}name" type="text" maxlength="100" autocomplete="name"></div>
        <div class="fld"><label for="${p}email">Work email</label><input id="${p}email" type="email" maxlength="200" autocomplete="email"></div>
      </div>
      ${fieldsHtml}
      <div class="fld"><label for="${p}about">Does your grievance concern your Team Lead or Department Lead?</label><span class="hint">This decides who reviews it first, as set out in the Grievance Policy.</span>
        <select id="${p}about"><option value="">Choose one</option><option value="none">Neither</option><option value="team_lead">Yes, my Team Lead</option><option value="department_lead">Yes, my Department Lead</option></select></div>
      <fieldset class="fld"><legend>Is there an immediate safety or wellbeing concern?</legend>
        <div class="radios"><label><input type="radio" name="${p}safety" value="no"> No</label><label><input type="radio" name="${p}safety" value="yes"> Yes</label></div></fieldset>
      <label class="check"><input type="checkbox" id="${p}consent"> <span>I agree that this information can be shared with the authorised people who review and manage my grievance.</span></label>
      <div class="err" hidden></div>
      <div class="form-actions"><button class="btn" type="submit">Submit grievance</button><button class="btn sec" type="button" data-back>Return to options</button></div>
    </form>`);
    const form = el.querySelector('form'), err = form.querySelector('.err');
    form.addEventListener('input', e => {
      const c = form.querySelector(`.count[data-for="${e.target.id}"]`);
      if (c) c.textContent = `${e.target.value.length}/500`;
      e.target.removeAttribute('aria-invalid');
    });
    form.querySelector('[data-back]').addEventListener('click', () => { lock(form); user('Return to options'); returnOpts(); });
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const fields = {}, missing = [];
      FIELDS.forEach(f => {
        const i = form.querySelector('#' + p + f.k);
        fields[f.k] = i.value.trim();
        if (f.req && !fields[f.k]) { i.setAttribute('aria-invalid', 'true'); missing.push(f.label.replace(/^\d+\.\s*/, '')); }
      });
      const about = form.querySelector('#' + p + 'about');
      if (!about.value) { about.setAttribute('aria-invalid', 'true'); missing.push('who the grievance concerns'); }
      const safety = form.querySelector(`input[name="${p}safety"]:checked`);
      if (!safety) missing.push('the safety question');
      if (missing.length) { err.hidden = false; err.textContent = 'Please complete: ' + missing.join(', ') + '.'; return; }
      const body = {
        type: 'formal', fields, about: about.value, safety: safety.value,
        name: form.querySelector('#' + p + 'name').value, email: form.querySelector('#' + p + 'email').value,
        consent: form.querySelector('#' + p + 'consent').checked,
      };
      await submit(form, err, body, r => {
        if (r.urgent) urgentNotice();
        bot(`<p>Your formal grievance has been submitted securely to the authorised HR team. Your reference is <span class="ref">${esc(r.id)}</span>.</p>
          <p>HR will acknowledge your submission within two business hours (by ${fmt(r.ackDue)}) and explain the next steps. Under the policy, it will first be reviewed by the <b>${esc(r.firstReviewer)}</b>.</p>
          <p>This acknowledgement is not a resolution of the grievance, as the time required will depend on the nature and complexity of the matter.</p>
          <p>You can review the ${POLICY} here.</p>`, [{ label: 'Done', go: done }]);
      }, 'Submitted the grievance form');
    });
    log.scrollTop = el.offsetTop - log.offsetTop - 8;
  }
  async function submit(form, err, body, onOk, userLine) {
    err.hidden = true;
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Submitting…';
    try {
      const r = await api('/api/cases', body);
      lock(form);
      user(userLine);
      S.state = 'idle';
      onOk(r);
    } catch (e) {
      err.hidden = false;
      err.textContent = e.message;
      btn.disabled = false;
      btn.textContent = 'Try again';
    }
  }
  function lock(form) {
    form.querySelectorAll('input,textarea,select,button').forEach(x => (x.disabled = true));
    form.style.opacity = '.6';
  }
  function returnOpts() {
    S.state = 'choose';
    bot(`<p>No submission has been made. You may choose how you would like to proceed. Would you like to:</p><p>You can review the ${POLICY} here.</p>`, [
      { label: 'Speak with HR informally', go: informal },
      { label: 'Submit a formal grievance', go: formal },
      { label: 'Exit', go: exitFlow },
    ]);
  }
  function exitFlow() {
    S.state = 'idle';
    bot(`<p>You have exited the grievance process, and no information has been submitted to HR.</p>
      <p>You can return at any time if you would like to speak with someone or submit a formal grievance.</p>
      <p>If there is an immediate risk to your safety or someone else's safety, please contact ${esc(S.cfg.emergencyContact)} immediately.</p>`,
      [{ label: 'Start again', go: start }]);
  }
  function done() {
    S.state = 'idle';
    bot('<p>Thank you for letting us know. Is there anything else I can help with?</p>');
  }

  /* ---------- typed messages ---------- */
  $('#composer').addEventListener('submit', e => {
    e.preventDefault();
    if (S.busy) return;
    const input = $('#chatInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    if (S.state === 'await_time') { user(text); return setWhen(text); }
    if (S.state === 'form' || S.state === 'informal_confirm') {
      user(text, false);
      return bot('<p>Please complete the form above, or choose Return to options.</p>', null, null, false);
    }
    user(text);
    askAI();
  });

  /* ---------- policy modal ---------- */
  document.addEventListener('click', e => { if (e.target.closest('[data-policy]')) $('#policy').hidden = false; });
  $('#closePolicy').addEventListener('click', () => ($('#policy').hidden = true));
  $('#policy').addEventListener('click', e => { if (e.target.id === 'policy') $('#policy').hidden = true; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#policy').hidden = true; });
  $('#restart').addEventListener('click', () => { log.innerHTML = ''; start(); });

  fetch('/api/config').then(r => r.json()).then(c => {
    Object.assign(S.cfg, c);
    if (c.policyUrl) { $('#policyLink').href = c.policyUrl; $('#policyLinkWrap').hidden = false; }
  }).catch(() => {});
  start();
})();
