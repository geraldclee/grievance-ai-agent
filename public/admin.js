// Admin page: edit the AI system prompt (guardrails), emergency contact and policy link.
(function () {
  const $ = s => document.querySelector(s);
  let token = null;
  try { token = sessionStorage.getItem('adminToken'); } catch (_) {}

  async function api(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }
  function fill(cfg) {
    $('#systemPrompt').value = cfg.systemPrompt;
    $('#emergencyContact').value = cfg.emergencyContact || '';
    $('#policyUrl').value = cfg.policyUrl || '';
    if (cfg.model) $('#model').textContent = cfg.model;
    count();
  }
  function count() { $('#promptCount').textContent = `${$('#systemPrompt').value.length.toLocaleString()} / 20,000`; }
  function msg(ok, text) {
    $('#cfgOk').hidden = !ok; $('#cfgErr').hidden = ok;
    (ok ? $('#cfgOk') : $('#cfgErr')).textContent = text;
  }

  async function open() {
    const cfg = await api('/api/admin/config');
    $('#loginForm').hidden = true;
    $('#cfgForm').hidden = false;
    fill(cfg);
  }

  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    token = $('#adminPass').value;
    $('#loginErr').hidden = true;
    try {
      await open();
      try { sessionStorage.setItem('adminToken', token); } catch (_) {}
    } catch (ex) {
      $('#loginErr').hidden = false;
      $('#loginErr').textContent = ex.message;
    }
  });

  $('#systemPrompt').addEventListener('input', count);

  $('#cfgForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const cfg = await api('/api/admin/config', { method: 'PUT', body: JSON.stringify({
        systemPrompt: $('#systemPrompt').value, emergencyContact: $('#emergencyContact').value, policyUrl: $('#policyUrl').value,
      }) });
      msg(true, `Saved ${new Date(cfg.updatedAt).toLocaleString()}. New chats use these settings.`);
    } catch (ex) { msg(false, ex.message); }
  });

  let armed = false;
  $('#reset').addEventListener('click', async e => {
    if (!armed) { armed = true; e.target.textContent = 'Click again to confirm reset'; setTimeout(() => { armed = false; e.target.textContent = 'Reset prompt to default'; }, 4000); return; }
    armed = false;
    e.target.textContent = 'Reset prompt to default';
    try { fill(await api('/api/admin/config/reset', { method: 'POST' })); msg(true, 'Prompt and settings reset to default.'); }
    catch (ex) { msg(false, ex.message); }
  });

  if (token) open().catch(() => { token = null; });
})();
