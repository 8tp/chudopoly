const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

const html = readFileSync('public/index.html', 'utf8');
const chat = readFileSync('public/js/chat.js', 'utf8');
const network = readFileSync('public/js/network.js', 'utf8');

test('player journey controls are wired into the page', () => {
  for (const id of ['btn-quick-play', 'btn-share-room', 'waiting-status', 'winner-summary', 'btn-rematch']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /on(?:click|keydown|input|error)=/);
});

test('chat messages use DOM text nodes instead of HTML event-handler interpolation', () => {
  assert.match(chat, /textEl\.textContent/);
  assert.match(chat, /img\.addEventListener\('error'/);
  assert.doesNotMatch(chat, /onerror=.*\+ url/);
  assert.doesNotMatch(chat, /innerHTML = msgs\.map/);
});

test('client stores and returns private resume tokens', () => {
  assert.match(network, /chud_resume/);
  assert.match(network, /type:'reconnect'.*resumeToken/);
});
