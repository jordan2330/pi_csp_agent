const WS='/home/guoj01/agents/pi_csp_agent_v3';const ExcelJS=require('exceljs');
(async()=>{const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(WS+'/output/CSP_Leads_Report.xlsx');
const ws=wb.getWorksheet('全部商机');const h=ws.getRow(1).values;const c=k=>h.indexOf(k);
const combo={};ws.eachRow((r,n)=>{if(n<2)return;const b=String(r.getCell(c('分类依据')).value||'-');const s=String(r.getCell(c('证据来源')).value||'(空)');combo[b+' ‖ '+s]=(combo[b+' ‖ '+s]||0)+1;});
Object.entries(combo).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log('  '+String(v).padStart(4)+'  '+k));})();
