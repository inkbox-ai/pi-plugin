import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startGateway } from '../gateway/index.js';

const identity = {
  id: 'agent', agent_handle: 'fixture', organization_id: 'organization',
  phone_number: {id: 'phone', number: '+12025550101'}
};

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function modelResponse(res, text) {
  res.writeHead(200, {'Content-Type': 'text/event-stream'});
  for (const [delta, finish_reason] of [[{role:'assistant', content:text}, null], [{}, 'stop']]) {
    res.write('data: ' + JSON.stringify({id:'fixture', object:'chat.completion.chunk', model:'fixture',
      created:1, choices:[{index:0, delta, finish_reason}]}) + '\n\n');
  }
  res.end('data: [DONE]\n\n');
}

// Exercise raw webhook -> durable inbox -> real Pi -> real Inkbox SDK -> reply.
// Only the network peers are fixtures; no credentials or live delivery are needed.
test('signed SMS resumes Pi across gateway restarts and replies exactly once to its source', {timeout: 45_000}, async t => {
  const home = mkdtempSync(join(tmpdir(), 'pi-conversation-'));
  const workspace = join(home, 'workspace');
  const agentDir = join(home, 'agent');
  mkdirSync(workspace);
  mkdirSync(agentDir);
  const modelRequests = [], replies = [], subscriptions = [];
  let sent = Promise.withResolvers();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw && JSON.parse(raw);
    function json(value, status = 200) {
      res.writeHead(status, {'Content-Type':'application/json'}); res.end(JSON.stringify(value));
    }
    if (url.pathname === '/v1/chat/completions') {
      modelRequests.push(body);
      modelResponse(res, modelRequests.length === 1 ? 'first answer' : 'second answer');
    } else if (req.headers['x-api-key'] !== 'fixture') json({}, 401);
    else if (url.pathname === '/api/whoami') json({auth_type:'api_key', auth_subtype:'api_key.agent_scoped.claimed'});
    else if (url.pathname === '/api/v1/identities/' || url.pathname === '/api/v1/identities') json([identity]);
    else if (url.pathname === '/api/v1/identities/fixture') json(identity);
    else if (url.pathname === '/api/v1/webhooks/subscriptions' && req.method === 'GET') {
      json({subscriptions:subscriptions.filter(row =>
        ['phone_number_id','agent_identity_id','url'].every(key => !url.searchParams.has(key) || row[key] === url.searchParams.get(key)))});
    } else if (url.pathname === '/api/v1/webhooks/subscriptions' && req.method === 'POST') {
      const row = {...body, id:'sub-' + subscriptions.length, status:'active'};
      subscriptions.push(row); json(row, 201);
    } else if (url.pathname === '/api/v1/phone/numbers/phone/texts' && req.method === 'POST') {
      replies.push({...body, key:req.headers['idempotency-key']});
      json({id:'reply-' + replies.length, direction:'outbound', ...body});
      sent.resolve();
    } else json({error:'Unexpected fixture request: ' + req.method + ' ' + url.pathname}, 404);
  });
  const api = 'http://127.0.0.1:' + await listen(server);
  const saved = {...process.env};
  Object.assign(process.env, {HOME:home, PI_CODING_AGENT_DIR:agentDir, PI_OFFLINE:'1'});
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({providers:{fixture:{
    baseUrl:api + '/v1', apiKey:'fixture', api:'openai-completions', models:[{id:'fixture'}]
  }}}));
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({defaultProvider:'fixture', defaultModel:'fixture'}));
  const probe = createServer();
  const port = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  const config = {home, identity:'fixture', apiKey:'fixture', signingKey:'test-signing-key',
    projectDirectory:workspace, piBin:resolve('node_modules/.bin/pi'), baseUrl:api,
    publicUrl:'https://gateway.example.test', port};
  let gateway;
  t.after(async () => {
    await gateway?.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const key of ['HOME','PI_CODING_AGENT_DIR','PI_OFFLINE']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    rmSync(home, {force:true, recursive:true});
  });
  async function deliver(id, text) {
    const body = JSON.stringify({id:'event-' + id, event_type:'text.received', data:{text_message:{
      id, direction:'inbound', sender_access:'direct', conversation_id:'conversation', sender_phone_number:'+12025550102',
      local_phone_number:identity.phone_number.number, text
    }}});
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', config.signingKey).update(id + '.' + timestamp + '.' + body).digest('hex');
    const response = await fetch('http://127.0.0.1:' + port + '/webhook', {method:'POST', body,
      headers:{'x-inkbox-timestamp':timestamp, 'x-inkbox-request-id':id, 'x-inkbox-signature':'sha256=' + signature}});
    assert.equal(response.status, 202);
  }
  gateway = await startGateway(config);
  await deliver('first', 'first question');
  await sent.promise;
  await gateway.close();
  gateway = await startGateway(config);
  sent = Promise.withResolvers();
  await deliver('first', 'first question'); // retry after restart must not wake the model
  await deliver('second', 'follow-up question');
  await sent.promise;
  assert.equal(modelRequests.length, 2);
  assert.match(JSON.stringify(modelRequests[1].messages), /first answer/);
  assert.match(JSON.stringify(modelRequests[1].messages), /follow-up question/);
  assert.deepEqual(modelRequests[1].tools ?? [], []);
  assert.deepEqual(replies.map(r => [r.conversation_id, r.text]), [['conversation','first answer'],['conversation','second answer']]);
  assert.ok(replies[0].key && replies[1].key && replies[0].key !== replies[1].key);
  assert.ok(subscriptions.some(row => row.event_types.includes('text.received')));
});
