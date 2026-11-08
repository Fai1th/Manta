import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/db.js';
import {publicAddress,publicText,sourceUrl,parseItems,createIntegrations} from '../src/integrations.js';
const channel='123456789012345678';
const xml=ids=>`<rss><channel>${ids.map(id=>`<item><guid>${id}</guid><title>Update &amp; news ${id}</title><link>https://example.org/${id}</link></item>`).join('')}</channel></rss>`;
function fixture(options={}) {
  const store=openDatabase(':memory:'),sent=[];let time=Date.now(),raw=xml(['old']),permitted=true;
  const bot={actor:async()=>({permissions:{has:()=>permitted}}),channel:async()=>({permissionsFor:()=>({has:()=>true}),send:async data=>sent.push(data)})};
  const service=createIntegrations(store,bot,{now:()=>time,read:async()=>raw,secret:'test-only-session-secret',...options});
  return {store,service,sent,now:()=>time,advance:()=>{time+=3600001;},raw:value=>{raw=value;},revoke:()=>{permitted=false;}};
}
test('remote destinations reject credentials, non-HTTPS, reserved and mapped private addresses',async()=>{
  for(const ip of ['127.0.0.1','10.0.0.2','169.254.169.254','192.168.1.1','100.64.1.2','0.0.0.0','::1','::ffff:127.0.0.1','fd00::1','fe80::1','2001:db8::1'])assert.equal(publicAddress(ip),false,ip);
  assert.equal(publicAddress('8.8.8.8'),true);assert.equal(publicAddress('2606:4700:4700::1111'),true);
  await assert.rejects(publicText('http://example.org'),/HTTPS/);
  await assert.rejects(publicText('https://127.0.0.1/feed'),/blocked/);
  assert.throws(()=>sourceUrl('rss','https://user:secret@example.org/feed'));
  assert.throws(()=>sourceUrl('github','../private'));
  assert.throws(()=>sourceUrl('twitch','a/b'));
  assert.match(sourceUrl('youtube','UC'+'a'.repeat(22)),/channel_id=UC/);
});
test('feed parser accepts RSS, Atom and releases, deduplicates and rejects active URLs and declarations',()=>{
  assert.equal(parseItems('rss',xml(['one','one'])).length,1);
  assert.equal(parseItems('rss',xml(['one']))[0].title,'Update & news one');
  assert.equal(parseItems('rss','<feed><entry><id>abc</id><title>Upload</title><link rel="alternate" href="https://example.org/video"/></entry></feed>')[0].link,'https://example.org/video');
  assert.deepEqual(parseItems('rss','<rss><channel><item><link>javascript:alert(1)</link></item></channel></rss>'),[]);
  assert.throws(()=>parseItems('rss','<!DOCTYPE x [<!ENTITY y "x">]><rss/>'),/declarations/);
  assert.throws(()=>parseItems('rss','<html>error</html>'),/not an RSS/);
  assert.equal(parseItems('github',JSON.stringify([{id:1,draft:true},{id:2,prerelease:true},{id:3,name:'Release',html_url:'https://github.com/a/b/releases/3'}])).length,1);
});
test('connections baseline without backfill, persist deduplication, pause, resume and recheck permissions',async t=>{
  const f=fixture();t.after(()=>f.store.db.close());
  const saved=await f.service.save('staff',{provider:'rss',source:'https://example.org/feed',channel,name:'News'});
  await f.service.tick();assert.equal(f.sent.length,0);assert.equal(f.service.list()[0].seeded,true);
  f.advance();f.raw(xml(['new','old']));await f.service.tick();assert.equal(f.sent.length,1);assert.deepEqual(f.sent[0].allowedMentions,{parse:[]});
  f.advance();await f.service.tick();assert.equal(f.sent.length,1);
  f.service.change(saved.id,false);f.raw(xml(['newer','new']));f.advance();await f.service.tick();assert.equal(f.sent.length,1);
  f.service.change(saved.id,true);await f.service.tick();assert.equal(f.sent.length,2);
  f.advance();f.revoke();f.raw(xml(['revoked']));await f.service.tick();assert.equal(f.sent.length,2);assert.ok(f.service.list()[0].error);
  f.service.remove(saved.id);assert.equal(f.service.list().length,0);
});
test('a pause during fetching prevents delivery',async t=>{
  const f=fixture();t.after(()=>f.store.db.close());const c=await f.service.save('staff',{provider:'rss',source:'https://example.org/feed',channel,name:'News'});
  await f.service.tick();f.advance();
  const paused=createIntegrations(f.store,{actor:async()=>({permissions:{has:()=>true}}),channel:async()=>({permissionsFor:()=>({has:()=>true}),send:async()=>{throw new Error('must not send');}})},{now:f.now,read:async()=>{f.service.change(c.id,false);return xml(['new']);}});
  await paused.tick();assert.equal(f.service.list()[0].error,'');assert.equal(f.service.list()[0].enabled,false);
  f.service.change(c.id,true);f.advance();f.raw(xml(['new']));await f.service.tick();assert.equal(f.sent.length,1);
});
test('failed sends remain unseen and retry on the next check',async t=>{
  const f=fixture();t.after(()=>f.store.db.close());await f.service.save('staff',{provider:'rss',source:'https://example.org/feed',channel,name:'News'});
  await f.service.tick();f.advance();
  let fail=true,sent=0;
  const retry=createIntegrations(f.store,{actor:async()=>({permissions:{has:()=>true}}),channel:async()=>({permissionsFor:()=>({has:()=>true}),send:async()=>{if(fail)throw new Error('Discord unavailable');sent++;}})},{now:f.now,read:async()=>xml(['new'])});
  await retry.tick();assert.ok(f.service.list()[0].error);assert.equal(sent,0);
  fail=false;f.advance();await retry.tick();assert.equal(sent,1);assert.equal(f.service.list()[0].error,'');
});
test('webhook URLs are encrypted and summaries exclude identities, messages and staff records',async t=>{
  const requests=[],f=fixture({read:async(url,options)=>{requests.push({url,...options});return '';}});t.after(()=>f.store.db.close());
  f.store.activity('private-member',channel,4);f.store.record('case','private-member','staff',{reason:'staff secret'});
  const url='https://hooks.example.org/secret-endpoint';
  await f.service.save('staff',{provider:'webhook',source:url,channel,name:'Workflow'});
  const raw=f.store.db.prepare('SELECT config FROM integrations').get().config;
  assert.ok(!raw.includes(url));assert.equal(f.service.list()[0].source,'Saved HTTPS endpoint');
  await f.service.tick();assert.equal(requests[0].url,url);assert.equal(requests[0].method,'POST');
  assert.doesNotMatch(requests[0].body,/private-member|staff secret/);assert.equal(JSON.parse(requests[0].body).data.messages,4);
});
test('Twitch uses host credentials and sends only a newly observed stream once',async t=>{
  let stream='old';const requests=[],f=fixture({twitchId:'client',twitchSecret:'host-secret',read:async(url,options)=>{requests.push({url,...options});return url.includes('/oauth2/')?JSON.stringify({access_token:'app-token',expires_in:3600}):JSON.stringify({data:[{id:stream,title:'Live now',user_login:'streamer'}]});}});t.after(()=>f.store.db.close());
  await f.service.save('staff',{provider:'twitch',source:'streamer',channel,name:'Live'});await f.service.tick();assert.equal(f.sent.length,0);
  stream='new';f.advance();await f.service.tick();assert.equal(f.sent.length,1);assert.match(f.sent[0].content,/twitch.tv\/streamer/);
  assert.match(requests[0].body,/client_secret=host-secret/);assert.equal(requests[1].headers.Authorization,'Bearer app-token');
});
