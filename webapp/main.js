const tg = window.Telegram?.WebApp;
if (tg) tg.expand();

const initData = tg?.initData || '';

const content = document.getElementById('content');
const tabs = document.querySelectorAll('.tabs button');
tabs.forEach((b)=> b.addEventListener('click', ()=> selectTab(b.dataset.tab)));

async function api(path, opts={}){
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'x-telegram-init-data': initData,
      ...(opts.headers||{}),
    },
  });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function renderHome(){
  const { player } = await api('/api/me');
  content.innerHTML = `
    <div class="card">
      <div class="row"><strong>Ваш рейтинг:</strong> <span>${player.rating.toFixed(1)}</span></div>
      <div class="row"><strong>RD:</strong> <span>${player.rd.toFixed(1)}</span></div>
    </div>`;
}

async function renderRegister(){
  const { players } = await api('/api/players');
  content.innerHTML = `
    <div class="card">
      <div class="row">
        <select id="opponent">
          ${players.map(p=> `<option value="${p.telegram_id}">${p.username? '@'+p.username : 'ID '+p.telegram_id} · ${Math.round(p.rating)}</option>`).join('')}
        </select>
      </div>
      <div class="row" style="margin-top:8px">
        <input id="score" placeholder="Счёт, например 2:1" />
      </div>
      <div class="row" style="margin-top:12px">
        <button class="primary" id="send">Отправить заявку</button>
      </div>
    </div>`;
  document.getElementById('send').onclick = async ()=>{
    const opponentTelegramId = Number(document.getElementById('opponent').value);
    const score = document.getElementById('score').value.trim();
    try {
      await api('/api/matches', { method:'POST', body: JSON.stringify({ opponentTelegramId, score })});
      toast('Заявка отправлена сопернику в чате');
    } catch (e){ toast('Ошибка: '+e.message); }
  }
}

async function renderLeaders(){
  const { leaders } = await api('/api/leaders');
  content.innerHTML = `<div class="list">${leaders.map((p,i)=>`<div class="card">${i+1}. ${p.username? '@'+p.username : 'ID '+p.telegram_id} — ${p.rating.toFixed(1)} (RD ${p.rd.toFixed(0)})</div>`).join('')}</div>`;
}

function selectTab(name){
  tabs.forEach((b)=> b.classList.toggle('active', b.dataset.tab===name));
  if (name==='home') renderHome();
  if (name==='register') renderRegister();
  if (name==='leaders') renderLeaders();
}

function toast(text){
  if (tg?.showPopup) tg.showPopup({ title: 'Сообщение', message: text, buttons: [{id:'ok', type:'close'}]});
  else alert(text);
}

selectTab('home');


