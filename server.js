const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || process.env.DISCORD_WEBHOOK_URL || process.env.WEBHOOK_URL || '';
const JS_GET = process.env.JSONSTORAGE_GET_URL || 'https://api.jsonstorage.net/v1/json/2f2bc2b0-9d3a-4d2e-b3b3-517b33ed9011/d17176bc-b948-4513-9617-d9531eb9febe';
const JS_PUT = process.env.JSONSTORAGE_PUT_URL || 'https://api.jsonstorage.net/v1/json/2f2bc2b0-9d3a-4d2e-b3b3-517b33ed9011/d17176bc-b948-4513-9617-d9531eb9febe?apiKey=b34dac67-5c67-4ddd-8ed4-e0337941bfdb';
const CACHE_FILE = path.join(__dirname, 'data-cache.json');

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname)));

function emptyData(){ return { orders: [], companies: [], products: [], categories: [] }; }
function readCache(){
  try { return JSON.parse(fs.readFileSync(CACHE_FILE,'utf8')); }
  catch { return emptyData(); }
}
function writeCache(data){
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2)); } catch(e) { console.error('Cache write:',e.message); }
}
async function getRemoteData(){
  const r = await fetch(JS_GET, { headers:{'Accept':'application/json'} });
  if(!r.ok) throw new Error(`JSONStorage GET ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data && typeof data === 'object' ? data : emptyData();
}
async function saveRemoteData(data){
  const r = await fetch(JS_PUT, {
    method:'PUT', headers:{'Content-Type':'application/json','Accept':'application/json'}, body:JSON.stringify(data)
  });
  if(!r.ok) throw new Error(`JSONStorage PUT ${r.status}: ${await r.text()}`);
  return true;
}
async function getDataSafe(){
  const cache = {...emptyData(), ...readCache()};
  try {
    const remote = {...emptyData(), ...(await getRemoteData())};
    const cacheTs = Number(cache.updatedAt||0)||0;
    const remoteTs = Number(remote.updatedAt||0)||0;
    // La copie la plus récente est la source principale. On fusionne seulement les commandes.
    const newest = cacheTs > remoteTs ? cache : remote;
    const mergedOrders = new Map();
    for (const o of (remote.orders||[])) if (o?.id) mergedOrders.set(o.id,o);
    for (const o of (cache.orders||[])) if (o?.id) mergedOrders.set(o.id,o);
    const data = {...emptyData(), ...newest, orders:[...mergedOrders.values()]};
    data.updatedAt = Math.max(cacheTs,remoteTs,Number(data.updatedAt||0)||0);
    writeCache(data);
    return {data, source: cacheTs>remoteTs ? 'cache-newer' : 'remote-newer'};
  } catch(e) {
    console.error('Remote load failed:',e.message);
    return {data:cache, source:'cache'};
  }
}
async function persistData(data){
  // Local server cache is written first and never depends on the remote service.
  writeCache(data);
  try {
    await saveRemoteData(data);
    return {ok:true};
  } catch(e) {
    console.error('Remote save failed:',e.message);
    return {ok:false,error:e.message};
  }
}
async function sendDiscord(order){
  if(!DISCORD_WEBHOOK) return {ok:false,error:'DISCORD_WEBHOOK non configuré'};
  const prodLines=(order.products||[]).map(p=>`> **${p.name}** — ${p.qty} × $${p.price} = **$${p.qty*p.price}**`).join('\n').slice(0,1000) || '—';
  const embed={
    username:'LTD Sandy Shores',
    embeds:[{
      title:'🛒 Nouvelle commande — '+order.id,
      color:0x5C3A21,
      fields:[
        {name:'🏢 Entreprise',value:String(order.company||'—').slice(0,1024),inline:true},
        {name:'📞 Téléphone',value:String(order.tel||'—').slice(0,1024),inline:true},
        {name:'🏦 IBAN',value:'||'+String(order.iban||'—').slice(0,1000)+'||',inline:true},
        {name:'📦 Produits',value:prodLines,inline:false},
        {name:'⚖️ Poids',value:String(order.weight||0)+' kg',inline:true},
        {name:'🚚 Livraison',value:order.freeDelivery?'✅ Offerte':'$50',inline:true},
        {name:'💰 Total',value:'**$'+Number(order.total||0).toLocaleString('fr-FR')+'**',inline:true},
        {name:'📍 Adresse',value:String(order.adresse||'—').slice(0,1024),inline:false},
        {name:'📅 Date',value:String(order.date||'—'),inline:true},
        {name:'🕐 Horaire',value:String(order.horaire||'—'),inline:true}
      ],
      footer:{text:'LTD Sandy Shores · Espace Particulier'},
      timestamp:new Date().toISOString()
    }]
  };
  const target = DISCORD_WEBHOOK + (DISCORD_WEBHOOK.includes('?') ? '&' : '?') + 'wait=true';
  const r=await fetch(target,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(embed)});
  if(!r.ok) return {ok:false,error:`Discord ${r.status}: ${(await r.text()).slice(0,300)}`};
  return {ok:true};
}

app.get('/api/data', async (req,res)=>{
  const {data,source}=await getDataSafe();
  res.json({...emptyData(),...data,_source:source});
});

app.post('/api/save', async (req,res)=>{
  try { const body={...emptyData(),...req.body}; body.updatedAt=Number(body.updatedAt||Date.now()); const result=await persistData(body); res.status(200).json({ok:true,cached:true,remote:result,updatedAt:body.updatedAt}); }
  catch(e){ console.error('Save failed:',e.message); res.status(500).json({ok:false,error:e.message}); }
});

// Order creation: cache immediately, then remote persistence and Discord independently.
// A storage outage must never prevent the Discord notification from being sent.
app.post('/api/orders', async (req,res)=>{
  try{
    const order=req.body;
    if(!order || !order.id || !order.company || !Array.isArray(order.products)) {
      return res.status(400).json({ok:false,error:'Commande invalide'});
    }

    const {data}=await getDataSafe();
    const current={...emptyData(),...data};
    if(!current.orders.some(o=>o.id===order.id)) current.orders.push(order);

    // Guarantee an immediate server-side cache before any network dependency.
    writeCache(current);

    const [storage, discord] = await Promise.all([
      persistData(current),
      sendDiscord(order).catch(e=>({ok:false,error:e.message}))
    ]);

    res.status(discord.ok ? 200 : 207).json({
      ok:true,
      saved:true,
      cached:true,
      remote:storage,
      discord
    });
  }catch(e){
    console.error('Order create failed:',e.message);
    res.status(500).json({ok:false,saved:false,error:e.message});
  }
});

// Manual Discord retry for an order already saved.
app.post('/api/notify', async (req,res)=>{
  try{
    const result=await sendDiscord(req.body||{});
    res.status(result.ok?200:502).json(result);
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.post('/api/discord/status', async (req,res)=>{
  try{
    const {orderId,status}=req.body||{};
    if(!orderId||!['pending','validated','ready','done','cancel'].includes(status)) return res.status(400).json({ok:false});
    const {data}=await getDataSafe();
    const current={...emptyData(),...data};
    const idx=current.orders.findIndex(o=>o.id===orderId); if(idx<0)return res.status(404).json({ok:false});
    current.orders[idx].status=status;
    current.orders[idx].statusHistory=current.orders[idx].statusHistory||[];
    current.orders[idx].statusHistory.push({status,date:new Date().toLocaleDateString('fr-FR'),time:new Date().toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}),source:'admin'});
    await persistData(current);
    res.json({ok:true});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});


app.get('/api/test-webhook', async (req,res)=>{
  try{
    if(!DISCORD_WEBHOOK) return res.status(500).json({ok:false,error:'Webhook Discord non configuré sur Render',acceptedEnvNames:['DISCORD_WEBHOOK','DISCORD_WEBHOOK_URL','WEBHOOK_URL']});
    const target = DISCORD_WEBHOOK + (DISCORD_WEBHOOK.includes('?') ? '&' : '?') + 'wait=true';
    const r = await fetch(target,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({content:'✅ Test webhook LTD Sandy Shores — connexion Discord OK.'})
    });
    const body = await r.text();
    if(!r.ok) return res.status(502).json({ok:false,status:r.status,error:body.slice(0,500)});
    res.json({ok:true,status:r.status,message:'Message test envoyé sur Discord'});
  }catch(e){
    res.status(500).json({ok:false,error:e.message});
  }
});

app.get('/api/status', async (req,res)=>{
  let storage=false, storageError='';
  try{ await getRemoteData(); storage=true; } catch(e){ storageError=e.message; }
  res.json({ok:true,discordConfigured:Boolean(DISCORD_WEBHOOK),storage,storageError});
});

app.get('/health',(req,res)=>res.status(200).json({ok:true}));
app.use((req,res,next)=>{ if(req.method!=='GET'||req.path.startsWith('/api/'))return next(); res.sendFile(path.join(__dirname,'index.html')); });
app.use((req,res)=>res.status(404).json({ok:false,error:'Not found'}));
app.listen(PORT,'0.0.0.0',()=>{
  console.log('LTD Sandy Shores on port',PORT);
  console.log('Discord webhook configured:', Boolean(DISCORD_WEBHOOK));
});
