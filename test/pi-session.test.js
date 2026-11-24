import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runPiTurn } from '../gateway/pi.js';

test('real Pi resumes a gateway conversation across process restarts', {timeout: 60_000}, async t => {
  const home = mkdtempSync(join(tmpdir(), 'pi-conversation-'));
  t.after(() => rmSync(home, {force: true, recursive: true}));
  const workspace = join(home, 'workspace');
  mkdirSync(workspace);
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    requests.push(request);
    const content = requests.length === 1 ? 'first answer' : 'second answer';
    res.writeHead(200, {'Content-Type':'text/event-stream'});
    const packet = (delta, finish_reason) => ({
      id: 'pi-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture',
      choices: [{index: 0, delta, finish_reason}]
    });
    for (const chunk of [packet({role: 'assistant', content}, null), packet({}, 'stop')]) {
      res.write('data: ' + JSON.stringify(chunk) + '\n\n');
    }
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const agentDir = join(home, 'agent');
  mkdirSync(agentDir);
  const saved = {...process.env};
  t.after(() => {
    for (const key of ['HOME', 'PI_CODING_AGENT_DIR', 'PI_OFFLINE']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });
  Object.assign(process.env, {HOME:home, PI_CODING_AGENT_DIR:agentDir, PI_OFFLINE:'1'});
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({providers: {fixture: {
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: 'fixture', api: 'openai-completions',
    models: [{id:'fixture'}]
  }}}));
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({defaultProvider:'fixture', defaultModel:'fixture'}));
  const config = {projectDirectory:workspace, piBin:resolve('node_modules/.bin/pi')};
  const session = join(home, 'conversation.jsonl');
  const route = {channel:'sms', sender:'+12025550123'};
  const signal = AbortSignal.timeout(45_000);
  assert.equal(await runPiTurn(config, {...route, text:'first question'}, session, signal), 'first answer');
  assert.equal(await runPiTurn(config, {...route, text:'follow-up question'}, session, signal), 'second answer');
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1].messages), /first answer/);
  assert.match(JSON.stringify(requests[1].messages), /follow-up question/);
  assert.deepEqual(requests[1].tools ?? [], []);
});
