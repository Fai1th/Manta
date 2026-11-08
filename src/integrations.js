import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import ipaddr from 'ipaddr.js';
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import { snowflake } from './validation.js';

export const providers = [
  { id:'github', name:'GitHub', hint:'owner/repository', help:'Public release announcements' },
  { id:'youtube', name:'YouTube', hint:'UC… channel ID', help:'Public video uploads' },
  { id:'twitch', name:'Twitch', hint:'streamer username', help:'Live alerts; host needs TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET' },
  { id:'reddit', name:'Reddit', hint:'subreddit name', help:'New public subreddit posts' },
  { id:'steam', name:'Steam', hint:'Steam app ID', help:'Game news and patch notes' },
  { id:'wordpress', name:'WordPress', hint:'https://your-site.example/feed/', help:'Public blog feed' },
  { id:'medium', name:'Medium', hint:'username without @', help:'Public author stories' },
  { id:'mastodon', name:'Mastodon', hint:'https://instance.example/@username.rss', help:'Public account feed' },
  { id:'rss', name:'RSS / Atom', hint:'https://example.org/feed.xml', help:'Public news, blogs and podcasts' },
  { id:'zapier', name:'Zapier', hint:'https://hooks.zapier.com/…', help:'Hourly aggregate activity summaries to a Catch Hook' },
  { id:'make', name:'Make', hint:'https://hook.eu1.make.com/…', help:'Hourly aggregate activity summaries to a custom webhook' },
  { id:'webhook', name:'Webhooks / n8n', hint:'Public HTTPS webhook URL', help:'Hourly JSON summaries; no member IDs or message text' }
];
const webhookProviders=new Set(['zapier','make','webhook']);
export const integrationSchema = z.object({
  provider:z.enum(providers.map(p=>p.id)), source:z.string().trim().min(1).max(1000),
  channel:snowflake, name:z.string().trim().min(1).max(60), enabled:z.boolean().default(true)
}).strict();
export function sourceUrl(provider, source) {
  const fail=()=>{throw new Error('Use the source format shown for this integration.');};
  if(provider==='github') {
    if(!/^[\w.-]+\/[\w.-]+$/.test(source)||source.split('/').some(s=>s==='.'||s==='..'))fail();
    return `https://api.github.com/repos/${source}/releases?per_page=10`;
  }
  if(provider==='youtube') { if(!/^UC[\w-]{22}$/.test(source))fail(); return `https://www.youtube.com/feeds/videos.xml?channel_id=${source}`; }
  if(provider==='twitch') {if(!/^[a-zA-Z0-9_]{1,25}$/.test(source))fail();return `https://api.twitch.tv/helix/streams?user_login=${source}`;}
  if(provider==='reddit') { if(!/^\w{2,21}$/.test(source))fail(); return `https://www.reddit.com/r/${source}/new.rss`; }
  if(provider==='steam') { if(!/^\d{1,10}$/.test(source))fail(); return `https://store.steampowered.com/feeds/news/app/${source}/`; }
  if(provider==='medium') { if(!/^[\w.-]{1,80}$/.test(source)||['.','..'].includes(source))fail(); return `https://medium.com/feed/@${source}`; }
  if(!['rss','wordpress','mastodon',...webhookProviders].includes(provider))fail();
  const url=new URL(source);
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash)fail();
  return url.href;
}
export function publicAddress(address) {
  try { const ip=ipaddr.process(address); return ip.range()==='unicast'; } catch { return false; }
}
// Pin the validated DNS answers to the connection; redirects repeat the same checks.
export async function publicText(input, options={}, redirects=0) {
  const url=new URL(input);
  if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443'))throw new Error('Use a public HTTPS feed URL.');
  const hostname=url.hostname.replace(/^\[|\]$/g,'');
  const addresses=await lookup(hostname,{all:true});
  if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw new Error('Private and reserved network addresses are blocked.');
  return new Promise((resolve,reject)=>{
    const req=request(url,{agent:false,method:options.method||'GET',headers:{'User-Agent':'Manta/1.0 (public feed reader)','Accept':'application/atom+xml, application/rss+xml, application/json, text/xml',...options.headers},signal:AbortSignal.timeout(12000),lookup:(_host,dnsOptions,cb)=>dnsOptions.all?cb(null,addresses):cb(null,addresses[0].address,addresses[0].family)},res=>{
      if([301,302,303,307,308].includes(res.statusCode)) {
        res.resume();
        if(redirects>=2||!res.headers.location||options.method==='POST'||options.headers?.Authorization)return reject(new Error('This redirect is not allowed.'));
        publicText(new URL(res.headers.location,url),options,redirects+1).then(resolve,reject);return;
      }
      if(res.statusCode<200||res.statusCode>=300) {res.resume();return reject(new Error(`Source returned HTTP ${res.statusCode}.`));}
      let size=0; const chunks=[];
      res.on('data',chunk=>{size+=chunk.length;if(size>512000)res.destroy(new Error('Feed is larger than 500 KB.'));else chunks.push(chunk);});
      res.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')));res.on('error',reject);
    });req.on('error',reject);req.end(options.body);
  });
}
const array=v=>v===undefined?[]:Array.isArray(v)?v:[v];
const text=v=>typeof v==='object'?String(v?.['#text']??''):String(v??'');
export function parseItems(provider, raw) {
  let entries;
  if(provider==='github') {
    const data=JSON.parse(raw);if(!Array.isArray(data))throw new Error('Invalid release response.');
    entries=data.filter(r=>!r.draft&&!r.prerelease).map(r=>({id:String(r.id),title:r.name||r.tag_name,link:r.html_url}));
  } else if(provider==='twitch') {
    const data=JSON.parse(raw);if(!Array.isArray(data.data))throw new Error('Invalid Twitch response.');
    entries=data.data.map(r=>({id:String(r.id),title:r.title,link:`https://www.twitch.tv/${encodeURIComponent(r.user_login)}`}));
  } else {
    if(/<!DOCTYPE|<!ENTITY/i.test(raw))throw new Error('Feed declarations are not allowed.');
    const data=new XMLParser({ignoreAttributes:false,processEntities:true,parseTagValue:false}).parse(raw);
    const items=data.rss?.channel?.item??data.feed?.entry??data['rdf:RDF']?.item;
    if(!data.rss&&!data.feed&&!data['rdf:RDF'])throw new Error('This source is not an RSS or Atom feed.');
    entries=array(items).map(r=>{
      const link=array(r.link).find(l=>l?.['@_href']&&(!l['@_rel']||l['@_rel']==='alternate'));
      return {id:text(r.guid||r.id)||text(r.link),title:text(r.title),link:link?.['@_href']||text(r.link)};
    });
  }
  const unique=new Set();
  return entries.slice(0,20).flatMap(item=>{
    try { const url=new URL(item.link);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.href.length>1500)return [];
      const id=createHash('sha256').update(item.id||url.href).digest('hex');if(unique.has(id))return [];unique.add(id);
      return [{id,title:String(item.title||'New update').replace(/<[^>]*>/g,'').replace(/[\r\n]/g,' ').slice(0,220),link:url.href}];
    } catch {return [];}
  });
}
export function createIntegrations(store,bot,{read=publicText,now=Date.now,secret,twitchId,twitchSecret}={}) {
  const db=store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS integrations (id INTEGER PRIMARY KEY, config TEXT NOT NULL, actor TEXT NOT NULL, seen TEXT NOT NULL DEFAULT '[]', seeded INTEGER NOT NULL DEFAULT 0, checked INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '');`);
  let busy=false;
  let twitchToken,tokenUntil=0;
  function crypt(source,decode=false) {
    if(!secret)throw new Error('Configure a persistent SESSION_SECRET before adding webhooks.');
    const key=createHash('sha256').update(secret).digest();
    if(decode){const [iv,tag,data]=source.split('.').map(v=>Buffer.from(v,'hex'));const cipher=createDecipheriv('aes-256-gcm',key,iv);cipher.setAuthTag(tag);return Buffer.concat([cipher.update(data),cipher.final()]).toString();}
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);const data=Buffer.concat([cipher.update(source,'utf8'),cipher.final()]);return [iv,cipher.getAuthTag(),data].map(b=>b.toString('hex')).join('.');
  }
  const list=()=>db.prepare('SELECT * FROM integrations ORDER BY id DESC').all().map(r=>{const c=JSON.parse(r.config);return {id:r.id,...c,source:webhookProviders.has(c.provider)?'Saved HTTPS endpoint':c.source,checked:r.checked,error:r.error,seeded:!!r.seeded};});
  async function destination(actorId,channelId) {
    const actor=await bot.actor(actorId),channel=await bot.channel(channelId);
    if(!actor.permissions.has('ManageMessages')||!channel.permissionsFor(actor)?.has(['ViewChannel','SendMessages']))throw new Error('Manage Messages and permission to post in this channel are required.');
    return channel;
  }
  async function save(actorId,input) {
    const config=integrationSchema.parse(input); sourceUrl(config.provider,config.source);await destination(actorId,config.channel);
    if(config.provider==='twitch'&&(!twitchId||!twitchSecret))throw new Error('Configure TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET on the bot host first.');
    if(webhookProviders.has(config.provider))config.source=crypt(config.source);
    if(list().length>=10)throw new Error('This instance supports up to 10 feed connections.');
    const id=Number(db.prepare('INSERT INTO integrations(config,actor) VALUES (?,?)').run(JSON.stringify(config),actorId).lastInsertRowid);
    return list().find(r=>r.id===id);
  }
  function change(id,enabled) {
    const row=db.prepare('SELECT config FROM integrations WHERE id=?').get(id);if(!row)throw new Error('Connection not found.');
    db.prepare('UPDATE integrations SET config=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.config),enabled}),id);
  }
  async function tick() {
    if(busy)return;busy=true;
    try { for(const row of db.prepare('SELECT * FROM integrations').all()) {
      const c=JSON.parse(row.config),webhook=webhookProviders.has(c.provider);
      if(!c.enabled||now()-row.checked<(webhook?60:15)*60000)continue;
      db.prepare('UPDATE integrations SET checked=? WHERE id=?').run(now(),row.id);
      try {
        const channel=await destination(row.actor,c.channel);
        if(!JSON.parse(db.prepare('SELECT config FROM integrations WHERE id=?').get(row.id)?.config||'{}').enabled)continue;
        if(webhook) {
          const stats=store.stats(1);
          const body=JSON.stringify({source:'Manta',type:'activity.summary',period:'current UTC day',at:new Date(now()).toISOString(),data:{messages:stats.messages,activeMembers:stats.activeMembers,voiceSeconds:stats.voiceSeconds,joins:stats.joins,leaves:stats.leaves}});
          await read(crypt(c.source,true),{method:'POST',headers:{'Content-Type':'application/json'},body});
          db.prepare("UPDATE integrations SET seeded=1,error='' WHERE id=?").run(row.id);continue;
        }
        let options={};
        if(c.provider==='twitch') {
          if(!twitchId||!twitchSecret)throw new Error('Twitch host credentials are missing.');
          if(!twitchToken||now()>=tokenUntil) {
            const token=JSON.parse(await read('https://id.twitch.tv/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:twitchId,client_secret:twitchSecret,grant_type:'client_credentials'}).toString()}));
            if(!token.access_token||!Number.isFinite(token.expires_in))throw new Error('Twitch authorization failed.');
            twitchToken=token.access_token;tokenUntil=now()+Math.max(0,token.expires_in-60)*1000;
          }
          options={headers:{'Client-Id':twitchId,Authorization:`Bearer ${twitchToken}`}};
        }
        const items=parseItems(c.provider,await read(sourceUrl(c.provider,c.source),options));
        let seen=JSON.parse(row.seen);
        if(row.seeded) for(const item of items.filter(i=>!seen.includes(i.id)).slice(0,3).reverse()) {
          if(!JSON.parse(db.prepare('SELECT config FROM integrations WHERE id=?').get(row.id)?.config||'{}').enabled)break;
          const title=item.title.replace(/([\\*_`~|>])/g,'\\$1');
          await channel.send({content:`${c.name.replace(/([\\*_`~|>])/g,'\\$1')}\n${title}\n<${item.link}>`,allowedMentions:{parse:[]}});
          seen=[item.id,...seen].slice(0,100);
          db.prepare('UPDATE integrations SET seen=? WHERE id=?').run(JSON.stringify(seen),row.id);
        }
        // First check establishes a baseline, so connecting never floods old posts.
        if(!row.seeded)seen=items.map(i=>i.id);
        db.prepare("UPDATE integrations SET seen=?,seeded=1,error='' WHERE id=?").run(JSON.stringify(seen),row.id);
      } catch(e) { if(c.provider==='twitch')twitchToken=null;db.prepare('UPDATE integrations SET error=? WHERE id=?').run(e.message.includes('permission')?'Posting permission was removed. Pause or reconnect as current staff.':'Could not check or deliver this connection. Check the source, host credentials and channel permissions.',row.id); }
    }} finally {busy=false;}
  }
  return {list,save,change,tick,remove:id=>db.prepare('DELETE FROM integrations WHERE id=?').run(id)};
}
