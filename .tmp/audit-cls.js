const WS='/home/guoj01/agents/pi_csp_agent_v3';
const ExcelJS=require('exceljs');
(async()=>{
const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(WS+'/output/CSP_Leads_Report.xlsx');
const ws=wb.getWorksheet('全部商机');const h=ws.getRow(1).values;const c=k=>h.indexOf(k);
console.log('=== 该产品的所有行 ===');
ws.eachRow((r,n)=>{if(n<2)return;const nm=String(r.getCell(c('产品名称')).value||'');
  if(/左沙丁胺醇异丙托溴铵|异丙托溴铵/.test(nm))
    console.log('  '+nm.slice(0,26).padEnd(28)+'| '+String(r.getCell(c('主要API(中文)')).value).padEnd(10)+'| 分类='+String(r.getCell(c('药物分类')).value).padEnd(11)+'| 注册='+String(r.getCell(c('注册分类')).value||'-').padEnd(4)+'| '+String(r.getCell(c('分类依据')).value).padEnd(14)+'| '+String(r.getCell(c('证据来源')).value||'-'));});
console.log();
console.log('=== 全表一致性审计：注册分类 vs 药物分类（仅看有官方证据的行）===');
const bad={},ex={};
ws.eachRow((r,n)=>{if(n<2)return;
  const basis=String(r.getCell(c('分类依据')).value||'');
  const reg=String(r.getCell(c('注册分类')).value||'').trim();
  const cls=String(r.getCell(c('药物分类')).value||'');
  if(!basis.startsWith('官方证据')||!reg)return;
  let expect=null;
  if(/^1$/.test(reg))expect='新药';
  else if(/^2(\.\d)?$/.test(reg))expect='新药（改良型）';
  else if(/^(3|4)$/.test(reg)||/^5\.2$/.test(reg)||/^3\.3$/.test(reg))expect='仿制药';
  else if(/^5\.1$/.test(reg))expect='原研药';
  if(expect&&cls!==expect){const k='注册'+reg+' 应为 '+expect+' 实为 '+cls;bad[k]=(bad[k]||0)+1;(ex[k]=ex[k]||[]).length<2&&ex[k].push(String(r.getCell(c('产品名称')).value).slice(0,20));}
});
Object.entries(bad).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log('  '+String(v).padStart(4)+'  '+k+'   例: '+ex[k].join(' / ')));
})();
