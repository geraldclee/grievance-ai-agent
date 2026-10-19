// HR console for the Grievance Agent.
(function () {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = d => d ? new Date(d).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—';
  const fmtDay = d => d ? new Date(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : '—';
  const LADDER = [{ name: 'Team Lead', weeks: 1 }, { name: 'Department Lead', weeks: 2 }, { name: 'People Ops', weeks: 3 }];
  const LABELS = { nature: 'Nature of grievance', when: 'When it occurred', where: 'Where it happened', who: 'People involved / witnesses', how: 'What happened', impact: 'Impact on employee / work environment', outcome: 'Resolution sought', docs: 'Supporting documents' };
  const ABOUT = { none: 'Neither Team Lead nor Department Lead', team_lead: 'The Team Lead', department_lead: 'The Department Lead' };

  const S = { token: null, by: '', cases: [], selected: location.hash.slice(1) || null };
  try { S.token = sessionStorage.getItem('hrToken'); S.by = sessionStorage.getItem('hrName') || ''; } catch (_) {}

  async function api(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + S.token } });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { signOut(); throw new Error('Your session has ended. Please sign in again.'); }
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  /* ---------- sign in ---------- */
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    S.token = $('#hrPass').value;
    S.by = $('#hrName').value.trim();
    const err = $('#loginErr');
    err.hidden = true;
    try {
      await api('/api/hr/login', { method: 'POST', body: '{}' });
      try { sessionStorage.setItem('hrToken', S.token); sessionStorage.setItem('hrName', S.by); } catch (_) {}
      showConsole();
    } catch (ex) {
      err.hidden = false;
      err.textContent = ex.message;
    }
  });
  function signOut() {
    S.token = null;
    try { sessionStorage.removeItem('hrToken'); } catch (_) {}
    $('#console').hidden = true;
    $('#logout').hidden = true;
    $('#loginForm').hidden = false;
  }
  $('#logout').addEventListener('click', signOut);

  async function showConsole() {
    $('#loginForm').hidden = true;
    $('#console').hidden = false;
    $('#logout').hidden = false;
    await load();
  }

  /* ---------- list ---------- */
  async function load() {
    try {
      const r = await api('/api/hr/cases');
      S.cases = r.cases;
      renderList();
      renderDetail();
    } catch (e) {
      $('#cases').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }
  function pill(c) {
    const cls = c.status === 'Closed' ? 'p-closed' : c.status === 'New' ? 'p-new' : 'p-ack';
    return `<span class="pill ${cls}">${esc(c.status)}</span>`;
  }
  function owner(c) { return c.type === 'Formal' ? LADDER[c.level].name : c.contactName; }
  function renderList() {
    const st = $('#fStatus').value, ty = $('#fType').value;
    const rows = S.cases.filter(c => (st === 'all' || (st === 'closed' ? c.status === 'Closed' : c.status !== 'Closed')) && (!ty || c.type === ty));
    $('#cases').innerHTML = rows.length ? rows.map(c => `<button type="button" class="case-row" data-id="${esc(c.id)}" aria-current="${c.id === S.selected}">
        <span class="id">${esc(c.id)}</span><span class="sum">${esc(c.summary)}</span>${pill(c)}
        <span class="meta">${c.type} · ${esc(owner(c))} · ${fmt(c.createdAt)}${c.urgent ? ' · <b style="color:var(--crit)">Urgent</b>' : ''}</span></button>`).join('')
      : '<div class="empty">No cases match this filter.</div>';
  }
  $('#cases').addEventListener('click', e => {
    const r = e.target.closest('.case-row');
    if (!r) return;
    S.selected = r.dataset.id;
    history.replaceState(null, '', '#' + S.selected);
    renderList();
    renderDetail();
  });
  $('#fStatus').addEventListener('change', renderList);
  $('#fType').addEventListener('change', renderList);
  $('#refresh').addEventListener('click', load);

  /* ---------- detail ---------- */
  function renderDetail() {
    const d = $('#detail');
    const c = S.cases.find(x => x.id === S.selected);
    if (!c) { d.innerHTML = '<div class="empty">Select a case to see its details.</div>'; return; }
    const now = Date.now();
    const ackLate = !c.ackedAt && new Date(c.ackDue).getTime() < now;
    const ack = c.ackedAt ? `Done ${fmt(c.ackedAt)}` : `<span class="${ackLate ? 'late' : ''}">${ackLate ? 'Overdue · ' : 'Due '}${fmt(c.ackDue)}</span>`;
    let sla, ladder = '', fields = '', triage = '';
    if (c.type === 'Formal') {
      const late = c.status !== 'Closed' && new Date(c.stageDue).getTime() < now;
      sla = `<dl class="sla"><div><dt>Acknowledgement</dt><dd>${ack}</dd></div><div><dt>Current owner</dt><dd>${LADDER[c.level].name}</dd></div>
        <div><dt>${c.status === 'Closed' ? 'Appeal window ends' : 'Stage resolution due'}</dt><dd class="${late ? 'late' : ''}">${c.status === 'Closed' ? fmtDay(c.appealDue) : (late ? 'Overdue · ' : '') + fmtDay(c.stageDue)}</dd></div></dl>`;
      ladder = `<div><p class="sec-title">Escalation path (Grievance Policy)</p><ol class="ladder">${LADDER.map((l, i) =>
        `<li class="${i < c.startLevel ? 'skip' : i < c.level ? 'done' : i === c.level ? 'now' : ''}"><b>${l.name}</b>${l.weeks} week${l.weeks > 1 ? 's' : ''}${i < c.startLevel ? ' · skipped, grievance concerns this role' : ''}</li>`).join('')}</ol></div>`;
      if (c.triage) {
        triage = `<div class="triage"><p class="sec-title">AI triage · advisory only</p><div class="tags"><span class="pill p-plain">${esc(c.triage.category)}</span><span class="pill ${c.triage.risk === 'high' ? 'p-urgent' : c.triage.risk === 'medium' ? 'p-ack' : 'p-closed'}">${esc(c.triage.risk)} risk</span></div><p>${esc(c.triage.summary)}</p></div>`;
      }
      fields = `<div><p class="sec-title">Submission · authorised handlers only</p><dl class="fields">
        <div><dt>Employee</dt><dd>${esc(c.employee.name)} · ${esc(c.employee.email)}</dd></div>
        ${Object.keys(LABELS).map(k => `<div><dt>${LABELS[k]}</dt><dd>${esc(c.fields[k] || '—')}</dd></div>`).join('')}
        <div><dt>Grievance concerns</dt><dd>${ABOUT[c.about]}</dd></div>
        <div><dt>Immediate safety or wellbeing concern</dt><dd>${c.safety === 'yes' ? 'Yes' : 'No'}</dd></div></dl></div>`;
    } else {
      sla = `<dl class="sla"><div><dt>Acknowledgement</dt><dd>${ack}</dd></div><div><dt>Speak with</dt><dd>${esc(c.contactName)}</dd></div><div><dt>Preferred time</dt><dd>${esc(c.when)}</dd></div></dl>`;
      fields = `<div><p class="sec-title">Requester</p><dl class="fields"><div><dt>Employee</dt><dd>${esc(c.employee.name)} · ${esc(c.employee.email)}</dd></div></dl></div>`;
    }
    const closed = c.status === 'Closed';
    const canEsc = c.type === 'Formal' && c.level < 2 && !closed;
    d.innerHTML = `<div class="d-head"><h3>${esc(c.id)}</h3><div class="tags"><span class="pill p-plain">${c.type}</span>${c.urgent ? '<span class="pill p-urgent">Urgent</span>' : ''}${pill(c)}</div></div>
      ${sla}${ladder}${triage}
      <div class="actions">
        <label class="sec-title" for="note">Note or decision ${c.type === 'Formal' ? '(required to close)' : '(optional)'}</label>
        <textarea id="note" maxlength="1000" placeholder="Visible to HR only" ${closed ? 'disabled' : ''}></textarea>
        <div class="form-actions">
          <button class="btn" type="button" data-act="acknowledge" ${c.ackedAt || closed ? 'disabled' : ''}>Acknowledge</button>
          ${c.type === 'Formal' ? `<button class="btn sec" type="button" data-act="escalate" ${canEsc ? '' : 'disabled'}>Escalate to ${c.level < 2 ? LADDER[c.level + 1].name : '—'}</button>` : ''}
          <button class="btn sec" type="button" data-act="note" ${closed ? 'disabled' : ''}>Add note</button>
          <button class="btn sec" type="button" data-act="close" ${closed ? 'disabled' : ''}>${c.type === 'Formal' ? 'Record decision and close' : 'Meeting arranged, close'}</button>
        </div>
        <div class="err" id="actErr" hidden></div>
      </div>
      ${fields}
      <div><p class="sec-title">Notification sent to HR</p><div class="email"><div class="email-h"><span><b>Subject:</b> ${esc(c.notification.subject)}</span><button class="ghost" type="button" data-copy>Copy</button></div><pre id="emailBody">${esc(c.notification.text)}</pre></div></div>
      <div><p class="sec-title">Case log</p><ul class="log-list">${c.history.map(h => `<li>${fmt(h.at)} · <b>${esc(h.by)}</b> · ${esc(h.text)}</li>`).join('')}</ul></div>`;
  }
  $('#detail').addEventListener('click', async e => {
    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) {
      const text = $('#emailBody').textContent;
      try { await navigator.clipboard.writeText(text); toast('Copied'); }
      catch (_) { const r = document.createRange(); r.selectNodeContents($('#emailBody')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Selected. Press Ctrl+C to copy'); }
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const err = $('#actErr');
    err.hidden = true;
    b.disabled = true;
    try {
      const updated = await api(`/api/hr/cases/${encodeURIComponent(S.selected)}/action`, {
        method: 'POST', body: JSON.stringify({ action: b.dataset.act, note: $('#note').value, by: S.by || 'HR' }),
      });
      const i = S.cases.findIndex(x => x.id === updated.id);
      S.cases[i] = { ...updated, notification: S.cases[i].notification };
      renderList();
      renderDetail();
      toast({ acknowledge: 'Case acknowledged', escalate: 'Case escalated', close: 'Case closed', note: 'Note added' }[b.dataset.act]);
    } catch (ex) {
      err.hidden = false;
      err.textContent = ex.message;
      b.disabled = false;
    }
  });

  let tt;
  function toast(m) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => (t.hidden = true), 2400); }

  setInterval(() => { if (S.token && !$('#console').hidden && !document.activeElement?.matches('textarea')) load(); }, 60000);
  if (S.by) $('#hrName').value = S.by;
  if (S.token) showConsole();
})();
