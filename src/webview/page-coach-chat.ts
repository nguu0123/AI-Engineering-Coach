/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DateFilter } from '../core/types';
import { rpc } from './shared';
import { html, render } from './render';

type ChatRole = 'user' | 'assistant';
type CoachCommand = 'summary' | 'improve' | 'compare' | 'flow' | 'general';

interface ChatTurn {
  role: ChatRole;
  content: string;
}

const COMMANDS: Array<{ id: CoachCommand; label: string }> = [
  { id: 'summary', label: 'Summary' },
  { id: 'improve', label: 'Improve' },
  { id: 'compare', label: 'Compare' },
  { id: 'flow', label: 'Flow' },
];

const turns: ChatTurn[] = [];
let selectedCommand: CoachCommand = 'summary';
let busy = false;

function buttonClass(command: CoachCommand): string {
  return `coach-command${selectedCommand === command ? ' active' : ''}`;
}

function renderShell(container: HTMLElement): void {
  render(html`
    <div class="coach-page">
      <div class="coach-header">
        <div>
          <h2>Coach</h2>
        </div>
        <div class="coach-command-row">
          ${COMMANDS.map(command => html`
            <button class=${buttonClass(command.id)} data-command=${command.id} disabled=${busy}>${command.label}</button>
          `)}
        </div>
      </div>

      <div class="coach-transcript" id="coach-transcript">
        ${turns.length === 0 ? html`
          <div class="coach-empty">
            <div class="coach-empty-title">Ask about your AI coding usage.</div>
          </div>
        ` : turns.map(turn => html`
          <div class=${`coach-turn ${turn.role}`}>
            <div class="coach-role">${turn.role === 'user' ? 'You' : 'Coach'}</div>
            <div class="coach-bubble">${turn.content}</div>
          </div>
        `)}
        ${busy ? html`
          <div class="coach-turn assistant">
            <div class="coach-role">Coach</div>
            <div class="coach-bubble coach-loading">Thinking...</div>
          </div>
        ` : null}
      </div>

      <form class="coach-compose" id="coach-compose">
        <textarea id="coach-input" rows="4" aria-label="Coach prompt" placeholder="Ask a focused question..."></textarea>
        <button class="rule-btn rule-btn-primary" type="submit" disabled=${busy}>Send</button>
      </form>
    </div>
  `, container);
}

async function submitPrompt(container: HTMLElement, filter: DateFilter, prompt: string): Promise<void> {
  const text = prompt.trim();
  if (text) turns.push({ role: 'user', content: text });
  busy = true;
  renderCoachChat(container, filter);
  try {
    const result = await rpc<{ ok: true; reply: string }>('coachChat', {
      prompt: text,
      command: selectedCommand,
      filter,
      history: turns.slice(-8),
    });
    turns.push({ role: 'assistant', content: result.reply });
  } catch (error: unknown) {
    turns.push({ role: 'assistant', content: error instanceof Error ? error.message : String(error) });
  } finally {
    busy = false;
    renderCoachChat(container, filter);
  }
}

export function renderCoachChat(container: HTMLElement, filter: DateFilter): void {
  renderShell(container);
  const transcript = container.querySelector<HTMLElement>('#coach-transcript');
  if (transcript) transcript.scrollTop = transcript.scrollHeight;

  for (const button of container.querySelectorAll<HTMLButtonElement>('.coach-command')) {
    button.addEventListener('click', () => {
      const command = button.dataset.command;
      if (command === 'summary' || command === 'improve' || command === 'compare' || command === 'flow') {
        selectedCommand = command;
        renderCoachChat(container, filter);
      }
    });
  }

  const form = container.querySelector<HTMLFormElement>('#coach-compose');
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy) return;
    const input = container.querySelector<HTMLTextAreaElement>('#coach-input');
    const prompt = input?.value ?? '';
    if (input) input.value = '';
    void submitPrompt(container, filter, prompt);
  });
}
