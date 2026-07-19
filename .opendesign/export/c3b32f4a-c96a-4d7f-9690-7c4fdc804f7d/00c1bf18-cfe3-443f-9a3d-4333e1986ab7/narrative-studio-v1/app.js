(() => {
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const state = { page: 'narrative', view: 'lines', inspector: 'detail', mobileStep: 'canvas', dirty: false, pendingView: null, adopted: false, mystery: false, definition: 'terms' };
  const definitions = {
    normal: {
      terms: [['卷','通用“结构单元”的项目术语','《仙途》规则'],['主线 / 暗线','通用“叙事线路”的显示名称','《仙途》规则'],['奇则碰撞','通用“情境”的项目术语','《仙途》规则'],['爽点','通用“回报节点”的项目术语','《仙途》规则'],['商业节点','连载检查项的项目术语','《仙途》规则'],['章节六项交付','章节验收字段组','《仙途》规则']],
      objects: [['卷','结构单元','东方玄幻'],['单元 / 副本','结构单元','《仙途》规则'],['故事弧','状态变化','通用内核'],['期待','承诺、悬念、伏笔','通用内核']],
      fields: [['章节目标','文本','通用内核'],['关键节拍','叙事节点[]','长篇小说'],['结果维度','多选','《仙途》规则'],['六项交付','检查项[]','《仙途》规则']],
      relations: [['所属线路','节点 → 线路','通用内核'],['采用为','灵感 → 任意对象','通用内核'],['计划锚点','对象 → 章节计划','通用内核'],['覆盖定义','上层 → 下层定义','通用内核']],
      checks: [['引用完整性','阻断错误','通用内核'],['连载节奏','警告','连载创作'],['卷级商业节点','最低 2 个','《仙途》规则'],['奇则碰撞','必须产生代价','《仙途》规则']],
      views: [['线路泳道','默认','通用内核'],['章节计划','紧凑表格','长篇小说'],['期待追踪','时间轴','通用内核'],['自由大纲','Markdown','长篇小说']]
    },
    mystery: {
      terms: [['案件','通用“结构单元”的题材术语','悬疑推理'],['调查线','通用“叙事线路”的显示名称','悬疑推理'],['线索','通用“信息揭示”的题材术语','悬疑推理'],['谜团','通用“期待”的题材术语','悬疑推理'],['公平性检查','信息可得性验收规则','悬疑推理'],['线索矩阵','关系视图的题材配置','悬疑推理']],
      objects: [['案件','结构单元','悬疑推理'],['调查阶段','结构单元','悬疑推理'],['嫌疑人弧','状态变化','项目规则'],['谜团','期待','悬疑推理']],
      fields: [['调查目标','文本','悬疑推理'],['已知线索','信息揭示[]','悬疑推理'],['嫌疑范围','角色[]','项目规则'],['误导风险','低 / 中 / 高','项目规则']],
      relations: [['线索指向','线索 → 嫌疑人','悬疑推理'],['采用为','灵感 → 任意对象','通用内核'],['发生于','事件 → 案件阶段','通用内核'],['排除嫌疑','线索 → 角色','项目规则']],
      checks: [['引用完整性','阻断错误','通用内核'],['线索可得性','公平性检查','悬疑推理'],['关键证据前置','阻断错误','项目规则'],['误导可解释','警告','项目规则']],
      views: [['调查线泳道','默认','悬疑推理'],['案件计划','紧凑表格','长篇小说'],['谜团追踪','时间轴','悬疑推理'],['线索矩阵','关系视图','悬疑推理']]
    }
  };

  function icon(id) { return `<svg><use href="#i-${id}"/></svg>`; }
  function toast(message) { const el = $('#toast'); el.querySelector('span').textContent = message; el.classList.add('is-visible'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('is-visible'), 2400); }
  function setMobileStep(step) { state.mobileStep = step; $$('.mobile-step-nav button').forEach(b => b.classList.toggle('is-active', b.dataset.mobileStep === step)); const page = $(`[data-page-panel="${state.page}"]`); $$('[data-mobile-panel]', page).forEach(p => p.classList.toggle('is-mobile-active', p.dataset.mobilePanel === step)); }
  function setPage(page) {
    state.page = page;
    $$('.primary-nav__item[data-page]').forEach(b => b.classList.toggle('is-active', b.dataset.page === page)); $$('.page').forEach(p => p.classList.toggle('is-active', p.dataset.pagePanel === page));
    const titles = { narrative:'《仙途》 · 叙事设计', inspiration:'《仙途》 · 项目灵感', scheme:'《仙途》 · 创作方案' }; $('#page-title').textContent = titles[page];
    $('.scheme-chip').style.display = page === 'scheme' ? 'none' : ''; setMobileStep(page === 'narrative' ? 'canvas' : 'canvas'); $('#new-menu').classList.remove('is-open');
  }
  function requestView(view) { if (state.dirty && state.view === 'outline' && view !== 'outline') { state.pendingView = view; $('#unsaved-modal').classList.add('is-open'); return; } setView(view); }
  function setView(view) {
    state.view = view; $$('.view-tabs [data-view]').forEach(b => b.classList.toggle('is-active', b.dataset.view === view)); $$('.view-stage').forEach(p => p.classList.toggle('is-active', p.dataset.viewPanel === view));
    if (view === 'chapters') updateChapterInspector(); if (view === 'expectations') updateExpectationInspector();
  }
  function updateChapterInspector() { $('#inspector-title').textContent='第 42 章 · 灰烬留痕'; $('.object-heading p').textContent='以残火完成第一次独立炼丹，交付能力、代价、关系推进等六项结果。'; $('.field-list', $('.inspector-content[data-inspector-panel="detail"]')).innerHTML='<div><dt>来源线路</dt><dd><button class="inline-link" data-view="lines">问道主线 · 丹成大道</button></dd></div><div><dt>六项交付</dt><dd>目标、阻力、选择、代价、回报、钩子<small>来自《仙途》项目规则，不属于通用内核</small></dd></div><div><dt>完成情况</dt><dd>4 / 6 · 64%</dd></div><div><dt>期待</dt><dd><button class="inline-link" data-view="expectations">2 个待兑现</button></dd></div>';
  }
  function updateExpectationInspector() { $('#inspector-title').textContent='灰烬中的第二道剑痕'; $('.object-heading p').textContent='在第 42 章埋设，第 43 章强化，计划于第 66 章回收。'; $('.field-list', $('.inspector-content[data-inspector-panel="detail"]')).innerHTML='<div><dt>期待类型</dt><dd>伏笔<small>当前项目采用的期待类型</small></dd></div><div><dt>埋设</dt><dd>第 42 章 · 灰烬留痕</dd></div><div><dt>强化</dt><dd>第 43 章 · 剑痕指向宗门暗线</dd></div><div><dt>计划回收</dt><dd>第 66 章 · 火脉真相</dd></div>';
  }
  function renderDefinitions() {
    const mode = state.mystery ? 'mystery' : 'normal'; const rows = definitions[mode][state.definition];
    $('#definition-list').innerHTML = rows.map((r,i)=>`<button class="definition-row ${i===2?'is-selected':''}"><strong>${r[0]}<small>${r[1]}</small></strong><span>${state.definition==='terms'?'显示名称':'已解析定义'}</span><span class="source-label ${r[2].includes('规则')?'project':''}">${r[2]}</span></button>`).join('');
  }
  function toggleMystery() {
    state.mystery=!state.mystery; const mystery=state.mystery; $('#mystery-preview').textContent=mystery?'退出预览':'悬疑长篇预览'; $('#scheme-mode-label').textContent=mystery?'临时预览 · 悬疑长篇':'正式配置 · 《仙途》';
    $('#definition-title').textContent=mystery?'悬疑项目术语':'《仙途》项目术语'; $('#impact-title').textContent=mystery?'“公平性检查”':'“奇则碰撞”'; $('#impact-description').textContent=mystery?'悬疑配置为通用检查项提供的信息公平性规则，不改变底层检查能力。':'《仙途》为通用“情境”提供的项目术语，不改变底层对象能力。';
    $('#layer-list').innerHTML = mystery ? '<button><i class="layer-core"></i><span><strong>通用叙事内核</strong><small>平台内置 · 只读</small></span><b>启用</b></button><button><i></i><span><strong>长篇小说</strong><small>篇幅</small></span><b>启用</b></button><button><i></i><span><strong>连续叙事</strong><small>载体</small></span><b>启用</b></button><button><i></i><span><strong>悬疑推理</strong><small>题材配置包</small></span><b>预览</b></button><button class="is-selected"><i class="layer-project"></i><span><strong>《临江旧案》项目规则</strong><small>临时示例</small></span><b>预览</b></button><button><i class="layer-local"></i><span><strong>作者本地调整</strong><small>1 项覆盖</small></span><b>预览</b></button>' : '<button><i class="layer-core"></i><span><strong>通用叙事内核</strong><small>平台内置 · 只读</small></span><b>启用</b></button><button><i></i><span><strong>长篇小说</strong><small>篇幅</small></span><b>启用</b></button><button><i></i><span><strong>连载创作</strong><small>发布方式</small></span><b>启用</b></button><button><i></i><span><strong>东方玄幻</strong><small>题材配置包</small></span><b>启用</b></button><button class="is-selected"><i class="layer-project"></i><span><strong>《仙途》项目规则</strong><small>本项目</small></span><b>启用</b></button><button><i class="layer-local"></i><span><strong>作者本地调整</strong><small>2 项覆盖</small></span><b>启用</b></button>';
    const workspaces = $$('.impact-panel section')[0]; workspaces.innerHTML = mystery?'<header>出现于工作面</header><button><span>叙事设计 · 调查线</span><b>当前 4 条</b></button><button><span>案件计划 · 线索矩阵</span><b>当前 12 条</b></button><button><span>验收 · 公平性检查</span><b>2 项待处理</b></button>':'<header>出现于工作面</header><button><span>叙事设计 · 线路详情</span><b>当前 3 个</b></button><button><span>章节计划 · 六项交付</span><b>当前 8 章</b></button><button><span>灵感 · 采用为</span><b>可选去向</b></button>';
    const sources=$('.source-stack'); sources.innerHTML=mystery?'<span><i></i>通用叙事内核<b>检查项</b></span><span><i></i>悬疑推理<b>线索可得性</b></span><span class="active"><i></i>《临江旧案》项目规则<b>公平性检查</b></span>':'<span><i></i>通用叙事内核<b>情境</b></span><span><i></i>东方玄幻<b>规则碰撞</b></span><span class="active"><i></i>《仙途》项目规则<b>奇则碰撞</b></span>';
    renderDefinitions(); toast(mystery?'已进入悬疑长篇临时预览':'已返回《仙途》正式配置');
  }
  function adoptIdea() {
    state.adopted=true; $('#adopt-modal').classList.remove('is-open'); $('#idea-status').textContent='已采用'; $('#idea-status').classList.add('active'); $('#adopted-folder b').textContent='19';
    $('#adoption-record').innerHTML='<header><strong>采用记录 · 1</strong><span>由关系自动推导状态</span></header><div class="adoption-entry">'+icon('link')+'<span><strong>情境 → 奇则碰撞</strong><small>关联到“丹成大道” · 刚刚创建 adopted-as 关系</small></span></div>';
    $('#adopt-button').innerHTML=icon('plus')+'继续采用为'; toast('已采用到“丹成大道”，状态已自动更新');
  }

  document.addEventListener('click', e => {
    const pageBtn=e.target.closest('[data-page]'); if(pageBtn){setPage(pageBtn.dataset.page);return}
    const jump=e.target.closest('[data-jump]'); if(jump){setPage(jump.dataset.jump);return}
    const view=e.target.closest('[data-view]'); if(view){requestView(view.dataset.view);return}
    const mobile=e.target.closest('[data-mobile-step]'); if(mobile){setMobileStep(mobile.dataset.mobileStep);return}
    const inspector=e.target.closest('[data-inspector-tab]'); if(inspector){state.inspector=inspector.dataset.inspectorTab; $$('[data-inspector-tab]').forEach(b=>b.classList.toggle('is-active',b===inspector)); $$('[data-inspector-panel]').forEach(p=>p.classList.toggle('is-active',p.dataset.inspectorPanel===state.inspector));return}
    const definition=e.target.closest('[data-definition]'); if(definition){state.definition=definition.dataset.definition; $$('[data-definition]').forEach(b=>b.classList.toggle('is-active',b===definition));renderDefinitions();return}
    if(e.target.closest('.modal-close')) e.target.closest('.modal-backdrop').classList.remove('is-open');
    if(!e.target.closest('#new-menu')&&!e.target.closest('#new-button')) $('#new-menu').classList.remove('is-open');
  });
  $('#new-button').addEventListener('click',()=>$('#new-menu').classList.toggle('is-open'));
  $('#new-menu').addEventListener('click',e=>{const c=e.target.closest('[data-create]');if(c){toast(`已创建${c.dataset.create}草稿`);$('#new-menu').classList.remove('is-open')}});
  $('.collapse-detail').addEventListener('click',()=>{$('.inspector-panel').classList.toggle('is-collapsed');toast($('.inspector-panel').classList.contains('is-collapsed')?'已折叠详情':'已展开详情')});
  $('#adopt-button').addEventListener('click',()=>$('#adopt-modal').classList.add('is-open')); $('#confirm-adoption').addEventListener('click',adoptIdea);
  $('#mystery-preview').addEventListener('click',toggleMystery);
  $('#idea-search').addEventListener('input',e=>$('.idea-list').classList.toggle('is-empty',e.target.value.trim().length>0)); $('#clear-idea-search').addEventListener('click',()=>{$('#idea-search').value='';$('.idea-list').classList.remove('is-empty')});
  $('#outline-editor').addEventListener('input',()=>{state.dirty=true;$('.save-state').innerHTML='<i class="status-dot"></i>未保存'}); $('#save-outline').addEventListener('click',()=>{const s=$('.save-state');s.innerHTML='<i class="status-dot"></i>保存中';setTimeout(()=>{state.dirty=false;s.innerHTML='<i class="status-dot saved"></i>已保存';toast('自由大纲已保存')},500)});
  $('#discard-change').addEventListener('click',()=>{state.dirty=false;$('#unsaved-modal').classList.remove('is-open');setView(state.pendingView)}); $('#save-and-switch').addEventListener('click',()=>{state.dirty=false;$('#unsaved-modal').classList.remove('is-open');$('.save-state').innerHTML='<i class="status-dot saved"></i>已保存';setView(state.pendingView);toast('修改已保存')});
  $('#rerun-validation').addEventListener('click',e=>{e.currentTarget.textContent='校验中…';setTimeout(()=>{e.currentTarget.textContent='重新校验';toast('校验完成：3 项需要处理')},650)});
  $('#drawer-button').addEventListener('click',()=>{const p=$(`[data-page-panel="${state.page}"] [data-mobile-panel="list"]`);p.classList.toggle('is-drawer');$('#drawer-scrim').classList.toggle('is-open')}); $('#drawer-scrim').addEventListener('click',()=>{$('.is-drawer')?.classList.remove('is-drawer');$('#drawer-scrim').classList.remove('is-open')});
  $('#global-search').addEventListener('keydown',e=>{if(e.key==='Enter'){toast(e.target.value?`正在筛选“${e.target.value}”`:'请输入搜索内容')}});
  renderDefinitions(); setMobileStep('canvas');
})();
