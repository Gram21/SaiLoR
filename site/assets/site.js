(function () {
  'use strict';

  document.documentElement.classList.add('js');

  function themeLabel(button) {
    button.textContent = document.documentElement.dataset.theme === 'light' ? '\u263E Dark' : '\u2600 Light';
  }

  document.querySelectorAll('.theme-toggle').forEach(function (button) {
    themeLabel(button);
    button.addEventListener('click', function () {
      var next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('theme', next); } catch (err) { /* private mode */ }
      document.querySelectorAll('.theme-toggle').forEach(themeLabel);
    });
  });

  function copyWithTextarea(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (err) {
      ok = false;
    }
    document.body.removeChild(area);
    return ok;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return copyWithTextarea(text); }
      );
    }
    return Promise.resolve(copyWithTextarea(text));
  }

  function announce(status, message) {
    status.textContent = message;
  }

  document.querySelectorAll('.copy-button').forEach(function (button) {
    var block = button.closest('.code-block');
    var code = block && block.querySelector('pre code');
    var status = block && block.querySelector('.sr-status');
    if (!code) {
      return;
    }
    var label = button.textContent;
    button.addEventListener('click', function () {
      copyText(code.textContent).then(function (ok) {
        button.textContent = ok ? 'Copied' : 'Copy failed';
        if (status) {
          announce(status, ok ? 'Code copied to the clipboard.' : 'Copy failed. Select the code and copy it by hand.');
        }
        window.setTimeout(function () {
          button.textContent = label;
        }, 2000);
      });
    });
  });
})();
