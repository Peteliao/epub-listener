// Dev-only: read a GitHub Actions job log through the system Edge's CDP session.
// GitHub renders step logs only after the step is expanded, so this navigates,
// clicks the requested step summary and dumps the visible log text.
const port = Number(process.argv[2] ?? 9333)
const url = process.argv[3]
const stepName = process.argv[4] ?? 'npm run audit:all'

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((target) => target.type === 'page')
if (!page) throw new Error('no page target')

const ws = new WebSocket(page.webSocketDebuggerUrl)
const pending = new Map()
let nextId = 0
ws.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
  }
}
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})
function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++nextId
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

await send('Page.enable')
await send('Page.navigate', { url })
await new Promise((resolve) => setTimeout(resolve, 12_000))

const opened = await send('Runtime.evaluate', {
  expression: `(() => {
    const details = [...document.querySelectorAll('details')]
      .filter((item) => item.textContent.includes(${JSON.stringify(stepName)}));
    for (const item of details) item.open = true;
    const steps = [...document.querySelectorAll('summary')];
    const step = steps.find((item) => item.textContent.includes(${JSON.stringify(stepName)}));
    if (step) step.click();
    return { details: details.length, steps: steps.length };
  })()`,
  returnByValue: true,
})
console.log('open:', JSON.stringify(opened.result?.result?.value))
await new Promise((resolve) => setTimeout(resolve, 15_000))

const probe = await send('Runtime.evaluate', {
  expression: `(() => {
    const shadow = [...document.querySelectorAll('*')]
      .filter((item) => item.shadowRoot)
      .map((item) => item.tagName + ':' + (item.shadowRoot.textContent || '').length);
    return {
      open: document.querySelectorAll('details[open]').length,
      logNodes: document.querySelectorAll('log-viewer, .js-log-line, [data-log-line], pre').length,
      shadow,
      text: document.body.innerText.slice(-4000),
    };
  })()`,
  returnByValue: true,
})
const value = probe.result?.result?.value ?? {}
console.log('probe:', JSON.stringify({ open: value.open, logNodes: value.logNodes, shadow: value.shadow }))
const body = String(value.text ?? '')
const lines = body.split(/\r?\n/).filter((line) =>
  /通过|失败|未通过|门禁|audit|Error|error|Sign in|sign in/.test(line))
console.log(lines.slice(-100).join('\n'))
ws.close()
