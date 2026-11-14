// Progressive enhancement: navigation and downloads work without JavaScript.
(() => {
  const menu = document.querySelector('.menu-toggle');
  const mobileNav = document.getElementById('mobile-nav');
  const closeMenu = () => {
    menu.setAttribute('aria-expanded', 'false');
    menu.setAttribute('aria-label', 'Open navigation');
    mobileNav.hidden = true;
  };
  menu.addEventListener('click', () => {
    const open = menu.getAttribute('aria-expanded') !== 'true';
    menu.setAttribute('aria-expanded', String(open));
    menu.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    mobileNav.hidden = !open;
  });
  mobileNav.addEventListener('click', event => { if (event.target.closest('a')) closeMenu(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !mobileNav.hidden) { closeMenu(); menu.focus(); }
  });
  matchMedia('(min-width: 981px)').addEventListener('change', event => { if (event.matches) closeMenu(); });

  function tabs(list, select) {
    if (!list) return;
    const buttons = [...list.querySelectorAll('[role="tab"]')];
    function activate(button, focus = false) {
      buttons.forEach(item => {
        item.setAttribute('aria-selected', String(item === button));
        item.tabIndex = item === button ? 0 : -1;
      });
      select(button);
      if (focus) button.focus();
    }
    list.addEventListener('click', event => {
      const button = event.target.closest('[role="tab"]');
      if (button) activate(button);
    });
    list.addEventListener('keydown', event => {
      const current = buttons.indexOf(document.activeElement);
      if (current < 0) return;
      let next;
      if (event.key === 'ArrowRight') next = (current + 1) % buttons.length;
      if (event.key === 'ArrowLeft') next = (current - 1 + buttons.length) % buttons.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = buttons.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      activate(buttons[next], true);
    });
  }

  const branches = {
    main: { name: 'main', frontend: 3000, server: 4000, database: 'acme_main', message: 'Main is ready. Your feature and hotfix keep running.' },
    feature: { name: 'feature/checkout', frontend: 3010, server: 4010, database: 'acme_feature_checkout', message: 'Checkout is ready. Main and your hotfix keep running.' },
    hotfix: { name: 'hotfix/refund', frontend: 3020, server: 4020, database: 'acme_hotfix_refund', message: 'Hotfix is ready. Main and your feature keep running.' },
  };
  tabs(document.querySelector('.branch-selector'), button => {
    const branch = branches[button.dataset.branch];
    document.getElementById('demo-branch-name').textContent = branch.name;
    document.getElementById('demo-frontend').textContent = `localhost:${branch.frontend}`;
    document.getElementById('demo-server').textContent = `localhost:${branch.server}`;
    document.getElementById('demo-database').textContent = branch.database;
    document.getElementById('demo-message').textContent = branch.message;
    document.getElementById('branch-panel').setAttribute('aria-labelledby', button.id);
  });

  tabs(document.querySelector('.platform-tabs'), button => {
    document.querySelectorAll('.platform-panel').forEach(panel => { panel.hidden = panel.id !== button.getAttribute('aria-controls'); });
  });

  document.querySelectorAll('[data-tabset]').forEach(list => {
    tabs(list, button => {
      list.querySelectorAll('[role="tab"]').forEach(tab => {
        document.getElementById(tab.getAttribute('aria-controls')).hidden = tab !== button;
      });
    });
  });

  const copyStatus = document.getElementById('action-status');
  document.querySelectorAll('[data-copy]').forEach(copyButton => copyButton.addEventListener('click', async event => {
    const button = event.currentTarget;
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      copyStatus.textContent = 'Homebrew install command copied.';
      button.setAttribute('aria-label', 'Copied install command');
      button.innerHTML = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
      clearTimeout(button.copyReset);
      button.copyReset = setTimeout(() => {
        button.setAttribute('aria-label', 'Copy Homebrew install command');
        button.innerHTML = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/></svg>';
        copyStatus.textContent = '';
      }, 2500);
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(button.closest('.copy-command').querySelector('code'));
      selection.removeAllRanges();
      selection.addRange(range);
      copyStatus.textContent = 'Command selected. Use your device’s copy shortcut to copy it.';
    }
  }));
})();
