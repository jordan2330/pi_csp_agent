const WS='/home/guoj01/agents/pi_csp_agent_v3';
const {generateWorkbook}=require(WS+'/scripts/lib/report-xlsx');
const config=require(WS+'/scenarios/nitrosamine/scenario.json');const hooks=require(WS+'/scenarios/nitrosamine/enrich.js');
const snap=JSON.parse(require('fs').readFileSync(WS+'/output/runs/2026-09-28.json','utf8'));
generateWorkbook(snap,{config,hooks},false,{run:'2026-09-28 17:38',date:'2026-09-28',new_records:6})
  .then(r=>console.log('  累积 '+r.rows+' 行 | ★ '+r.newRows+' | 自检矛盾 '+r.violations));
