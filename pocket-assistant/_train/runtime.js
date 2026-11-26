let model;
function decodeMatrices(raw){
  for(const key of ['W','V']){
    const {bytes,scale,cols}=raw[key]; const data=atob(bytes);
    const signed=new Int8Array(Uint8Array.from(data,c=>c.charCodeAt(0)).buffer);
    raw[key]=Array.from({length:signed.length/cols},(_,i)=>Float32Array.from(signed.subarray(i*cols,(i+1)*cols),n=>n*scale));
  }
  return raw;
}
function classify(s){
  const phrase=(s.toLowerCase().match(/[a-z0-9_]+|==|=/g)||[]).join(' ');
  if(Object.prototype.hasOwnProperty.call(model.exact,phrase))return model.exact[phrase];
  const words=(s.toLowerCase().match(/[a-z0-9_]+|==|=/g)||[]).filter(w=>!stop.has(w));
  const definition=s.toLowerCase().trim().match(/^what(?: is|'s|s| are) (?:an? |the )?([a-z0-9-]+)[?!.]*$/);
  if(definition && !Object.prototype.hasOwnProperty.call(model.vocab,definition[1]))return -1;
  const features=new Set(words);
  for(const w of words){const p='^'+w+'$';for(let i=0;i<p.length-2;i++)features.add('~'+p.slice(i,i+3));}
  const ids=[...features].filter(t=>Object.prototype.hasOwnProperty.call(model.vocab,t)).map(t=>model.vocab[t]);
  if(!ids.length || ids.length/features.size<.43)return -1;
  const norm=Math.sqrt(ids.reduce((n,i)=>n+model.idf[i]**2,0));
  const hidden=model.V.map((_,j)=>Math.tanh(ids.reduce((n,i)=>n+model.W[i][j]*model.idf[i]/norm,0)));
  const scores=model.topics.map((_,k)=>hidden.reduce((n,h,j)=>n+h*model.V[j][k],0));
  const max=Math.max(...scores);
  return 1/scores.reduce((n,x)=>n+Math.exp(x-max),0)>=.74?scores.indexOf(max):-1;
}
let stop=new Set();
const menu=document.querySelector('#menu'), historyBox=document.querySelector('#history'), field=document.querySelector('#q');
function add(parent,tag,text){const el=document.createElement(tag);el.textContent=text;parent.append(el);return el;}
function show(i,q){
  const card=document.createElement('article');historyBox.append(card);
  if(q)add(card,'small',q);
  if(i<0){add(card,'p','I haven’t learned a reliable answer to that yet. Try a question from the topic menu.');return;}
  const t=model.topics[i];add(card,'h2',t.title);add(card,'p',t.desc);if(!t.code)return;add(card,'pre',t.code);
  const reveal=add(card,'details','');add(reveal,'summary','Reveal the output');add(reveal,'pre',t.answer);
}
const creativeBanks={"name": {"next": {"^": {"Midnight": 2, "Silver": 2, "Neon": 2, "Hidden": 2, "Golden": 2, "Wild": 2, "Blue": 2, "Rapid": 2, "Copper": 2}, "Midnight": {"Runners": 1, "Signal": 1}, "Runners": {"$": 3}, "Signal": {"Crew": 1, "Club": 1, "Studio": 1}, "Crew": {"$": 4}, "Silver": {"Signal": 1, "Comets": 1}, "Club": {"$": 4}, "Comets": {"$": 1}, "Neon": {"Comet": 1, "Drift": 1}, "Comet": {"Crew": 1, "Studio": 1}, "Drift": {"Club": 1, "Lab": 1}, "Hidden": {"Drift": 1, "Echo": 1}, "Lab": {"$": 1}, "Echo": {"Crew": 1, "Works": 1, "Runners": 1}, "Golden": {"Echo": 1, "Circuit": 1}, "Works": {"$": 2}, "Circuit": {"Club": 1, "Runners": 1}, "Wild": {"Circuit": 1, "Moon": 1}, "Moon": {"Studio": 1, "Crew": 1}, "Studio": {"$": 3}, "Blue": {"Moon": 1, "Signal": 1}, "Rapid": {"River": 1, "Echo": 1}, "River": {"Club": 1, "Works": 1}, "Copper": {"River": 1, "Comet": 1}}, "seen": ["Midnight Runners", "Midnight Signal Crew", "Silver Signal Club", "Silver Comets", "Neon Comet Crew", "Neon Drift Club", "Hidden Drift Lab", "Hidden Echo Crew", "Golden Echo Works", "Golden Circuit Club", "Wild Circuit Runners", "Wild Moon Studio", "Blue Moon Crew", "Blue Signal Studio", "Rapid River Club", "Rapid Echo Runners", "Copper River Works", "Copper Comet Studio"]}, "story": {"next": {"^": {"The": 6, "Nobody": 2, "Someone": 2, "A": 2}, "The": {"lights": 2, "clock": 2, "door": 2}, "lights": {"flickered": 2}, "flickered": {"just": 2}, "just": {"as": 4}, "as": {"the": 3, "a": 1}, "the": {"last": 4, "wall.": 2, "moment": 2, "scoreboard": 2, "missing": 2, "hidden": 2, "game": 2, "scoreboard.": 1}, "last": {"visitor": 3, "seat.": 1}, "visitor": {"left.": 3}, "left.": {"$": 3}, "a": {"message": 2}, "message": {"appeared": 2}, "appeared": {"on": 2}, "on": {"the": 2}, "wall.": {"$": 2}, "clock": {"stopped": 2}, "stopped": {"the": 1, "just": 1}, "moment": {"a": 1, "the": 1}, "door": {"opened": 2}, "opened": {"the": 1, "just": 1}, "scoreboard": {"went": 2}, "went": {"dark.": 2}, "dark.": {"$": 2}, "Nobody": {"noticed": 2}, "noticed": {"the": 2}, "missing": {"key": 2}, "key": {"until": 1, "under": 1}, "until": {"morning.": 1, "the": 1}, "morning.": {"$": 1}, "hidden": {"map": 2}, "map": {"until": 1, "under": 1}, "game": {"began.": 2}, "began.": {"$": 2}, "Someone": {"found": 2}, "found": {"the": 2}, "under": {"the": 2}, "seat.": {"$": 1}, "scoreboard.": {"$": 1}, "A": {"tiny": 2}, "tiny": {"screen": 1, "bell": 1}, "screen": {"blinked": 1}, "blinked": {"twice": 1}, "twice": {"before": 2}, "before": {"the": 2}, "bell": {"rang": 1}, "rang": {"twice": 1}}, "seen": ["The lights flickered just as the last visitor left.", "The lights flickered just as a message appeared on the wall.", "The clock stopped the moment a message appeared on the wall.", "The door opened the moment the last visitor left.", "The door opened just as the scoreboard went dark.", "The clock stopped just as the scoreboard went dark.", "Nobody noticed the missing key until morning.", "Nobody noticed the hidden map until the game began.", "Someone found the missing key under the last seat.", "Someone found the hidden map under the scoreboard.", "A tiny screen blinked twice before the game began.", "A tiny bell rang twice before the last visitor left."]}};
const interests=document.querySelector('#interest');
const picks=document.querySelector('#picks');
function interestList(){return interests.value.split(',').map(s=>s.trim()).filter(Boolean);}
function generateText(bank){
  for(let attempt=0;attempt<80;attempt++){
    const words=[];let last='^';
    while(words.length<28){
      const choices=Object.entries(bank.next[last]);let draw=Math.random()*choices.reduce((sum,p)=>sum+p[1],0);
      last=choices.find(p=>(draw-=p[1])<0)[0];
      if(last==='$')break;
      words.push(last);
    }
    const result=words.join(' ');
    if(last==='$' && !bank.seen.includes(result))return result;
  }
  return null;
}
function generate(kind,prompt){
  const card=document.createElement('article');historyBox.append(card);
  const theme=interestList();const chosen=theme[Math.floor(Math.random()*theme.length)];
  add(card,'h2',kind==='name'?'Name idea':'Story starter');
  const out=generateText(creativeBanks[kind]);
  add(card,'p',out?(chosen?(kind==='name'?chosen+' · '+out:'At the '+chosen+' club, something was different today. '+out):out):'Try again for a fresh combination.');
}
function refreshPicks(){
  picks.replaceChildren();
  const tags=interestList().join(' ').toLowerCase();
  const guides=[[ /soccer|football|sports/,'Soccer first touch'],[/game|gaming|fortnite|siege|console|ps5/,'Game practice routines'],[/cod(e|ing)|software|python|programming/,'Debugging'],[/business|startup|entrepreneur/,'MVPs'],[/photo|film|camera/,'Photo composition'],[/music|beat/,'Rhythm practice'],[/school|study/,'Remembering what you study']];
  const targets=new Set(guides.filter(([pattern])=>pattern.test(tags)).map(pair=>pair[1]));
  for(const term of interestList()){if(term.length>2){const i=classify(term);if(i>=0)targets.add(model.topics[i].title);}}
  for(const title of [...targets].slice(0,4)){
    const i=model.topics.findIndex(t=>t.title===title);
    if(i>=0){const b=add(picks,'button',title);b.onclick=()=>show(i,'');}
  }
}
const identity=document.querySelector('#identity'),welcome=document.querySelector('#welcome');
const profiles=new Map();let active='Luca';
function greet(){welcome.textContent='What’s on your mind, '+active+'?';}
function init(){
  stop=new Set(model.stop);
  model.topics.forEach((t,i)=>menu.add(new Option(t.title,String(i))));
  document.querySelector('#chat').onsubmit=e=>{
    e.preventDefault();
    const q=field.value.trim();
    if(!q){add(historyBox,'p','Type a question in the box first.');field.focus();return;}
    if(/(?:generate|invent|make up|give me|come up with).*(?:name|story starter)|(?:write|start).*(?:a story|story starter)/i.test(q)){
      generate(/name/i.test(q)?'name':'story',q);
    }else{show(classify(q),q);}
    field.value='';field.blur();historyBox.lastElementChild.scrollIntoView({block:'nearest'});
  };
  menu.onchange=()=>{if(menu.value!==''){show(Number(menu.value),'');menu.value='';}};
  document.querySelector('#viewer').hidden=true;
  document.querySelector('#chat').hidden=false;
  menu.hidden=false;
  document.querySelector('#creative').hidden=false;
  interests.oninput=refreshPicks;
  document.querySelector('#names').onclick=()=>generate('name','');
  document.querySelector('#stories').onclick=()=>generate('story','');
  const initialTags=new URLSearchParams(location.hash.slice(1)).get('interests');
  if(initialTags){
    interests.value=initialTags.slice(0,160);
    refreshPicks();
    document.querySelector('#creative').open=true;
  }
  document.querySelector('#fallback').hidden=true;
  const quick=document.querySelector('#quick');
  quick.hidden=false;
  for(const button of quick.querySelectorAll('button')){
    button.onclick=()=>{field.blur();show(classify(button.textContent),button.textContent);historyBox.scrollIntoView({block:'nearest'});};
  }
  identity.value=active;greet();
  identity.onchange=()=>{
    profiles.set(active,{cards:[...historyBox.childNodes],interests:interests.value,draft:field.value,open:document.querySelector('#creative').open});
    active=identity.value;const profile=profiles.get(active);
    historyBox.replaceChildren(...(profile?.cards||[]));interests.value=profile?.interests||'';field.value=profile?.draft||'';
    menu.value='';document.querySelector('#creative').open=profile?.open||false;refreshPicks();greet();window.scrollTo(0,0);
  };
  window.__assistantReady=true;
  window.__topicCount=model.topics.length;
  window.__classify=classify;
}
(async()=>{
  try{
    const res=await fetch(MODEL_URL,{cache:'no-cache'});
    if(!res.ok)throw new Error('model '+res.status);
    model=decodeMatrices(await res.json());
    init();
  }catch(err){
    const viewer=document.querySelector('#viewer');
    viewer.hidden=false;
    viewer.textContent='The topics list could not load. Scroll down to browse answers, or reload the page.';
    document.querySelector('#fallback').hidden=false;
    window.__assistantReady=false;
    window.__assistantError=String(err && err.message || err);
  }
})();
