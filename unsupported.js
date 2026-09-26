// Reuse the exact same host list the manifest declares, so this never
// drifts out of sync with what's actually supported. The embed domain is
// an internal iframe host, not a site people actually visit, so it's
// excluded from the user-facing list.
const hosts = chrome.runtime.getManifest().host_permissions
  .filter(p => !p.includes('embed.wcostream.com'))
  .map(p => p.replace(/^https:\/\/\*\./, '').replace(/\/\*$/, ''));

const ul = document.getElementById('site-list');
hosts.forEach(h => {
  const li = document.createElement('li');
  li.textContent = h;
  ul.appendChild(li);
});
