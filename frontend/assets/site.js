// books.rikka.moe — hand-written page script (no framework, no build step).
//
//  1. scroll-in reveal: toggles .rv-in on [data-rv] elements as they enter the
//     viewport (the pre-hide lives in site.css behind html.reveal);
//  2. scroll progress bar along the top edge;
//  3. premium key verification: POST /api/books/verify, then render one
//     same-origin /api/books/download/<index> link per returned label.
(() => {
  'use strict';

  // Tells the inline bootstrap in <head> that the reveal CSS may stay active.
  window.__booksRevealReady = true;

  const targets = document.querySelectorAll('[data-rv]');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (reduced || !('IntersectionObserver' in window)) {
    targets.forEach((el) => el.classList.add('rv-in'));
  } else {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('rv-in');
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    );
    targets.forEach((el) => observer.observe(el));
  }

  // ---- scroll progress bar ----
  const bar = document.createElement('div');
  bar.className = 'rv-progress rv-progress--idle';
  bar.setAttribute('aria-hidden', 'true');
  bar.appendChild(document.createElement('span'));
  const fill = bar.firstElementChild;
  document.body.appendChild(bar);

  let ticking = false;
  const paint = () => {
    ticking = false;
    const scrollable = document.documentElement.scrollHeight - window.innerHeight;
    const progress = scrollable > 0 ? Math.min(1, Math.max(0, window.scrollY / scrollable)) : 0;
    fill.style.transform = `scaleX(${progress.toFixed(4)})`;
    bar.classList.toggle('rv-progress--idle', progress <= 0.002);
  };
  const requestPaint = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(paint);
  };
  window.addEventListener('scroll', requestPaint, { passive: true });
  window.addEventListener('resize', requestPaint, { passive: true });
  paint();

  // ---- premium key ----
  const form = document.getElementById('premium-form');
  if (!form) return;

  const input = document.getElementById('premium-key');
  const button = document.getElementById('premium-verify');
  const status = document.getElementById('premium-status');
  const results = document.getElementById('premium-results');

  const setStatus = (message, kind) => {
    status.textContent = message;
    status.className = kind ? `dl-status dl-status--${kind}` : 'dl-status';
  };

  const renderLinks = (labels) => {
    results.replaceChildren();
    labels.forEach((label, index) => {
      const link = document.createElement('a');
      link.className = 'dl-item';
      link.href = `/api/books/download/${index}`;
      link.setAttribute('download', '');
      const text = document.createElement('span');
      text.textContent = label;
      link.appendChild(text);
      results.appendChild(link);
    });
    results.classList.remove('dl-hidden');
  };

  const verify = async () => {
    const key = input.value.trim();
    results.replaceChildren();
    results.classList.add('dl-hidden');

    if (!key) {
      setStatus('请填写爱发电密钥', 'error');
      input.focus();
      return;
    }

    button.disabled = true;
    button.textContent = '验证中…';
    setStatus('正在验证…', '');

    try {
      const response = await fetch('/api/books/verify', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.success && Array.isArray(data.labels) && data.labels.length > 0) {
        renderLinks(data.labels);
        setStatus('验证成功，点击下方链接下载：', 'ok');
      } else {
        setStatus(data.message || '密钥无效，请检查后重试', 'error');
      }
    } catch (error) {
      setStatus('验证服务暂时不可用，请稍后重试', 'error');
    } finally {
      button.disabled = false;
      button.textContent = '验证密钥';
    }
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    verify();
  });
})();
