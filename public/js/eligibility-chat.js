/* Eligibility chatbot widget — vanilla JS, no framework.
 *
 * Talks to POST /api/eligibility-chat which proxies to the Python RAG service.
 * Keeps the last few turns in memory so the bot has context for follow-ups
 * like "explain that" or "tell me more". History is NOT persisted — refresh
 * clears it.
 */
(function () {
  'use strict';

  var $toggle = document.getElementById('eligibility-chat-toggle');
  var $panel = document.getElementById('eligibility-chat-panel');
  var $close = document.getElementById('eligibility-chat-close');
  var $form = document.getElementById('eligibility-chat-form');
  var $input = document.getElementById('eligibility-chat-input');
  var $messages = document.getElementById('eligibility-chat-messages');

  if (!$toggle || !$panel || !$form) return;

  var history = []; // {role: 'user'|'assistant', content: string}
  var MAX_HISTORY = 12;

  function openPanel() {
    $panel.hidden = false;
    setTimeout(function () { $input.focus(); }, 50);
  }
  function closePanel() { $panel.hidden = true; }

  $toggle.addEventListener('click', function () {
    if ($panel.hidden) openPanel(); else closePanel();
  });
  $close.addEventListener('click', closePanel);

  function appendMessage(role, text) {
    var bubble = document.createElement('div');
    bubble.className = 'ec-msg ' + (role === 'user' ? 'ec-msg-user' : 'ec-msg-bot');
    bubble.textContent = text;
    $messages.appendChild(bubble);
    requestAnimationFrame(function () {
      $messages.scrollTop = $messages.scrollHeight;
    });
    return bubble;
  }

  function setTyping(bubble) {
    bubble.textContent = '';
    var t = document.createElement('span');
    t.className = 'ec-msg-typing';
    t.innerHTML = '<span></span><span></span><span></span>';
    bubble.appendChild(t);
  }

  function appendSources(bubble, data) {
    if (!data.sources || !data.sources.length) return;
    var meta = document.createElement('div');
    meta.className = 'ec-msg-sources';
    meta.textContent = data.grounded
      ? 'Grounded in ' + data.sources.length + ' rule(s) from the knowledge base.'
      : '';
    if (meta.textContent) bubble.appendChild(meta);
  }

  function pushHistory(role, content) {
    history.push({ role: role, content: content });
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
  }

  $form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var question = $input.value.trim();
    if (question.length < 1) return;
    appendMessage('user', question);
    pushHistory('user', question);
    $input.value = '';
    $input.disabled = true;

    var pending = appendMessage('bot', '');
    setTyping(pending);

    try {
      var res = await fetch('/api/eligibility-chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          question: question,
          history: history.slice(0, -1) // exclude the message we just pushed; backend adds it
        })
      });
      var data = await res.json();
      var answer = data.answer || '(no answer)';
      pending.textContent = answer;
      appendSources(pending, data);
      pushHistory('assistant', answer);
    } catch (err) {
      pending.textContent = 'Network error. Please try again in a moment.';
    } finally {
      $input.disabled = false;
      $input.focus();
      requestAnimationFrame(function () {
        $messages.scrollTop = $messages.scrollHeight;
      });
    }
  });
})();
