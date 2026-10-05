// books.rikka.moe — 极简页面脚本（无框架、无构建）。
// 唯一的交互：爱发电密钥验证。
//   POST /api/books/verify {"key": ...} -> {"success": true, "labels": [...]}
//   验证成功后为每个 label 渲染一个同源下载按钮
//   /api/books/download/<index>（HMAC cookie 由 API 签发）。
(() => {
  'use strict';

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
      const arrow = document.createElement('span');
      arrow.className = 'dl-arrow';
      arrow.textContent = '↓';
      const text = document.createElement('span');
      text.textContent = label;
      link.appendChild(arrow);
      link.appendChild(text);
      results.appendChild(link);
    });
    results.classList.remove('dl-hidden');
  };

  // 密钥常见的手输错误：把大写 I 看成小写 l、数字 0 看成字母 O、复制时带入
  // 零宽字符或空格。这里只做「去掉不可见字符 + 去首尾空白」，不改变大小写
  // 语义（密钥仍然区分大小写），但失败时给出明确提示。
  const normalizeKey = (raw) => raw.replace(/[\u200b-\u200d\ufeff]/g, '').trim();
  const HINT = '请回爱发电的消息里复制粘贴密钥——手输时容易把大写 I 看成小写 l、数字 0 看成字母 O。';

  const verify = async () => {
    const key = normalizeKey(input.value);
    results.replaceChildren();
    results.classList.add('dl-hidden');

    if (!key) {
      setStatus('请先把爱发电密钥粘贴到输入框里', 'error');
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
        setStatus('✓ 验证成功！点下面的按钮下载无水印版：', 'ok');
      } else {
        setStatus(`${data.message || '密钥无效，请检查后重试'} ${HINT}`, 'error');
      }
    } catch (error) {
      setStatus('验证服务暂时连不上，请稍后再试', 'error');
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
