/**
 * Test script to simulate Codex CLI tool call handling
 * Makes a request to vv-switch and logs all SSE events
 */

const url = 'http://localhost:8899/v1/responses';

async function test() {
  console.log('=== Starting Codex tool call test ===\n');

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen3.7-plus',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'What time is it? Use Bash tool.' }] }],
      tools: [{
        type: 'function',
        name: 'Bash',
        description: 'Execute a shell command',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command']
        }
      }],
      stream: true
    })
  });

  console.log(`Response status: ${response.status}\n`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventCount = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      eventCount++;

      // Parse event type and data
      const eventMatch = line.match(/event:\s*(.+)/);
      const dataMatch = line.match(/data:\s*(.+)/);

      if (dataMatch) {
        const dataStr = dataMatch[1].trim();
        if (dataStr === '[DONE]') {
          console.log(`\n[${eventCount}] [DONE]\n`);
          continue;
        }

        try {
          const data = JSON.parse(dataStr);

          // Filter to show only tool-related events
          if (data.type?.includes('function_call') ||
              data.type?.includes('output_item') ||
              data.type === 'response.completed') {
            console.log(`\n[${eventCount}] ${data.type}`);
            console.log(JSON.stringify(data, null, 2).slice(0, 800));
          }
        } catch (e) {
          // skip parse errors
        }
      }
    }
  }

  console.log(`\n=== Total events: ${eventCount} ===`);
}

test().catch(console.error);
