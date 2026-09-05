// Extension: issue-triage-board
// A Kanban board for prioritizing repository issues and adding them to the current session context.

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { joinSession, createCanvas } from '@github/copilot-sdk/extension';

const execFileAsync = promisify(execFile);
const servers = new Map();

async function loadIssues() {
    const { stdout } = await execFileAsync('gh', [
        'issue',
        'list',
        '--state',
        'open',
        '--limit',
        '100',
        '--json',
        'number,title,body,labels,createdAt',
    ]);
    return JSON.parse(stdout);
}

function prioritize(issues) {
    const scored = issues.map((issue) => {
        const text = `${issue.title} ${issue.body}`.toLowerCase();
        let score = 0;
        if (text.includes('bug') || text.includes('fix')) score += 4;
        if (text.includes('security') || text.includes('urgent')) score += 3;
        if (text.includes('feature')) score += 1;
        if (issue.labels.some((label) => ['bug', 'high priority', 'security'].includes(label.name.toLowerCase()))) score += 3;
        return { ...issue, score };
    });
    return scored.sort((a, b) => b.score - a.score || a.number - b.number);
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[character]));
}

function renderCard(issue, featured) {
    const justification = featured
        ? issue.score >= 4
            ? 'This issue is prioritized because its content suggests an immediate fix or operational risk.'
            : 'This issue is prioritized because it is the strongest remaining candidate for near-term product work.'
        : '';
    return `<article class="card ${featured ? 'featured' : ''}">
      <div class="eyebrow">Issue #${issue.number}</div>
      <h3>${escapeHtml(issue.title)}</h3>
      <p>${escapeHtml(issue.body || 'No description provided.')}</p>
      ${featured ? `<p class="why"><strong>Why now:</strong> ${justification}</p>` : ''}
      <button data-issue="${issue.number}">Add to current context</button>
    </article>`;
}

function renderHtml(issues) {
    const ranked = prioritize(issues);
    const top = ranked.slice(0, 3);
    const remainder = ranked.slice(3);
    return `<!doctype html>
<html>
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width" />
    <title>Issue triage board</title>
    <style>
      :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; padding: 24px; background: var(--background-color-default, #1f2328); color: var(--text-color-default, #f0f6fc); }
      h1 { margin-top: 0; } .board { display: grid; gap: 24px; }
      .column { display: grid; gap: 12px; } .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
      .card { padding: 16px; border: 1px solid var(--border-color-default, #444c56); border-radius: 10px; background: var(--background-color-muted, #2d333b); }
      .featured { border-color: var(--true-color-blue, #539bf5); } h2, h3 { margin: 0 0 8px; }
      p { color: var(--text-color-muted, #8b949e); white-space: pre-wrap; } .eyebrow { font-size: 12px; color: var(--text-color-muted, #8b949e); }
      .why { color: var(--text-color-default, #f0f6fc); } button { border: 0; border-radius: 6px; padding: 8px 12px; cursor: pointer; background: var(--true-color-blue, #539bf5); color: #fff; }
      button:disabled { opacity: .6; cursor: default; }
    </style>
  </head>
  <body><main class="board">
    <header><h1>Issue triage board</h1><p>Top three issues are ranked by likely urgency and impact. Add any issue to this session's context to start work.</p></header>
    <section class="column"><h2>Needs attention now</h2><div class="cards">${top.map((issue) => renderCard(issue, true)).join('') || '<p>No open issues.</p>'}</div></section>
    <section class="column"><h2>Remaining issues</h2><div class="cards">${remainder.map((issue) => renderCard(issue, false)).join('') || '<p>No additional open issues.</p>'}</div></section>
  </main>
  <script>
    document.querySelectorAll('button[data-issue]').forEach((button) => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        button.textContent = 'Added';
        await fetch('/add', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ number: button.dataset.issue }) });
      });
    });
  </script></body>
</html>`;
}

async function startServer(session, instanceId) {
    const issues = await loadIssues();
    const server = createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/add') {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', async () => {
                const { number } = JSON.parse(body);
                await session.send({ prompt: `Start work on GitHub issue #${number}. Review its details and propose the next implementation steps.` });
                res.writeHead(204);
                res.end();
            });
            return;
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(renderHtml(issues));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/` };
}

const session = await joinSession({
    canvases: [
        createCanvas({
            id: 'issue-triage-board',
            displayName: 'issue-triage-board',
            description: 'Kanban board for prioritizing open repository issues and adding them to the current session context.',
            actions: [
                {
                    name: 'refresh_issues',
                    description: 'Reload open issues and return the ranked top three.',
                    handler: async () => {
                        const issues = prioritize(await loadIssues());
                        return issues.slice(0, 3).map(({ number, title, score }) => ({ number, title, score }));
                    },
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(session, ctx.instanceId);
                    servers.set(ctx.instanceId, entry);
                }
                return {
                    title: 'issue-triage-board',
                    url: entry.url,
                };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
            },
        }),
    ],
});
