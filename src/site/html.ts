/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FF_TOKEN_REPORTING_ENABLED } from '../core/constants';

function localApiBootstrap(): string {
  return `
(function () {
  var storageKey = 'aiEngineerCoach.webviewState';
  var state = {};
  var messageListenerReady = false;
  var queuedEvents = [];
  var originalAddEventListener = window.addEventListener.bind(window);

  window.addEventListener = function (type, listener, options) {
    var result = originalAddEventListener(type, listener, options);
    if (type === 'message') {
      messageListenerReady = true;
      setTimeout(function () {
        var pending = queuedEvents;
        queuedEvents = [];
        pending.forEach(function (data) {
          window.dispatchEvent(new MessageEvent('message', { data: data }));
        });
      }, 0);
    }
    return result;
  };

  try {
    state = JSON.parse(window.localStorage.getItem(storageKey) || '{}') || {};
  } catch (_) {
    state = {};
  }

  function emit(data) {
    if (!messageListenerReady && data && data.type !== 'response') {
      queuedEvents.push(data);
      return;
    }
    window.dispatchEvent(new MessageEvent('message', { data: data }));
  }

  function emitResponse(id, data) {
    emit({ type: 'response', id: id, data: data });
  }

  function isSafeHttpsUrl(value) {
    if (typeof value !== 'string' || !value.toLowerCase().startsWith('https://')) return false;
    try {
      var url = new URL(value);
      return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
    } catch (_) {
      return false;
    }
  }

  function connectEvents() {
    if (!('EventSource' in window)) return;
    var source = new EventSource('/api/events');
    source.onmessage = function (event) {
      try {
        emit(JSON.parse(event.data));
      } catch (_) {
        // Ignore malformed server-sent events.
      }
    };
  }

  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (message) {
        if (!message || typeof message !== 'object') return;

        if (message.type === 'request' && message.method === 'openExternal') {
          var url = message.params && message.params.url;
          if (isSafeHttpsUrl(url)) {
            window.open(url, '_blank', 'noopener,noreferrer');
            emitResponse(message.id, { ok: true });
          } else {
            emitResponse(message.id, { error: 'Invalid external URL' });
          }
          return;
        }

        fetch('/api/rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(message),
        }).then(function (response) {
          return response.json();
        }).then(function (payload) {
          emit(payload);
        }).catch(function (error) {
          if (message.type === 'request' && message.id) {
            emitResponse(message.id, { error: error && error.message ? error.message : 'Request failed' });
          }
        });
      },
      getState: function () {
        return state;
      },
      setState: function (nextState) {
        state = nextState || {};
        try {
          window.localStorage.setItem(storageKey, JSON.stringify(state));
        } catch (_) {
          // Best effort persistence.
        }
      },
    };
  };

  setTimeout(connectEvents, 0);
})();
`;
}

export function getLocalDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="/assets/styles.css" rel="stylesheet">
<title>AI Engineer Coach</title>
</head>
<body>
<div id="app">
  <nav id="sidebar">
    <ul class="nav-links">
      <li class="nav-group-header">Observe</li>
      <li><a href="#" data-page="dashboard" class="active"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="8" width="3" height="6" rx="0.5" fill="currentColor"/><rect x="5.5" y="5" width="3" height="9" rx="0.5" fill="currentColor"/><rect x="10" y="2" width="3" height="12" rx="0.5" fill="currentColor"/></svg></span> Dashboard</a></li>
      <li><a href="#" data-page="coach-chat"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2.5 3.5h11v6.5h-6l-3.5 3v-3H2.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M5 6h6M5 8h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg></span> Coach</a></li>
      <li><a href="#" data-page="timeline"><span class="nav-icon">&#9472;</span> Timeline<span class="nav-badge" id="badge-sessions"></span></a></li>
      <li><a href="#" data-page="image-gallery"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/><circle cx="5.5" cy="6.5" r="1.2" stroke="currentColor" stroke-width="1"/><path d="M2 11l3-3 2 2 4-4 3 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span> Coding Moments</a></li>
      <li class="nav-group-header">Measure</li>
      <li><a href="#" data-page="output"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 12L6 7L9 9.5L14 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.5 3H14V6.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span> Output<span class="nav-badge" id="badge-output"></span></a></li>
      ${FF_TOKEN_REPORTING_ENABLED ? '<li><a href="#" data-page="burndown"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 3L8 8L14 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.4" stroke-dasharray="2 2"/><path d="M2 3L6 9L10 7L14 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><line x1="2" y1="13" x2="14" y2="13" stroke="currentColor" stroke-width="1" opacity="0.3"/></svg></span> Burndown<span class="nav-badge" id="badge-burndown"></span></a></li>' : ''}
      <li><a href="#" data-page="patterns"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="1" width="6" height="6" rx="1" fill="currentColor" opacity="0.9"/><rect x="9" y="1" width="6" height="6" rx="1" fill="currentColor" opacity="0.5"/><rect x="1" y="9" width="6" height="6" rx="1" fill="currentColor" opacity="0.5"/><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" opacity="0.9"/></svg></span> Patterns</a></li>
      <li class="nav-group-header">Improve</li>
      <li><a href="#" data-page="anti-patterns"><span class="nav-icon">&#9888;</span> Anti-Patterns<span class="nav-badge" id="badge-antipatterns"></span></a></li>
      <li><a href="#" data-page="skills"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="4" cy="4" r="2.5" stroke="currentColor" stroke-width="1.3" fill="none"/><circle cx="12" cy="4" r="2.5" stroke="currentColor" stroke-width="1.3" fill="none"/><circle cx="8" cy="13" r="2.5" stroke="currentColor" stroke-width="1.3" fill="none"/><line x1="4" y1="6.5" x2="8" y2="10.5" stroke="currentColor" stroke-width="1.2"/><line x1="12" y1="6.5" x2="8" y2="10.5" stroke="currentColor" stroke-width="1.2"/></svg></span> Skill Finder<span class="nav-badge" id="badge-skills"></span></a></li>
      <li><a href="#" data-page="config-health"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1L1.5 4.5V11.5L8 15L14.5 11.5V4.5Z" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M8 5.5V10.5M5.5 8H10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span> Context Health</a></li>
      <li><a href="#" data-page="level-up"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1l2 5h5l-4 3.5 1.5 5L8 11.5 3.5 14.5 5 9.5 1 6h5z" stroke="currentColor" stroke-width="1.2" fill="none"/></svg></span> Level Up</a></li>
    </ul>
    <div class="sidebar-filters">
      <div class="sidebar-filter">
        <label for="ws-filter-input">Workspace</label>
        <div class="ws-toggle" id="ws-toggle">
          <button class="ws-toggle-btn active" data-ws="current">Current</button>
          <button class="ws-toggle-btn" data-ws="all">All</button>
        </div>
        <div class="combobox" id="ws-combobox">
          <input type="text" id="ws-filter-input" aria-label="Search workspaces" placeholder="Search workspaces..." autocomplete="off" />
          <div class="combobox-list" id="ws-filter-list"></div>
          <input type="hidden" id="ws-filter" aria-label="Selected workspace" />
        </div>
      </div>
      <div class="sidebar-filter">
        <label for="harness-filter">Harness</label>
        <select id="harness-filter"><option value="">All Harnesses</option></select>
      </div>
    </div>
  </nav>
  <main id="content"></main>
</div>
<script>${localApiBootstrap()}</script>
<script src="/assets/app.js"></script>
</body>
</html>`;
}
