const WS='/home/guoj01/agents/pi_csp_agent_v3';
const cde=require(WS+'/config/cde_class_cache.json').products;
console.log('=== 相关缓存条目 ===');
['沙丁胺醇','左沙丁胺醇','异丙托溴铵','左沙丁胺醇异丙托溴铵','左旋沙丁胺醇异丙托溴铵'].forEach(k=>{
  const v=cde[k];
  console.log('  '+k.padEnd(22)+(v?('facts='+JSON.stringify(v.facts)):'(无此条目)'));
  if(v) (v.evidence||[]).slice(0,4).forEach(e=>console.log('       · '+e.text.slice(0,100)));
});
console.log();
const {buildLeadModel}=require(WS+'/scripts/lib/report');
const config=require(WS+'/scenarios/nitrosamine/scenario.json');const hooks=require(WS+'/scenarios/nitrosamine/enrich.js');
const snap=JSON.parse(require('fs').readFileSync(WS+'/output/runs/2026-09-28.json','utf8'));
const ctx=buildLeadModel(snap,{config,hooks},false);
console.log('=== 试验 CTR20263576 的各 API 子行（合并前的原始判定）===');
Object.values(ctx.enrichedApis).forEach(a=>[...a.trials,...(a.historyTrials||[])].forEach(t=>{
  if(t.regNo==='CTR20263576') console.log('  API '+String(a.name_cn||a.name_en).padEnd(14)+'分类='+String(t.drugClassification).padEnd(11)+'依据='+String(t.classBasis).padEnd(14)+'证据来源='+String(t.nmpa?t.nmpa.source:'-').padEnd(16)+'注册='+String(t.nmpa&&t.nmpa.regClass||'-').padEnd(4)+'generic='+(t.nmpa?t.nmpa.generic:'-')+' improved='+(t.nmpa?t.nmpa.improved:'-'));
}));
