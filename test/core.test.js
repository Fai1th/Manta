import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { actionSchema, settingsSchema, checkHierarchy } from '../src/validation.js';
import { createApp } from '../src/server.js';
import { createBot } from '../src/bot.js';
import { Collection } from 'discord.js';
const uid='123456789012345678', other='223456789012345678';

test('counts humans by day, respects exclusions, scopes personal stats and deduplicates events',()=>{
  const s=openDatabase(':memory:');
  assert.equal(s.once('event1'),true);assert.equal(s.once('event1'),false);
  s.activity(uid,'public',2,60,30);s.activity(other,'public',1);s.activity(uid,'private',100);
  s.saveSettings({...s.settings(),excludedChannels:['private']});
  const stats=s.stats();assert.equal(stats.messages,3);assert.equal(stats.activeMembers,2);assert.equal(stats.voiceSeconds,60);assert.equal(s.stats(7,uid).messages,2);
  assert.equal(s.stats(7,uid).members.length,1);s.db.close();
});
test('retention removes old activity and records without deleting recent cases',()=>{
  const s=openDatabase(':memory:');const old=Date.now()-100*86400000;
  s.activity(uid,'channel',1,0,0,old);const a=s.record('case',uid,other,{reason:'old'});s.db.prepare('UPDATE records SET updated=? WHERE id=?').run(old,a);const b=s.record('case',uid,other,{reason:'new'});
  s.cleanup();assert.equal(s.get(a),null);assert.ok(s.get(b));assert.equal(s.stats(365).messages,0);s.db.close();
});
test('comparison periods do not overlap and active days count once across channels',()=>{
  const s=openDatabase(':memory:');s.activity(uid,'one',2);s.activity(uid,'two',3);s.activity(uid,'one',10,0,0,Date.now()-8*86400000);
  assert.equal(s.stats(7).messages,5);assert.equal(s.stats(7).members[0].activeDays,1);assert.equal(s.stats(7,null,7).messages,10);s.db.close();
});
test('retention preserves pending announcements and unrestored incident snapshots',()=>{
  const s=openDatabase(':memory:');const job=s.record('job','',uid,{},'scheduled'),incident=s.record('incident','',uid,{},'active');s.db.prepare('UPDATE records SET updated=?').run(Date.now()-100*86400000);s.cleanup();assert.ok(s.get(job));assert.ok(s.get(incident));s.db.close();
});
test('validates action boundaries and prevents self, owner and higher-role moderation',()=>{
  assert.equal(actionSchema.safeParse({type:'ban',user:'bad',reason:'why'}).success,false);
  assert.equal(actionSchema.safeParse({type:'timeout',user:uid,reason:'why',minutes:40321}).success,false);
  const s=openDatabase(':memory:');assert.equal(settingsSchema.safeParse({...s.settings(),retentionDays:1}).success,false);s.db.close();
  const actor={id:uid,roles:{highest:{comparePositionTo:()=>-1}}},target={id:other,user:{bot:false},roles:{highest:{}}},guild={ownerId:'owner'};
  assert.throws(()=>checkHierarchy(actor,target,guild),/above/);assert.throws(()=>checkHierarchy(actor,{...target,id:uid},guild),/yourself/);assert.throws(()=>checkHierarchy(actor,{...target,id:'owner'},guild),/owner/);
});

