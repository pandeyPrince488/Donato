/* Eligibility chatbot widget — vanilla JS, no framework.
 *
 * Talks to POST /api/eligibility-chat which proxies to the Python RAG service.
 * Keeps last N turns in memory only (no persistence) so refresh clears it.
 */
(function () {
  'use strict';

  var $toggle = document.getElementById('eligibility-chat-toggle');
  var $panel = document.getElementById('eligibility-chat-panel');
  var $close = document.getElementById('eligibility-chat-close');
  var $form = document.getElementById('eligibility-chat-form');
  var $input = document.getElementById('eligibility-chat-input');
  var $messages = document.getElementById('eligibility-chat-messages');

  if (!$toggle || !$panel || !$form) return; // partial not on this page

  function openPanel() {
    $panel.hidden = false;
    setTimeout(function () { $input.focus(); }, 50);
  }
  function closePanel() { $panel.hidden = true; }

  $toggle.addEventListener('click', function () {
    if ($panel.hidden) openPanel(); else closePanel();
  });
  $close.addEventListener('click', closePanel);

  function appendMessage(role, text, sources) {
    var bubble = document.createElement('div');
    bubble.className = 'ec-msg ' + (role === 'user' ? 'ec-msg-user' : 'ec-msg-bot');
    bubble.textContent = text;
    if (role === 'bot' && sources && sources.length) {
      var meta = document.createElement('div');
      meta.className = 'ec-msg-sources';
      meta.textContent = 'Based on ' + sources.length + ' rule(s) from the eligibility knowledge base.';
      bubble.appendChild(meta);
    }
    $messages.appendChild(bubble);
    $messages.scrollTop = $messages.scrollHeight;
    return bubble;
  }

  function setLoading(bubble) {
    bubble.textContent = '…thinking';
    bubble.classList.add('ec-msg-loading');
  }

  $form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var question = $input.value.trim();
    if (question.length < 2) return;
    appendMessage('user', question);
    $input.value = '';
    $input.disabled = true;

    var pending = appendMessage('bot', '');
    setLoading(pending);

    try {
      var res = await fetch('/api/eligibility-chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: question })
      });
      var data = await res.json();
      pending.classList.remove('ec-msg-loading');
      pending.textContent = data.answer || '(no answer)';
      if (data.sources && data.sources.length) {
        var meta = document.createElement('div');
        meta.className = 'ec-msg-sources';
        meta.textContent = data.grounded
          ? 'Based on ' + data.sources.length + ' rule(s) from the eligibility knowledge base.'
          : 'No closely matching rule found.';
        pending.appendChild(meta);
      }
    } catch (err) {
      pending.classList.remove('ec-msg-loading');
      pending.textContent = 'Network error. Please try again in a moment.';
    } finally {
      $input.disabled = false;
      $input.focus();
    }
  });
})();
