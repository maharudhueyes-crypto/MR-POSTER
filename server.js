require('dotenv').config();
const express=require('express'),fs=require('fs'),crypto=require('crypto');
const Razorpay=require('razorpay'),cron=require('node-cron');
const {createCanvas,loadImage}=require('@napi-rs/canvas');
const {BASE_URL,RZP_KEY,RZP_SECRET,RZP_PLAN_ID,WEBHOOK_SECRET,PORT=3000}=process.env;
const rzp=new Razorpay({key_id:RZP_KEY,key_secret:RZP_SECRET});
const DATA=process.env.DATA_DIR||'.',DB=DATA+'/data.json',load=()=>fs.existsSync(DB)?JSON.parse(fs.readFileSync(DB)):{},save=d=>fs.writeFileSync(DB,JSON.stringify(d));
fs.mkdirSync(DATA+'/posters',{recursive:true});
const app=express();
app.use(express.json({limit:'6mb',verify:(r,_,b)=>r.raw=b}));
app.use('/posters',express.static(DATA+'/posters'));
app.use(express.static('public'));
app.get('/health',(_,r)=>r.send('ok'));

const hooks=['Today\'s special','Why choose us?','Book now','Our services','Customer favourite','Visit us today','Limited offer'];
const themes=[(c)=>[c,'#1a1a1a','#fff'],(c)=>['#fff7ec',c,'#222'],(c)=>['#111',c,'#fff'],(c)=>[c,'#fff','#111']];
function wrap(x,t,px,py,mw,lh){let l='';for(const s of t.split(' ')){if(x.measureText(l+s).width>mw){x.fillText(l,px,py);py+=lh;l=''}l+=s+' '}x.fillText(l,px,py);return py}

async function makePoster(u,d=Math.floor(Date.now()/864e5)){
  const cv=createCanvas(1080,1080),x=cv.getContext('2d'),c=u.col||'#e8590c';
  const [a,b,t]=themes[d%4](c),g=x.createLinearGradient(0,0,1080,1080);
  g.addColorStop(0,a);g.addColorStop(1,b);x.fillStyle=g;x.fillRect(0,0,1080,1080);
  const sv=(u.svc||'').split('\n').map(s=>s.trim()).filter(Boolean),pick=sv.length?sv[d%sv.length]:'Our Service',hook=hooks[d%hooks.length];
  x.fillStyle=t;x.font='600 42px sans-serif';x.fillText(hook.toUpperCase(),80,330);
  x.font='bold 100px sans-serif';const y=wrap(x,pick,80,450,920,115);
  x.font='38px sans-serif';wrap(x,u.tag||'',80,y+80,900,50);
  x.font='34px sans-serif';sv.slice(0,4).forEach((s,i)=>x.fillText('- '+s,80,y+190+i*52));
  x.fillStyle='rgba(0,0,0,.5)';x.fillRect(0,950,1080,130);x.fillStyle='#fff';
  x.font='bold 36px sans-serif';x.fillText('Call: '+(u.ph||''),60,1010);x.font='28px sans-serif';x.fillText((u.ad||'').slice(0,50),60,1050);
  x.font='bold 40px sans-serif';x.textAlign='right';x.fillText(u.name||'',1020,200);x.textAlign='left';
  if(u.logo){try{const im=await loadImage(Buffer.from(u.logo.split(',')[1],'base64'));x.save();x.beginPath();x.arc(140,140,80,0,7);x.clip();x.fillStyle='#fff';x.fillRect(60,60,160,160);x.drawImage(im,60,60,160,160);x.restore()}catch{}}
  const file=`posters/${u.id}-${new Date().toISOString().slice(0,10)}.png`;
  fs.writeFileSync(DATA+'/'+file,cv.toBuffer('image/png'));
  const caption=`${hook}\n${pick} - ${u.name}\n${u.tag||''}\n\nCall: ${u.ph||''}\n${u.ad||''}\n\n#${(u.name||'').replace(/\W/g,'')} #${pick.replace(/\W/g,'')}`;
  return {url:`${BASE_URL}/${file}`,caption};
}
const gf=async(p,body)=>{const r=await fetch('https://graph.facebook.com/v21.0/'+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(j.error)throw new Error(j.error.message);return j};
async function postAll(u){
  const {url,caption}=await makePoster(u),out={};
  if(u.fbPage&&u.fbToken)try{await gf(u.fbPage+'/photos',{url,caption,access_token:u.fbToken});out.facebook='ok'}catch(e){out.facebook=e.message}
  if(u.igId&&u.fbToken)try{const m=await gf(u.igId+'/media',{image_url:url,caption,access_token:u.fbToken});await gf(u.igId+'/media_publish',{creation_id:m.id,access_token:u.fbToken});out.instagram='ok'}catch(e){out.instagram=e.message}
  return out;
}
app.post('/api/register',(req,res)=>{const db=load(),id=req.body.id||crypto.randomBytes(6).toString('hex');db[id]={...db[id],...req.body,id};save(db);res.json({id})});
app.post('/api/subscribe',async(req,res)=>{try{const s=await rzp.subscriptions.create({plan_id:RZP_PLAN_ID,total_count:120,customer_notify:1,notes:{uid:req.body.id}});const db=load();if(db[req.body.id]){db[req.body.id].subId=s.id;save(db)}res.json({sub:s.id,key:RZP_KEY})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/webhook',(req,res)=>{
  const sig=crypto.createHmac('sha256',WEBHOOK_SECRET).update(req.raw).digest('hex');
  if(sig!==req.headers['x-razorpay-signature'])return res.sendStatus(400);
  const ev=req.body.event,uid=req.body.payload?.subscription?.entity?.notes?.uid,db=load();
  if(uid&&db[uid]){if(['subscription.activated','subscription.charged'].includes(ev))db[uid].active=true;if(['subscription.cancelled','subscription.halted','subscription.completed'].includes(ev))db[uid].active=false;save(db)}
  res.sendStatus(200)});
app.post('/api/post-now',async(req,res)=>{const u=load()[req.body.id];if(!u)return res.sendStatus(404);try{res.json(await postAll(u))}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/status',(req,res)=>{const u=load()[req.body.id];if(!u)return res.sendStatus(404);res.json({active:!!u.active,time:u.time,last:u.last||null,log:u.log||null})});
app.post('/api/cancel',async(req,res)=>{const db=load(),u=db[req.body.id];if(!u)return res.sendStatus(404);try{if(u.subId)await rzp.subscriptions.cancel(u.subId,false);u.active=false;save(db);res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/preview',async(req,res)=>{const u=load()[req.body.id];if(!u)return res.sendStatus(404);res.json(await makePoster(u))});

cron.schedule('* * * * *',async()=>{
  const now=new Date().toLocaleTimeString('en-GB',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit'}),today=new Date().toISOString().slice(0,10),db=load();
  for(const u of Object.values(db)){if(u.active&&u.time===now&&u.last!==today){u.last=today;save(db);try{u.log=await postAll(u)}catch(e){u.log={error:e.message}}save(db)}}
});
cron.schedule('30 3 * * *',()=>{const d=DATA+'/posters';for(const f of fs.readdirSync(d)){const p=d+'/'+f;if(Date.now()-fs.statSync(p).mtimeMs>7*864e5)fs.unlinkSync(p)}});
app.listen(PORT,()=>console.log('Running on '+PORT));