async function fixture(t) {
  const store=openDatabase(':memory:'), secret='test-secret-with-at-least-32-characters', csrf='a'.repeat(64);
  let permitted=true, calls=0;
  const bot={client:{isReady:()=>true},actor:async()=>{if(!permitted)throw new Error('revoked');return {id:uid,permissions:{has:()=>true}};},guild:()=>({ownerId:'owner',members:{fetch:async({user})=>({id:user,permissions:{has:()=>user===uid}})}}),reference:async()=>({id:'guild',channels:[],roles:[]}),report:async(user,data)=>({id:store.record('report',user,user,data)}),moderate:async()=>{calls++;return {ok:true};}};
  const config={production:false,publicUrl:'https://manta.example',sessionSecret:secret,configured:true};
  const app=createApp({store,bot,config});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const url=`http://127.0.0.1:${server.address().port}`;
  function cookie(user=uid) {const sid=randomUUID();store.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(sid,JSON.stringify({cookie:{maxAge:100000,httpOnly:true,sameSite:'lax'},user:{id:user,name:'test'},csrf}),Date.now()+100000);const sig=createHmac('sha256',secret).update(sid).digest('base64').replace(/=+$/,'');return `manta.sid=${encodeURIComponent(`s:${sid}.${sig}`)}`;}
  async function request(path,{body,cookie:ck,origin='https://manta.example',token=csrf,id=randomUUID(),method}={}) {return fetch(url+path,{method:method||(body?'POST':'GET'),headers:{...(ck?{Cookie:ck}:{}),...(body?{'Content-Type':'application/json','Origin':origin,'X-CSRF-Token':token,'X-Request-ID':id}:{})},...(body?{body:JSON.stringify(body)}:{})});}
  t.after(()=>{server.closeAllConnections();server.close();store.db.close();});
  return {store,request,cookie,revoke:()=>{permitted=false;},get calls(){return calls;}};
}
test('API denies anonymous and revoked staff access, including direct record/export paths',async t=>{
  const f=await fixture(t);assert.equal((await f.request('/api/admin/records/case')).status,401);
  const ck=f.cookie();assert.equal((await f.request('/api/admin/records/case',{cookie:ck})).status,200);
  f.revoke();assert.equal((await f.request('/api/admin/records/case',{cookie:ck})).status,403);assert.equal((await f.request('/api/admin/tickets/1/transcript',{cookie:ck})).status,403);
});
test('CSRF, origin, validation, duplicate request and logout checks protect state changes',async t=>{
  const f=await fixture(t),ck=f.cookie(),body={type:'warn',user:other,reason:'Test warning'},id=randomUUID();
  assert.equal((await f.request('/api/admin/moderate',{cookie:ck,body,origin:'https://evil.example'})).status,403);
  assert.equal((await f.request('/api/admin/moderate',{cookie:ck,body,token:''})).status,403);
  assert.equal((await f.request('/api/admin/moderate',{cookie:ck,body:{...body,user:'bad'}})).status,400);
  assert.equal((await f.request('/api/admin/moderate',{cookie:ck,body,id})).status,200);
  assert.equal((await f.request('/api/admin/moderate',{cookie:ck,body,id})).status,409);assert.equal(f.calls,1);
  assert.equal((await f.request('/api/logout',{cookie:ck,body:{}})).status,200);
  assert.equal((await f.request('/api/admin/records/case',{cookie:ck})).status,401);
});
test('members cannot read other members’ cases or staff-only notes, including through appeal IDs',async t=>{
  const f=await fixture(t);f.store.record('case',uid,other,{type:'warn',reason:'own'});f.store.record('case',uid,other,{type:'note',reason:'staff secret'});const foreign=f.store.record('case',other,uid,{type:'warn',reason:'foreign'});
  const ck=f.cookie();const r=await f.request('/api/member/records',{cookie:ck});const rows=await r.json();assert.equal(rows.length,1);assert.equal(rows[0].data.reason,'own');
  assert.equal((await f.request('/api/member/appeal',{cookie:ck,body:{case:foreign,reason:'an appeal'}})).status,404);
});
test('failed Discord moderation leaves a failed case and no successful action',async()=>{
  const store=openDatabase(':memory:');const bot=createBot(store,{guildId:'guild'});bot.client.isReady=()=>true;
  const actor={id:uid,permissions:{has:()=>true},roles:{highest:{comparePositionTo:()=>1}}};
  const target={id:other,user:{bot:false},roles:{highest:{}},bannable:true,ban:async()=>{throw new Error('Discord rejected action');}};
  bot.client.guilds.cache.set('guild',{ownerId:'owner',members:{fetch:async({user})=>user===uid?actor:target}});
  await assert.rejects(bot.moderate(uid,{type:'ban',user:other,reason:'test reason'}),/rejected/);
  assert.equal(store.list('case')[0].status,'failed');bot.close();store.db.close();
});
test('ticket dismissal closes access and reopening restores the member’s ability to reply',async()=>{
  const store=openDatabase(':memory:'),bot=createBot(store,{guildId:'guild'});bot.client.isReady=()=>true;
  const writes=[];const c={isTextBased:()=>true,send:async()=>{},permissionOverwrites:{edit:async(id,value)=>writes.push(value.SendMessages)}};
  bot.client.guilds.cache.set('guild',{ownerId:uid,members:{fetch:async()=>({id:uid,permissions:{has:()=>true}})},channels:{fetch:async()=>c}});
  const id=store.record('ticket',other,other,{channel:'channel'});
  await bot.manageRecord(uid,id,'dismissed','closing ticket');assert.equal(store.get(id).status,'dismissed');
  await bot.manageRecord(uid,id,'open','reopening ticket');assert.deepEqual(writes,[false,true]);assert.equal(store.get(id).data.history.length,2);
  bot.close();store.db.close();
});
test('self-service refuses a zero-permission role that grants access through a channel override',async()=>{
  const store=openDatabase(':memory:'),bot=createBot(store,{guildId:'guild'});bot.client.isReady=()=>true;
  const role={id:other,managed:false,permissions:{bitfield:0n},comparePositionTo:()=>-1};
  store.saveSettings({...store.settings(),selfRoles:[other]});
  bot.client.guilds.cache.set('guild',{id:'guild',roles:{fetch:async()=>role},members:{fetchMe:async()=>({roles:{highest:{}}})},channels:{fetch:async()=>{},cache:new Collection([['channel',{permissionOverwrites:{cache:new Collection([[other,{allow:{bitfield:1024n}}]])}}]])}});
  await assert.rejects(bot.role(uid,other),/no server or channel permission grants/);bot.close();store.db.close();
});
test('incident restoration uses the recorded pre-incident slowmode, and persists completion',async()=>{
  const store=openDatabase(':memory:'),bot=createBot(store,{guildId:'guild'});bot.client.isReady=()=>true;
  const writes=[];const c={id:'channel',type:0,rateLimitPerUser:10,isTextBased:()=>true,send:async()=>{},permissionOverwrites:{cache:new Collection()},setRateLimitPerUser:async n=>writes.push(n)};
  bot.client.guilds.cache.set('guild',{id:'guild',ownerId:uid,members:{fetch:async()=>({id:uid,permissions:{has:()=>true}})},channels:{fetch:async()=>c}});
  const r=await bot.incident(uid,'slowmode',['channel'],60,'test incident');assert.equal(r.data.channels[0].slowmode,10);await bot.restore(uid,r.id);assert.deepEqual(writes,[60,10]);assert.equal(store.get(r.id).status,'restored');bot.close();store.db.close();
});
