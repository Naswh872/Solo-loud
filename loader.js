(() => {
  'use strict';
  if (window.top !== window) return;
  const base = chrome.runtime.getURL('');
  const add = (name, onload) => {
    const s = document.createElement('script');
    s.src = base + name;
    s.onload = () => { s.remove(); if (onload) onload(); };
    (document.head || document.documentElement).appendChild(s);
  };
  add('injector.js', () => add('solo-warrior-stereo-pan.js'));
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = base + 'solo-warrior-stereo-pan.css';
  (document.head || document.documentElement).appendChild(css);
})();
