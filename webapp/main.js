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

function formatPlayerTitle(p){
  const fullName = [p.first_name||'', p.last_name||''].join(' ').trim();
  const base = [fullName, p.username ? '@'+p.username : null].filter(Boolean).join(' ');
  return (base || ('ID '+p.telegram_id)) + ' · ' + Math.round(p.rating);
}

async function renderHome(){
  const [{ player }, { players }] = await Promise.all([
    api('/api/me'),
    api('/api/players'),
  ]);

  content.innerHTML = `
    <div class="card">
      <div class="row"><strong>Ваш рейтинг:</strong> <span>${player.rating.toFixed(1)}</span></div>
      <div class="row"><strong>RD:</strong> <span>${player.rd.toFixed(1)}</span></div>
    </div>

    <div class="card">
      <div class="row">
        <div class="select" id="opponentSelect">
          <input id="opponentInput" placeholder="Поиск игроков" autocomplete="off" />
          <div class="dropdown" id="opponentDropdown"></div>
        </div>
      </div>
      <div class="row" style="margin-top:8px">
        <input id="score" placeholder="Счёт, например 2:1" />
      </div>
      <div class="row" style="margin-top:12px">
        <button class="primary" id="send">Отправить заявку</button>
      </div>
    </div>`;

  const input = document.getElementById('opponentInput');
  const dropdown = document.getElementById('opponentDropdown');
  let selectedTelegramId = null;

  function normalize(s){ return String(s||'').toLowerCase(); }
  function itemMatches(p, q){
    if (!q) return true;
    const qn = normalize(q);
    return [p.username, p.first_name, p.last_name, p.telegram_id]
      .map(normalize)
      .some((v)=> String(v).includes(qn));
  }
  function renderOptions(q=''){
    dropdown.innerHTML = players
      .filter(p=> itemMatches(p, q))
      .slice(0, 50)
      .map(p=> `<div class="option" data-id="${p.telegram_id}">${formatPlayerTitle(p)}</div>`)
      .join('');
    dropdown.querySelectorAll('.option').forEach(el=>{
      el.onclick = ()=>{
        selectedTelegramId = Number(el.dataset.id);
        const p = players.find(x=> x.telegram_id === selectedTelegramId);
        input.value = formatPlayerTitle(p).replace(/\s·\s\d+$/, '');
        dropdown.parentElement.classList.remove('open');
      };
    });
  }

  input.addEventListener('focus', ()=>{
    dropdown.parentElement.classList.add('open');
    renderOptions(input.value);
  });
  input.addEventListener('input', ()=>{
    selectedTelegramId = null;
    renderOptions(input.value);
  });
  document.addEventListener('click', (e)=>{
    const sel = document.getElementById('opponentSelect');
    if (!sel.contains(e.target)) sel.classList.remove('open');
  });

  renderOptions('');

  document.getElementById('send').onclick = async ()=>{
    const score = document.getElementById('score').value.trim();
    const opponentTelegramId = selectedTelegramId;
    if (!opponentTelegramId) return toast('Выберите соперника из списка');
    try {
      const res = await api('/api/matches', { method:'POST', body: JSON.stringify({ opponentTelegramId, score })});
      if (res.notified) toast('Заявка отправлена сопернику в чате');
      else toast('Заявка зарегистрирована, но уведомление не доставлено');
      input.value = '';
      selectedTelegramId = null;
    } catch (e){ toast('Ошибка: '+e.message); }
  };
}

// registration moved into Home

async function renderLeaders(){
  const { leaders } = await api('/api/leaders');
  content.innerHTML = `<div class="list">${leaders.map((p,i)=>`<div class="card">${i+1}. ${formatPlayerTitle(p)} (RD ${p.rd.toFixed(0)})</div>`).join('')}</div>`;
}

function selectTab(name){
  tabs.forEach((b)=> b.classList.toggle('active', b.dataset.tab===name));
  if (name==='home') renderHome();
  if (name==='leaders') renderLeaders();
}

function toast(text){
  if (tg?.showPopup) tg.showPopup({ title: 'Сообщение', message: text, buttons: [{id:'ok', type:'close'}]});
  else alert(text);
}

selectTab('home');


